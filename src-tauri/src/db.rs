use rusqlite::{Connection, params};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub mod history;

use crate::linker::LinkMention;

pub const DB_FILENAME: &str = "prism_vault.db";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct BacklinkInfo {
    pub source_path: String,
    pub source_title: String,
    /// 1-based start line of the matched mention in the source note.
    pub start_line: i64,
    /// 1-based end line of the matched mention in the source note.
    pub end_line: i64,
    pub matched_text: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeMeta {
    pub id: String,
    pub title: String,
    pub exists: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkMeta {
    pub source: String,
    pub target: String,
}

/// Lightweight, content-free snapshot of the knowledge graph, served from
/// SQLite so the force-graph never needs the full vault contents in React.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphPayload {
    pub nodes: Vec<GraphNodeMeta>,
    pub links: Vec<GraphLinkMeta>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SemanticMatch {
    pub note_id: String,
    pub score: f32,
    /// The candidate block that best matched the active note's query units —
    /// i.e. *why* the note was suggested (None when the candidate has no
    /// block-level embeddings to point at).
    pub matched_text: Option<String>,
    pub matched_block_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct BlockEmbedding {
    pub note_id: String,
    pub block_id: String,
    pub text: String,
    pub score: f32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DeniedLink {
    pub kind: String,
    pub target: String,
    pub matched_text: Option<String>,
}

/// Legacy wrapper kept for LinkerEngine compatibility.
/// Opens a connection at an explicit path and ensures the schema exists.
pub struct Database {
    pub conn: Connection,
}

impl Database {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        if let Some(parent) = path.as_ref().parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }

        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        init_schema(&conn)?;
        Ok(Database { conn })
    }

    pub fn get_links_for_note(&self, source: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT target FROM links WHERE source = ?")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([source], |row| row.get(0)).map_err(|e| e.to_string())?;

        let mut links = Vec::new();
        for link in rows {
            links.push(link.map_err(|e| e.to_string())?);
        }
        Ok(links)
    }

    pub fn get_note_title(&self, id: &str) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT title FROM notes WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map([id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn update_links(&mut self, source: &str, targets: &[String]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;

        tx.execute("DELETE FROM links WHERE source = ?", [source])
            .map_err(|e| e.to_string())?;

        for target in targets {
            tx.execute("INSERT INTO links (source, target) VALUES (?, ?)", [source, target])
                .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())
    }
}

/// Resolves the canonical database path inside the app data directory.
pub fn db_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir.join(DB_FILENAME))
}

/// Initializes (or connects to) `prism_vault.db` in the app data directory.
pub fn init_db(app_handle: &AppHandle) -> Result<Connection, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let conn = Connection::open(data_dir.join(DB_FILENAME)).map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Migrates `backlinks` to the current block-aware layout:
///  - The oldest layout (keyed by `source_id`) is dropped and recreated.
///  - Layouts keyed by `target_id` are renamed in place to `target_path` and
///    gain the nullable `target_block_id` column (for block anchors).
/// Edges are repopulated on the next full index, so no data is worth
/// preserving in the legacy `source_id` case.
fn migrate_backlinks(conn: &Connection) -> Result<(), String> {
    // 1. Truly legacy layout: keyed by source_id -> drop, recreate fresh.
    {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('backlinks') WHERE name = 'source_id'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        if rows.filter_map(Result::ok).next().is_some() {
            conn.execute_batch("DROP TABLE IF EXISTS backlinks;")
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    // 2. Current deployed layout: keyed by target_id -> rename + add column.
    {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('backlinks') WHERE name = 'target_id'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        if rows.filter_map(Result::ok).next().is_some() {
            conn.execute_batch(
                "ALTER TABLE backlinks RENAME COLUMN target_id TO target_path;
                 ALTER TABLE backlinks ADD COLUMN target_block_id TEXT;",
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    migrate_backlinks(conn)?;

    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            path TEXT NOT NULL,
            updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS aliases (
            alias TEXT NOT NULL,
            note_id TEXT NOT NULL,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_aliases_note ON aliases(note_id);

        CREATE TABLE IF NOT EXISTS backlinks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            target_block_id TEXT,
            start_line INTEGER NOT NULL DEFAULT 1,
            end_line INTEGER NOT NULL DEFAULT 1,
            matched_text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_path);
        CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks(source_path);

        -- Retained for legacy LinkerEngine compatibility
        CREATE TABLE IF NOT EXISTS links (
            source TEXT,
            target TEXT,
            PRIMARY KEY (source, target)
        );

        -- Dismissed link suggestions (persisted per note, per kind/target)
        CREATE TABLE IF NOT EXISTS denied_links (
            note_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            target TEXT NOT NULL,
            matched_text TEXT,
            PRIMARY KEY (note_path, kind, target, matched_text)
        );

        -- Semantic embeddings for the local vector search engine
        CREATE TABLE IF NOT EXISTS embeddings (
            note_id TEXT PRIMARY KEY,
            vector BLOB NOT NULL,
            updated_at INTEGER,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        -- Block-level embeddings (paragraph/section chunks) for precise,
        -- specific-part semantic suggestions
        CREATE TABLE IF NOT EXISTS block_embeddings (
            note_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            text TEXT NOT NULL,
            vector BLOB NOT NULL,
            updated_at INTEGER,
            PRIMARY KEY (note_id, block_id),
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_block_embeddings_note ON block_embeddings(note_id);

        -- @keyword topic tags: any mention of an @tag in a note groups it
        -- into that topic. Synced on every save/rename via `sync_note_tags`.
        CREATE TABLE IF NOT EXISTS tags (
            note_id TEXT NOT NULL,
            tag_name TEXT NOT NULL,
            PRIMARY KEY (note_id, tag_name),
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(tag_name);

        -- Version history base and deltas for version control
        CREATE TABLE IF NOT EXISTS note_history_base (
            note_path TEXT PRIMARY KEY,
            original_content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS note_history_deltas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,
            delta_patch TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (note_path) REFERENCES note_history_base(note_path) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_note_history_deltas_path ON note_history_deltas(note_path);
        CREATE INDEX IF NOT EXISTS idx_note_history_deltas_path_id ON note_history_deltas(note_path, id ASC);
        "#,
    )
    .map_err(|e| e.to_string())
}

/// Replaces the topic-tag rows for `note_id` from its content. Every `@tag`
/// mention (same pattern the editor renders as a topic pill) groups the note
/// into that topic. Called on every save/rename so groups stay live.
///
/// Boundary rule: the `@` must not be glued to a preceding word character —
/// `text@topic` is an email-ish token, not a tag; `text @topic` is a tag.
pub fn sync_note_tags(conn: &Connection, note_id: &str, content: &str) -> Result<(), String> {
    conn.execute("DELETE FROM tags WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;

    let re = regex::Regex::new(r"@([A-Za-z][\w-]*)").map_err(|e| e.to_string())?;
    let mut seen: Vec<String> = Vec::new();
    for cap in re.captures_iter(content) {
        let m = cap.get(0).expect("whole match");
        let preceded_by_word_char = content[..m.start()]
            .chars()
            .next_back()
            .map(|c| c.is_alphanumeric() || c == '_')
            .unwrap_or(false);
        if preceded_by_word_char {
            continue;
        }
        let tag = cap[1].to_string();
        if !seen.contains(&tag) {
            seen.push(tag.clone());
            conn.execute(
                "INSERT OR IGNORE INTO tags (note_id, tag_name) VALUES (?1, ?2)",
                params![note_id, tag],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// All topic groups: `(tag_name, [(note_id, title)])`, sorted by tag then
/// title, ready for the Topics tab.
pub fn get_topic_groups(
    conn: &Connection,
) -> Result<Vec<(String, Vec<(String, String)>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.tag_name, t.note_id, n.title
             FROM tags t JOIN notes n ON n.id = t.note_id
             ORDER BY t.tag_name COLLATE NOCASE, n.title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let mut groups: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let tag: String = row.get(0).map_err(|e| e.to_string())?;
        let note_id: String = row.get(1).map_err(|e| e.to_string())?;
        let title: String = row.get(2).map_err(|e| e.to_string())?;
        match groups.last_mut() {
            Some((t, list)) if *t == tag => list.push((note_id, title)),
            _ => groups.push((tag, vec![(note_id, title)])),
        }
    }
    Ok(groups)
}

/// Returns all (id, title) and (note_id, alias) pairs for the NoteLinker.
///
/// Note: tuples are ordered as (id, text) so they can be passed directly to
/// `NoteLinker::new()`, which expects the note id as the first element.
pub fn get_vault_dictionary(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut dictionary = Vec::new();

    {
        let mut stmt = conn
            .prepare("SELECT id, title FROM notes WHERE title IS NOT NULL AND title != ''")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                Ok((id, title))
            })
            .map_err(|e| e.to_string())?;
        for item in rows {
            dictionary.push(item.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare("SELECT note_id, alias FROM aliases WHERE alias IS NOT NULL AND alias != ''")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let note_id: String = row.get(0)?;
                let alias: String = row.get(1)?;
                Ok((note_id, alias))
            })
            .map_err(|e| e.to_string())?;
        for item in rows {
            dictionary.push(item.map_err(|e| e.to_string())?);
        }
    }

    Ok(dictionary)
}

/// Inserts or updates a note and its aliases in a single transaction.
pub fn upsert_note(
    conn: &Connection,
    id: &str,
    title: &str,
    path: &str,
    aliases: &[String],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO notes (id, title, path, updated_at) VALUES (?1, ?2, ?3, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            path = excluded.path,
            updated_at = excluded.updated_at",
        params![id, title, path],
    )
    .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM aliases WHERE note_id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    for alias in aliases {
        let alias = alias.trim();
        if alias.is_empty() {
            continue;
        }
        tx.execute(
            "INSERT INTO aliases (alias, note_id) VALUES (?1, ?2)",
            params![alias, id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

/// Re-points every path-keyed row whose id/path starts with `old_prefix` to
/// `new_prefix` (used when a folder is renamed on disk). Runs inside a
/// transaction with FK enforcement off, mirroring the single-file rename in
/// the watcher: notes, aliases, backlinks, applied links, embeddings, block
/// embeddings, tags, denied links and version history all follow the move so
/// semantic/block suggestions and history survive a folder rename.
pub fn rename_folder_paths(
    conn: &Connection,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("PRAGMA foreign_keys = OFF").map_err(|e| e.to_string())?;

    // Prefix-match without LIKE (paths can contain `%`/`_`).
    let re_point = |tx: &rusqlite::Transaction, table: &str, col: &str| -> Result<(), String> {
        tx.execute(
            &format!(
                "UPDATE {table} SET {col} = REPLACE({col}, ?1, ?2) \
                 WHERE substr({col}, 1, length(?1)) = ?1"
            ),
            params![old_prefix, new_prefix],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    };

    re_point(&tx, "notes", "id")?;
    re_point(&tx, "notes", "path")?;
    re_point(&tx, "aliases", "note_id")?;
    re_point(&tx, "backlinks", "source_path")?;
    re_point(&tx, "backlinks", "target_path")?;
    // `links.source` is a path; `links.target` is a raw title (only re-point
    // it when it happens to carry a path, mirroring the watcher's rename).
    re_point(&tx, "links", "source")?;
    re_point(&tx, "links", "target")?;
    re_point(&tx, "embeddings", "note_id")?;
    re_point(&tx, "block_embeddings", "note_id")?;
    re_point(&tx, "tags", "note_id")?;
    re_point(&tx, "denied_links", "note_path")?;
    re_point(&tx, "note_history_base", "note_path")?;
    re_point(&tx, "note_history_deltas", "note_path")?;

    tx.execute_batch("PRAGMA foreign_keys = ON").map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Removes every index entry whose path no longer exists on disk.
///
/// `index_vault` upserts only the files it finds, so without this purge a
/// deleted note would leave "ghost" rows behind (the app-side `delete_file`
/// masks its own remove event, so the watcher's `handle_remove` never runs
/// for it). Ghosts would then surface in the graph, the backlink panel and
/// the mention dictionary. Embeddings/block embeddings are cleaned up by
/// their `ON DELETE CASCADE` when the `notes` row goes.
pub fn purge_stale_notes(conn: &Connection, existing: &HashSet<String>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    {
        let mut stmt = tx
            .prepare("DELETE FROM notes WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = {
            let mut q = tx
                .prepare("SELECT id FROM notes")
                .map_err(|e| e.to_string())?;
            let rows = q.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };
        for id in ids {
            if !existing.contains(&id) {
                stmt.execute(params![id]).map_err(|e| e.to_string())?;
            }
        }
    }

    {
        let mut stmt = tx
            .prepare("DELETE FROM backlinks WHERE source_path = ?1 OR target_path = ?1")
            .map_err(|e| e.to_string())?;
        let paths: Vec<String> = {
            let mut q = tx
                .prepare(
                    "SELECT DISTINCT source_path FROM backlinks \
                     UNION SELECT DISTINCT target_path FROM backlinks",
                )
                .map_err(|e| e.to_string())?;
            let rows = q.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };
        for p in paths {
            if !existing.contains(&p) {
                stmt.execute(params![p]).map_err(|e| e.to_string())?;
            }
        }
    }

    {
        // `links.target` stores a raw title (not a path) — uncreated notes are
        // legitimately represented as non-existent nodes, so only purge edges
        // whose SOURCE note is gone.
        let mut stmt = tx
            .prepare("DELETE FROM links WHERE source = ?1")
            .map_err(|e| e.to_string())?;
        let sources: Vec<String> = {
            let mut q = tx
                .prepare("SELECT DISTINCT source FROM links")
                .map_err(|e| e.to_string())?;
            let rows = q.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };
        for s in sources {
            if !existing.contains(&s) {
                stmt.execute(params![s]).map_err(|e| e.to_string())?;
            }
        }
    }

    {
        let mut stmt = tx
            .prepare("DELETE FROM denied_links WHERE note_path = ?1")
            .map_err(|e| e.to_string())?;
        let note_paths: Vec<String> = {
            let mut q = tx
                .prepare("SELECT DISTINCT note_path FROM denied_links")
                .map_err(|e| e.to_string())?;
            let rows = q.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };
        for p in note_paths {
            if !existing.contains(&p) {
                stmt.execute(params![p]).map_err(|e| e.to_string())?;
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())
}

/// Per-source/target backlink row cap and per-note total cap. A multi-MB note
/// can mention the same title hundreds of times; the LinkHub only surfaces a
/// handful of occurrences per target, so capping keeps the backlinks table (and
/// the inserts below) bounded instead of exploding with thousands of rows.
const MAX_BACKLINKS_PER_TARGET: usize = 5;
const MAX_BACKLINKS_PER_NOTE: usize = 500;

/// Byte offsets of every `\n` in `content` (used for O(log n) line lookups).
fn build_line_starts(content: &str) -> Vec<usize> {
    content
        .bytes()
        .enumerate()
        .filter(|&(_, b)| b == b'\n')
        .map(|(i, _)| i)
        .collect()
}

/// 1-based line number for a byte offset, via binary search over the newline
/// offsets. (The old `offset_to_line` rescanned the prefix per mention —
/// O(n) per mention, i.e. quadratic on multi-MB notes.)
fn line_number(line_starts: &[usize], offset: usize) -> i64 {
    let idx = line_starts.partition_point(|&p| p < offset);
    idx as i64 + 1
}

/// Clears old backlinks for `source_path` and inserts newly discovered matches
/// in a single atomic transaction. Self-links (source == target) are always
/// excluded. Each mention stores its source line range so backlinks support
/// block-level navigation.
pub fn update_backlinks(
    conn: &Connection,
    source_path: &str,
    mentions: &[LinkMention],
    content: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM backlinks WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| e.to_string())?;

    // Precompute newline offsets once; every mention then resolves its line via
    // binary search instead of rescaming the note prefix.
    let line_starts = build_line_starts(content);
    let mut per_target: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut total = 0usize;

    for mention in mentions {
        if mention.target_note_id == source_path {
            continue;
        }
        if total >= MAX_BACKLINKS_PER_NOTE {
            break;
        }
        let count = per_target.entry(mention.target_note_id.as_str()).or_insert(0);
        if *count >= MAX_BACKLINKS_PER_TARGET {
            continue;
        }
        *count += 1;
        total += 1;
        let start_line = line_number(&line_starts, mention.start);
        let end_line = line_number(&line_starts, mention.end);
        tx.execute(
            "INSERT INTO backlinks (source_path, target_path, target_block_id, start_line, end_line, matched_text)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
            params![
                source_path,
                mention.target_note_id,
                start_line,
                end_line,
                mention.matched_text,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

/// Returns all notes that link to `target_path`, joined with their titles and
/// the line range of each matched mention (for block-level navigation).
pub fn get_incoming_backlinks(
    conn: &Connection,
    target_path: &str,
) -> Result<Vec<BacklinkInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.source_path,
                    COALESCE(n.title, b.source_path) AS source_title,
                    b.start_line,
                    b.end_line,
                    b.matched_text
             FROM backlinks b
             LEFT JOIN notes n ON n.id = b.source_path
             WHERE b.target_path = ?1
             ORDER BY source_title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![target_path], |row| {
            Ok(BacklinkInfo {
                source_path: row.get(0)?,
                source_title: row.get(1)?,
                start_line: row.get(2)?,
                end_line: row.get(3)?,
                matched_text: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut backlinks = Vec::new();
    for row in rows {
        backlinks.push(row.map_err(|e| e.to_string())?);
    }
    Ok(backlinks)
}

/// Backlinks + applied links for a single active note (lightweight IPC: only
/// the current note's graph edges, never the whole vault).
pub fn get_backlinks_for_note(
    conn: &Connection,
    note_path: &str,
) -> Result<Vec<BacklinkInfo>, String> {
    get_incoming_backlinks(conn, note_path)
}

/// Extracts the target titles of applied `[[wikilink]]`s from a note's body
/// (aliases and `#block` refs stripped), deduplicated. Used to keep the
/// content-free graph in sync during indexing.
pub fn extract_applied_links(content: &str) -> Vec<String> {
    let re = match regex::Regex::new(r"\[\[([^\[\]]+)\]\]") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for cap in re.captures_iter(content) {
        let raw = cap[1].trim();
        if raw.is_empty() {
            continue;
        }
        let target = raw
            .split('|')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if target.is_empty() {
            continue;
        }
        // Note titles are matched case-insensitively, so dedup that way too.
        let key = target.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        out.push(target);
    }
    out
}

/// Replaces the applied-link set for `source` in a single transaction.
/// `targets` are the raw target titles extracted from `[[wikilink]]`s.
pub fn update_links_flat(
    conn: &Connection,
    source: &str,
    targets: &[String],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM links WHERE source = ?1", params![source])
        .map_err(|e| e.to_string())?;

    for target in targets {
        tx.execute(
            "INSERT OR IGNORE INTO links (source, target) VALUES (?1, ?2)",
            params![source, target],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

/// Reads the knowledge graph (existing notes + applied-link edges) from SQLite.
/// Existing nodes come from `notes`; edges come from `links`, with both sides
/// resolved to display titles so the frontend needs no file contents.
pub fn get_graph(conn: &Connection) -> Result<GraphPayload, String> {
    // One read transaction: nodes and links must come from the same snapshot.
    // The frontend reloads the graph right after split/rename/ingest while a
    // full re-index is still mid-flight, and in WAL mode two separate reads
    // can observe different commits — a link row could reference a note whose
    // `notes` row the nodes query didn't see yet, which crashes d3-force with
    // "node not found: <id>". A single transaction pins both queries to one
    // consistent view.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let mut nodes = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, title FROM notes WHERE path != '' AND title != ''")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                Ok(GraphNodeMeta {
                    id: id.clone(),
                    title,
                    exists: true,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            nodes.push(row.map_err(|e| e.to_string())?);
        }
    }

    let mut links = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(n.title, l.source), COALESCE(m.title, l.target)
                 FROM links l
                 LEFT JOIN notes n ON n.id = l.source
                 LEFT JOIN notes m ON m.id = l.target
                 WHERE l.source != '' AND l.target != ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let source: String = row.get(0)?;
                let target: String = row.get(1)?;
                Ok(GraphLinkMeta { source, target })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            links.push(row.map_err(|e| e.to_string())?);
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(GraphPayload { nodes, links })
}

/// Permanently dismisses a link suggestion for a specific note.
pub fn add_denied_link(
    conn: &Connection,
    note_path: &str,
    kind: &str,
    target: &str,
    matched_text: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO denied_links (note_path, kind, target, matched_text)
         VALUES (?1, ?2, ?3, ?4)",
        params![note_path, kind, target, matched_text],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns every dismissed suggestion for a note.
pub fn get_denied_links(conn: &Connection, note_path: &str) -> Result<Vec<DeniedLink>, String> {
    let mut stmt = conn
        .prepare("SELECT kind, target, matched_text FROM denied_links WHERE note_path = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_path], |row| {
            Ok(DeniedLink {
                kind: row.get(0)?,
                target: row.get(1)?,
                matched_text: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut denied = Vec::new();
    for row in rows {
        denied.push(row.map_err(|e| e.to_string())?);
    }
    Ok(denied)
}

/// Removes denied/hidden entries whose underlying link no longer exists, so
/// the Denied/Hidden tabs never show ghosts (e.g. a backlink whose source
/// note was edited or formatted so the match vanished). Semantic dismissals
/// persist by design — dismissing a related note stays dismissed.
///
/// `content` is the active note's body: `None` (note missing/unreadable)
/// means every dismissal for it is stale. Keyword entries are kept only while
/// their matched text still occurs in the body; backlink/outbound/block
/// entries are cross-checked against the live tables.
pub fn prune_stale_denied_links(
    conn: &Connection,
    note_path: &str,
    content: Option<&str>,
) -> Result<(), String> {
    match content {
        Some(body) => {
            let mut stmt = conn
                .prepare(
                    "SELECT target, matched_text FROM denied_links
                     WHERE note_path = ?1 AND kind = 'keyword'",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![note_path], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            let stale: Vec<(String, Option<String>)> = rows
                .filter_map(|r| r.ok())
                .filter(|(_, matched_text)| {
                    !matched_text
                        .as_deref()
                        .map(|mt| body.contains(mt))
                        .unwrap_or(false)
                })
                .collect();
            for (target, matched_text) in stale {
                conn.execute(
                    "DELETE FROM denied_links
                     WHERE note_path = ?1 AND kind = 'keyword' AND target = ?2
                       AND (?3 IS NULL OR matched_text = ?3)",
                    params![note_path, target, matched_text],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        None => {
            conn.execute(
                "DELETE FROM denied_links WHERE note_path = ?1",
                params![note_path],
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    // backlink: the source note must still mention this note
    conn.execute(
        "DELETE FROM denied_links
         WHERE note_path = ?1 AND kind = 'backlink'
           AND NOT EXISTS (
             SELECT 1 FROM backlinks b
             WHERE b.source_path = denied_links.target AND b.target_path = ?1
           )",
        params![note_path],
    )
    .map_err(|e| e.to_string())?;

    // outbound: the applied link must still exist (target stored by title)
    conn.execute(
        "DELETE FROM denied_links
         WHERE note_path = ?1 AND kind = 'outbound'
           AND NOT EXISTS (
             SELECT 1 FROM links l JOIN notes n ON n.id = l.target
             WHERE l.source = ?1 AND lower(n.title) = lower(denied_links.target)
           )",
        params![note_path],
    )
    .map_err(|e| e.to_string())?;

    // block: the block must still exist in the target note
    conn.execute(
        "DELETE FROM denied_links
         WHERE note_path = ?1 AND kind = 'block'
           AND NOT EXISTS (
             SELECT 1 FROM block_embeddings be
             WHERE be.note_id = denied_links.target
               AND be.block_id = denied_links.matched_text
           )",
        params![note_path],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Un-hides a previously dismissed suggestion. When `kind` or `target` are
/// `None`, every matching row for the note is cleared (used when a link is
/// approved or manually removed so it can be suggested again).
pub fn remove_denied_link(
    conn: &Connection,
    note_path: &str,
    kind: Option<&str>,
    target: Option<&str>,
    matched_text: Option<&str>,
) -> Result<(), String> {
    match (kind, target) {
        (Some(kind), Some(target)) => {
            conn.execute(
                "DELETE FROM denied_links
                 WHERE note_path = ?1 AND kind = ?2 AND target = ?3
                   AND (?4 IS NULL OR matched_text = ?4)",
                params![note_path, kind, target, matched_text],
            )
            .map_err(|e| e.to_string())?;
        }
        (Some(kind), None) => {
            conn.execute(
                "DELETE FROM denied_links WHERE note_path = ?1 AND kind = ?2",
                params![note_path, kind],
            )
            .map_err(|e| e.to_string())?;
        }
        (None, Some(target)) => {
            conn.execute(
                "DELETE FROM denied_links WHERE note_path = ?1 AND target = ?2",
                params![note_path, target],
            )
            .map_err(|e| e.to_string())?;
        }
        (None, None) => {
            conn.execute(
                "DELETE FROM denied_links WHERE note_path = ?1",
                params![note_path],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Serializes an f32 vector to a little-endian byte blob.
fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Deserializes a little-endian byte blob back into an f32 vector.
fn blob_to_vector(blob: &[u8]) -> Result<Vec<f32>, String> {
    if blob.len() % 4 != 0 {
        return Err("Embedding blob has an invalid length.".to_string());
    }
    Ok(blob
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Stores (or replaces) the embedding vector for a note.
pub fn save_note_embedding(conn: &Connection, note_id: &str, vector: &[f32]) -> Result<(), String> {
    let blob = vector_to_blob(vector);
    conn.execute(
        "INSERT INTO embeddings (note_id, vector, updated_at) VALUES (?1, ?2, strftime('%s','now'))
         ON CONFLICT(note_id) DO UPDATE SET
            vector = excluded.vector,
            updated_at = excluded.updated_at",
        params![note_id, blob],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Retrieves the stored embedding for a single note, if any.
pub fn get_note_embedding(conn: &Connection, note_id: &str) -> Result<Option<Vec<f32>>, String> {
    let mut stmt = conn
        .prepare("SELECT vector FROM embeddings WHERE note_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![note_id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?;

    match rows.next() {
        Some(row) => {
            let blob = row.map_err(|e| e.to_string())?;
            Ok(Some(blob_to_vector(&blob)?))
        }
        None => Ok(None),
    }
}

/// Removes the stored embedding for a note. Used when a note's content becomes
/// empty (an empty string embeds to a meaningless token-average vector that
/// cosine-matches *anything*), so it can never be suggested as related again.
pub fn clear_note_embedding(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM embeddings WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes every stored note embedding. Used when the embedding model changes
/// dimension (e.g. a model swap) and all vectors must be regenerated.
pub fn clear_all_embeddings(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM embeddings", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes every stored block embedding (see `clear_all_embeddings`).
pub fn clear_all_block_embeddings(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM block_embeddings", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns up to `limit` block vectors for `note_id` (earliest blocks first,
/// in insertion order). Used as topical query units for related-note search: a
/// long note's whole-document embedding is truncated to its first ~512 tokens
/// and long documents converge toward the centroid, so its own blocks are a
/// far better representation of what the note is actually about.
pub fn get_note_block_vectors(
    conn: &Connection,
    note_id: &str,
    limit: usize,
) -> Result<Vec<Vec<f32>>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT vector FROM block_embeddings
             WHERE note_id = ?1 ORDER BY rowid LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id, limit as i64], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?;

    let mut vectors = Vec::new();
    for row in rows {
        vectors.push(blob_to_vector(&row.map_err(|e| e.to_string())?)?);
    }
    Ok(vectors)
}

/// Loads every (note_id, vector) pair stored in the database.
pub fn load_all_embeddings(conn: &Connection) -> Result<Vec<(String, Vec<f32>)>, String> {
    let mut stmt = conn
        .prepare("SELECT note_id, vector FROM embeddings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let note_id: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((note_id, blob))
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let (note_id, blob) = row.map_err(|e| e.to_string())?;
        entries.push((note_id, blob_to_vector(&blob)?));
    }
    Ok(entries)
}

/// Stores (or replaces) a single block embedding for a note.
pub fn save_block_embedding(
    conn: &Connection,
    note_id: &str,
    block_id: &str,
    text: &str,
    vector: &[f32],
) -> Result<(), String> {
    let blob = vector_to_blob(vector);
    conn.execute(
        "INSERT INTO block_embeddings (note_id, block_id, text, vector, updated_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))
         ON CONFLICT(note_id, block_id) DO UPDATE SET
            text = excluded.text,
            vector = excluded.vector,
            updated_at = excluded.updated_at",
        params![note_id, block_id, text, blob],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes every block embedding row for a note (used before re-embedding).
pub fn clear_block_embeddings(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM block_embeddings WHERE note_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Loads every block embedding as (note_id, block_id, text, vector).
pub fn load_all_block_embeddings(
    conn: &Connection,
) -> Result<Vec<(String, String, String, Vec<f32>)>, String> {
    let mut stmt = conn
        .prepare("SELECT note_id, block_id, text, vector FROM block_embeddings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let note_id: String = row.get(0)?;
            let block_id: String = row.get(1)?;
            let text: String = row.get(2)?;
            let blob: Vec<u8> = row.get(3)?;
            Ok((note_id, block_id, text, blob))
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let (note_id, block_id, text, blob) = row.map_err(|e| e.to_string())?;
        entries.push((note_id, block_id, text, blob_to_vector(&blob)?));
    }
    Ok(entries)
}

/// Loads every (block_id, text, vector) row for a single note. Used to reuse
/// embeddings for blocks whose content didn't change between saves, so a small
/// edit to a large note doesn't re-embed (and rewrite) all of its blocks.
pub fn load_block_embeddings_for_note(
    conn: &Connection,
    note_id: &str,
) -> Result<Vec<(String, String, Vec<f32>)>, String> {
    let mut stmt = conn
        .prepare("SELECT block_id, text, vector FROM block_embeddings WHERE note_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            let block_id: String = row.get(0)?;
            let text: String = row.get(1)?;
            let blob: Vec<u8> = row.get(2)?;
            Ok((block_id, text, blob))
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let (block_id, text, blob) = row.map_err(|e| e.to_string())?;
        entries.push((block_id, text, blob_to_vector(&blob)?));
    }
    Ok(entries)
}

/// Fetches block texts for a set of (note_id, block_id) pairs. Missing pairs
/// are simply absent from the returned map.
pub fn get_block_texts(
    conn: &Connection,
    pairs: &[(String, String)],
) -> Result<std::collections::HashMap<(String, String), String>, String> {
    let mut out = std::collections::HashMap::with_capacity(pairs.len());
    let mut stmt = conn
        .prepare("SELECT text FROM block_embeddings WHERE note_id = ?1 AND block_id = ?2")
        .map_err(|e| e.to_string())?;
    for (note_id, block_id) in pairs {
        let mut rows = stmt
            .query_map(params![note_id, block_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        if let Some(Ok(text)) = rows.next() {
            out.insert((note_id.clone(), block_id.clone()), text);
        }
    }
    Ok(out)
}

/// Exhaustive cosine-similarity scan over all stored embeddings.
/// Used as a correctness reference / fallback; the HNSW graph in
/// `engine::embeddings` provides the fast path for production queries.
pub fn get_semantic_related_notes(
    conn: &Connection,
    target_vector: &[f32],
    top_k: usize,
) -> Result<Vec<SemanticMatch>, String> {
    let all = load_all_embeddings(conn)?;

    let mut scored: Vec<(String, f32)> = all
        .iter()
        .map(|(note_id, vector)| {
            (
                note_id.clone(),
                crate::engine::embeddings::cosine_similarity(vector, target_vector),
            )
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);

    Ok(scored
        .into_iter()
        .map(|(note_id, score)| SemanticMatch {
            note_id,
            score,
            matched_text: None,
            matched_block_id: None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_dictionary() {
        let db = Database::open(":memory:").unwrap();
        db.conn
            .execute(
                "INSERT INTO notes (id, title, path, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params!["note_1", "Artificial Intelligence", "/path/ai.md", 12345678i64],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO aliases (alias, note_id) VALUES (?1, ?2)",
                params!["AI", "note_1"],
            )
            .unwrap();

        let dict = get_vault_dictionary(&db.conn).unwrap();
        assert_eq!(dict.len(), 2);
        assert!(dict.contains(&("note_1".to_string(), "Artificial Intelligence".to_string())));
        assert!(dict.contains(&("note_1".to_string(), "AI".to_string())));
    }

    #[test]
    fn test_upsert_note_replaces_aliases() {
        let db = Database::open(":memory:").unwrap();
        upsert_note(
            &db.conn,
            "n1",
            "Title",
            "/p.md",
            &["A".to_string(), "B".to_string()],
        )
        .unwrap();
        upsert_note(&db.conn, "n1", "Title2", "/p.md", &["C".to_string()]).unwrap();

        let dict = get_vault_dictionary(&db.conn).unwrap();
        assert!(dict.contains(&("n1".to_string(), "Title2".to_string())));
        assert!(dict.contains(&("n1".to_string(), "C".to_string())));
        assert!(!dict.contains(&("n1".to_string(), "A".to_string())));
        assert!(!dict.contains(&("n1".to_string(), "B".to_string())));
    }

    #[test]
    fn test_backlinks_exclude_self_links() {
        let db = Database::open(":memory:").unwrap();
        let mention = LinkMention {
            target_note_id: "note_1".to_string(),
            matched_text: "note_1".to_string(),
            start: 0,
            end: 6,
        };
        update_backlinks(&db.conn, "note_1", &[mention], "some body text").unwrap();

        let backlinks = get_incoming_backlinks(&db.conn, "note_1").unwrap();
        assert!(backlinks.is_empty());
    }

    #[test]
    fn test_incoming_backlinks_with_title() {
        let db = Database::open(":memory:").unwrap();
        upsert_note(&db.conn, "src", "Source Note", "/src.md", &[]).unwrap();
        upsert_note(&db.conn, "dst", "Target Note", "/dst.md", &[]).unwrap();

        let mention = LinkMention {
            target_note_id: "dst".to_string(),
            matched_text: "Target Note".to_string(),
            start: 10,
            end: 21,
        };
        update_backlinks(&db.conn, "src", &[mention], "line one\nline two\nline three").unwrap();

        let backlinks = get_incoming_backlinks(&db.conn, "dst").unwrap();
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "src");
        assert_eq!(backlinks[0].source_title, "Source Note");
        assert_eq!(backlinks[0].matched_text.as_deref(), Some("Target Note"));
        // Offset 10 is past the first newline => line 2; offset 21 => line 3.
        assert_eq!(backlinks[0].start_line, 2);
        assert_eq!(backlinks[0].end_line, 3);
    }

    #[test]
    fn test_extract_applied_links() {
        let content = "See [[Alpha]], [[Beta|alias]] and [[Gamma#^block-1]].\n[[alpha]] again.";
        let links = extract_applied_links(content);
        assert_eq!(links, vec!["Alpha".to_string(), "Beta".to_string(), "Gamma".to_string()]);
    }

    #[test]
    fn test_denied_links_scope_by_note() {
        let db = Database::open(":memory:").unwrap();
        add_denied_link(
            &db.conn,
            "/a.md",
            "keyword",
            "dst",
            Some("Target Note"),
        )
        .unwrap();
        add_denied_link(&db.conn, "/a.md", "semantic", "/b.md", None).unwrap();

        let for_a = get_denied_links(&db.conn, "/a.md").unwrap();
        assert_eq!(for_a.len(), 2);

        let for_b = get_denied_links(&db.conn, "/b.md").unwrap();
        assert!(for_b.is_empty());

        add_denied_link(
            &db.conn,
            "/a.md",
            "keyword",
            "dst",
            Some("Target Note"),
        )
        .unwrap();
        assert_eq!(get_denied_links(&db.conn, "/a.md").unwrap().len(), 2);
    }

    #[test]
    fn test_remove_denied_link() {
        let db = Database::open(":memory:").unwrap();
        add_denied_link(&db.conn, "/a.md", "keyword", "dst", Some("Target Note")).unwrap();
        add_denied_link(&db.conn, "/a.md", "semantic", "/b.md", None).unwrap();

        remove_denied_link(&db.conn, "/a.md", Some("keyword"), Some("dst"), None).unwrap();
        let denied = get_denied_links(&db.conn, "/a.md").unwrap();
        assert_eq!(denied.len(), 1);
        assert_eq!(denied[0].kind, "semantic");

        remove_denied_link(&db.conn, "/a.md", None, None, None).unwrap();
        assert!(get_denied_links(&db.conn, "/a.md").unwrap().is_empty());
    }

    #[test]
    fn test_load_block_embeddings_for_note_round_trip() {
        let db = Database::open(":memory:").unwrap();
        for path in ["/a.md", "/b.md"] {
            db.conn
                .execute(
                    "INSERT INTO notes (id, title, path, updated_at) VALUES (?1, ?2, ?3, 0)",
                    params![path, path, path],
                )
                .unwrap();
        }
        let vec = vec![0.1f32, 0.2, 0.3];
        save_block_embedding(&db.conn, "/a.md", "b1", "First block", &vec).unwrap();
        save_block_embedding(&db.conn, "/a.md", "b2", "Second block", &vec).unwrap();
        // Another note's rows must not leak into the per-note load.
        save_block_embedding(&db.conn, "/b.md", "b1", "Other", &vec).unwrap();

        let rows = load_block_embeddings_for_note(&db.conn, "/a.md").unwrap();
        assert_eq!(rows.len(), 2);
        let by_id: std::collections::HashMap<&str, (&str, &[f32])> = rows
            .iter()
            .map(|(id, text, v)| (id.as_str(), (text.as_str(), v.as_slice())))
            .collect();
        assert_eq!(by_id["b1"].0, "First block");
        assert_eq!(by_id["b2"].0, "Second block");
        assert_eq!(by_id["b1"].1, vec.as_slice());
    }
}

use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::linker::LinkMention;

pub const DB_FILENAME: &str = "cerebro_vault.db";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct BacklinkInfo {
    pub source_id: String,
    pub source_title: String,
    pub matched_text: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct SemanticMatch {
    pub note_id: String,
    pub score: f32,
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

/// Initializes (or connects to) `cerebro_vault.db` in the app data directory.
pub fn init_db(app_handle: &AppHandle) -> Result<Connection, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let conn = Connection::open(data_dir.join(DB_FILENAME)).map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

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
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            matched_text TEXT,
            PRIMARY KEY(source_id, target_id, matched_text)
        );
        CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_id);
        CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks(source_id);

        -- Retained for legacy LinkerEngine compatibility
        CREATE TABLE IF NOT EXISTS links (
            source TEXT,
            target TEXT,
            PRIMARY KEY (source, target)
        );

        -- Semantic embeddings for the local vector search engine
        CREATE TABLE IF NOT EXISTS embeddings (
            note_id TEXT PRIMARY KEY,
            vector BLOB NOT NULL,
            updated_at INTEGER,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        "#,
    )
    .map_err(|e| e.to_string())
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

/// Clears old backlinks for `source_id` and inserts newly discovered matches.
/// Self-links (source_id == target_id) are always excluded.
pub fn update_backlinks(
    conn: &Connection,
    source_id: &str,
    mentions: &[LinkMention],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM backlinks WHERE source_id = ?1", params![source_id])
        .map_err(|e| e.to_string())?;

    for mention in mentions {
        if mention.target_note_id == source_id {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO backlinks (source_id, target_id, matched_text)
             VALUES (?1, ?2, ?3)",
            params![source_id, mention.target_note_id, mention.matched_text],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

/// Returns all notes that link to `target_id`, joined with their titles.
pub fn get_incoming_backlinks(
    conn: &Connection,
    target_id: &str,
) -> Result<Vec<BacklinkInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.source_id,
                    COALESCE(n.title, b.source_id) AS source_title,
                    b.matched_text
             FROM backlinks b
             LEFT JOIN notes n ON n.id = b.source_id
             WHERE b.target_id = ?1
             ORDER BY source_title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![target_id], |row| {
            Ok(BacklinkInfo {
                source_id: row.get(0)?,
                source_title: row.get(1)?,
                matched_text: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut backlinks = Vec::new();
    for row in rows {
        backlinks.push(row.map_err(|e| e.to_string())?);
    }
    Ok(backlinks)
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
        .map(|(note_id, score)| SemanticMatch { note_id, score })
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
        update_backlinks(&db.conn, "note_1", &[mention]).unwrap();

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
        update_backlinks(&db.conn, "src", &[mention]).unwrap();

        let backlinks = get_incoming_backlinks(&db.conn, "dst").unwrap();
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_id, "src");
        assert_eq!(backlinks[0].source_title, "Source Note");
        assert_eq!(backlinks[0].matched_text.as_deref(), Some("Target Note"));
    }
}

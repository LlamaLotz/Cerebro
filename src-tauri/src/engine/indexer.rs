//! Bounded-concurrency vault indexing + self-write suppression mask.
//!
//! The full-vault scan runs in a small fixed worker pool (never fanning out
//! across every core) and streams files one worker at a time, so a large
//! vault is never buffered into memory wholesale and note contents never
//! cross the Tauri IPC boundary.
//!
//! Machine-generated writes (link footers, H1 syncs, rename rewrites) register
//! themselves in [`IGNORE_WRITES`]. The `notify` watcher drops those events
//! immediately instead of re-indexing in a loop, and each entry is cleared
//! after a short debounce window so genuine external edits are never missed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use walkdir::WalkDir;

use crate::db;
use crate::linker::NoteLinker;

/// Maximum number of files indexed concurrently. Kept small: every worker owns
/// its own SQLite connection and holds its current file in memory, so more
/// than ~4 workers mostly saturates the disk and bloats memory on big vaults.
pub const MAX_INDEX_WORKERS: usize = 4;

/// How long an app-initiated write stays masked from the watcher.
pub const SELF_WRITE_MASK_MS: u64 = 600;

/// Thread-safe set of paths the app itself is about to (or just did) write.
/// The watcher drops events for these paths; entries are cleared by
/// [`suppress_self_write`] after [`SELF_WRITE_MASK_MS`].
static IGNORE_WRITES: OnceLock<Arc<RwLock<HashSet<PathBuf>>>> = OnceLock::new();

fn ignore_set() -> &'static Arc<RwLock<HashSet<PathBuf>>> {
    IGNORE_WRITES.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

/// Paths queued for un-masking, each with the deadline it becomes eligible.
/// A single sweeper thread drains them, so bulk operations (H1 syncs, note
/// splits) never spawn one thread per write (which piled up hundreds of
/// sleeping threads — and gigabytes of stack — on multi-file operations).
static PENDING_CLEARS: OnceLock<Mutex<Vec<(PathBuf, Instant)>>> = OnceLock::new();
static SWEEPER_STARTED: OnceLock<()> = OnceLock::new();

fn pending_clears() -> &'static Mutex<Vec<(PathBuf, Instant)>> {
    PENDING_CLEARS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registers `path` as an app-initiated write so the watcher ignores it.
pub fn mark_self_write(path: &Path) {
    ignore_set().write().unwrap().insert(path.to_path_buf());
}

/// True when `path` is currently masked as an app-initiated write.
pub fn is_self_write(path: &Path) -> bool {
    ignore_set().read().unwrap().contains(path)
}

/// Un-masks `path` (called after the self-write debounce window elapses).
pub fn clear_self_write(path: &Path) {
    ignore_set().write().unwrap().remove(path);
}

/// Masks `path` and schedules its un-masking after `delay_ms`. The watcher
/// drops the burst of self-write events immediately; the delayed clear
/// re-arms watching for genuine external edits. Un-masking is handled by a
/// single shared sweeper thread (never one thread per write).
pub fn suppress_self_write(path: &Path, delay_ms: u64) {
    mark_self_write(path);
    let deadline = Instant::now() + Duration::from_millis(delay_ms);
    pending_clears().lock().unwrap().push((path.to_path_buf(), deadline));
    SWEEPER_STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(50));
            let mut pending = pending_clears().lock().unwrap();
            let now = Instant::now();
            pending.retain(|(path, deadline)| {
                if *deadline <= now {
                    clear_self_write(path);
                    false
                } else {
                    true
                }
            });
        });
        ()
    });
}

/// Metadata for an indexed note — deliberately *not* the note's content.
/// Content is fetched lazily (one file at a time) when a note is opened.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub title: String,
    pub updated_at: f64,
}

/// Result of a full vault index: the note metadata plus every folder under
/// the vault (POSIX-style relative paths, e.g. `Projects/Book`). Folders are
/// included even when they contain no notes, so the sidebar can render the
/// real folder structure — not just folders that happen to hold markdown.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexedVault {
    pub files: Vec<IndexedFile>,
    pub folders: Vec<String>,
}

/// True for paths the vault scan must skip: dot-prefixed segments (hidden
/// files/folders) and the extractor's sidecar folder `note metadata/` (which
/// is not a dot-folder, so it needs an explicit name match).
pub fn is_hidden(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.') || s.eq_ignore_ascii_case("note metadata")
    })
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("markdown")
    )
}

/// Streams the vault directory into a sorted list of markdown paths. Only the
/// paths are held — no file contents are buffered here.
fn collect_markdown_paths(vault_path: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(vault_path).into_iter().filter_map(Result::ok) {
        let path = entry.path().to_path_buf();
        if !path.is_file() || is_hidden(&path) || !is_markdown(&path) {
            continue;
        }
        paths.push(path);
    }
    paths.sort();
    paths
}

/// Streams the vault directory into a sorted list of POSIX-style relative
/// folder paths (e.g. `Projects/Book`). Every non-hidden directory under the
/// vault is included — including empty ones — so the sidebar can show the
/// real folder tree even when a folder has no notes yet.
fn collect_folder_paths(vault_path: &Path) -> Vec<String> {
    let mut folders: Vec<String> = Vec::new();
    for entry in WalkDir::new(vault_path).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() || is_hidden(path) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(vault_path) else {
            continue;
        };
        let rel = rel.to_string_lossy().to_string();
        if rel.is_empty() {
            continue; // the vault root itself
        }
        folders.push(rel.replace('\\', "/"));
    }
    folders.sort();
    folders
}

fn file_metadata(vault_path: &Path, path: &Path) -> Option<IndexedFile> {
    let relative_path = path
        .strip_prefix(vault_path)
        .ok()?
        .to_string_lossy()
        .to_string();
    let name = path.file_name()?.to_string_lossy().to_string();
    let title = path.file_stem()?.to_string_lossy().to_string();
    let updated_at = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);

    Some(IndexedFile {
        path: path.to_string_lossy().to_string(),
        relative_path,
        name,
        title,
        updated_at,
    })
}

/// Runs `work` over `paths` with at most [`MAX_INDEX_WORKERS`] concurrent
/// workers, back-pressuring the producer through a bounded channel so only a
/// handful of paths are ever in flight. Every worker owns a single SQLite
/// connection reused across all the files it processes.
fn run_pool_with_conn<F>(
    paths: &[PathBuf],
    app_handle: &tauri::AppHandle,
    work: F,
) where
    F: Fn(&rusqlite::Connection, &Path) + Send + Sync + 'static,
{
    if paths.is_empty() {
        return;
    }

    let (tx, rx) = std::sync::mpsc::sync_channel::<PathBuf>(MAX_INDEX_WORKERS);
    // std receivers are not Clone; a shared mutex lets every worker pull from
    // the same bounded queue (back-pressure still applies via the channel).
    let rx = Arc::new(Mutex::new(rx));
    let work = Arc::new(work);
    let workers = MAX_INDEX_WORKERS.min(paths.len());

    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let rx = rx.clone();
        let work = work.clone();
        let app_handle = app_handle.clone();
        handles.push(std::thread::spawn(move || {
            let Ok(conn) = db::init_db(&app_handle) else {
                return;
            };
            loop {
                let path = match rx.lock().unwrap().recv() {
                    Ok(path) => path,
                    Err(_) => break, // sender(s) dropped: no more work
                };
                work(&conn, &path);
            }
        }));
    }
    drop(rx); // drop our own Arc so workers own the only strong refs

    for path in paths {
        let _ = tx.send(path.clone());
    }
    drop(tx);

    for h in handles {
        let _ = h.join();
    }
}

/// Indexes every markdown file under `vault_path` with a bounded worker pool:
///  - Phase 1: upsert each note (+aliases) inside a single transaction.
///  - Phase 2: purge index rows for files that no longer exist on disk
///    (deleted notes would otherwise linger as "ghosts" in the graph, the
///    backlink panel and the mention dictionary).
///  - Phase 3: rescan each note for unlinked mentions and applied `[[wikilink]]`
///    targets, updating the backlink/link graph in batched transactions.
///
/// Note contents never leave the process; only lightweight metadata is
/// returned so the frontend can render the sidebar without an IPC flood.
pub fn index_vault(
    vault_path: &Path,
    app_handle: tauri::AppHandle,
) -> Result<IndexedVault, String> {
    let vault_root = vault_path.to_path_buf();
    let paths = collect_markdown_paths(&vault_root);
    let folders = collect_folder_paths(&vault_root);

    // ---- Phase 1: upsert notes + aliases (bounded pool, transactional) ----
    let results: Arc<Mutex<Vec<IndexedFile>>> = Arc::new(Mutex::new(Vec::new()));
    let existing: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    run_pool_with_conn(&paths, &app_handle, {
        let results = results.clone();
        let existing = existing.clone();
        let vault_root = vault_root.clone();
        move |conn, path| {
            let Ok(content) = std::fs::read_to_string(path) else {
                return;
            };
            let path_str = path.to_string_lossy().to_string();
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let aliases = crate::watcher::extract_aliases(&content);
            if db::upsert_note(conn, &path_str, &title, &path_str, &aliases).is_ok() {
                // Reconcile topic tags with disk on every full scan: renamed or
                // moved notes get a fresh id (path) here, and their tag rows
                // would otherwise point at the old id until the next write or
                // app restart (see `get_topic_groups` JOIN).
                let _ = db::sync_note_tags(conn, &path_str, &content);
                existing.lock().unwrap().insert(path_str.clone());
                if let Some(meta) = file_metadata(&vault_root, path) {
                    results.lock().unwrap().push(meta);
                }
            }
        }
    });

    // ---- Phase 2: purge index rows for notes missing from disk ----
    {
        let conn = db::init_db(&app_handle)?;
        let set = existing.lock().unwrap();
        db::purge_stale_notes(&conn, &set)?;
    }

    // ---- Phase 3: rebuild the link graph (bounded pool, batched writes) ----
    {
        let dictionary = db::init_db(&app_handle)
            .ok()
            .and_then(|conn| db::get_vault_dictionary(&conn).ok())
            .unwrap_or_default();
        let linker = Arc::new(NoteLinker::new(dictionary));

        run_pool_with_conn(&paths, &app_handle, {
            let linker = linker.clone();
            move |conn, path| {
                let Ok(content) = std::fs::read_to_string(path) else {
                    return;
                };
                let path_str = path.to_string_lossy().to_string();

                let mentions = linker.find_mentions(&content, Some(&path_str));
                if db::update_backlinks(conn, &path_str, &mentions, &content).is_err() {
                    return;
                }

                // Applied [[wikilinks]] drive the graph; store their target
                // titles so the D3 graph can be served from SQLite (zero-IPC).
                let targets = db::extract_applied_links(&content);
                let _ = db::update_links_flat(conn, &path_str, &targets);
            }
        });
    }

    let mut out = results.lock().unwrap();
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(IndexedVault {
        files: out.clone(),
        folders,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn empty_folders_are_collected() {
        // Temp vault with a nested folder that contains no markdown.
        let dir = std::env::temp_dir().join(format!("prism_idx_test_{}", std::process::id()));
        let root = dir.join("vault");
        std::fs::create_dir_all(root.join("Projects/Empty")).unwrap();
        std::fs::create_dir_all(root.join("Projects/Book")).unwrap();
        std::fs::write(root.join("note.md"), "# note").unwrap();
        std::fs::write(root.join("Projects/Book/ch1.md"), "# ch1").unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();

        let folders = collect_folder_paths(&root);
        assert!(folders.contains(&"Projects".to_string()));
        assert!(folders.contains(&"Projects/Empty".to_string()));
        assert!(folders.contains(&"Projects/Book".to_string()));
        // Hidden dirs are skipped.
        assert!(!folders.iter().any(|f| f.contains(".obsidian")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_and_metadata_paths_are_ignored() {
        // Dot-prefixed segments are skipped.
        assert!(is_hidden(Path::new("/vault/.obsidian/plugins/x.md")));
        assert!(is_hidden(Path::new("/vault/.hidden.md")));
        // The extractor's sidecar folder is skipped regardless of case.
        assert!(is_hidden(Path::new("/vault/Books/note metadata/foo.md.meta.json")));
        assert!(is_hidden(Path::new("/vault/note metadata/foo.md")));
        assert!(is_hidden(Path::new("/vault/Note Metadata/foo.md")));
        // Normal notes are not.
        assert!(!is_hidden(Path::new("/vault/Books/foo.md")));
        assert!(!is_hidden(Path::new("/vault/note.md")));
    }
}

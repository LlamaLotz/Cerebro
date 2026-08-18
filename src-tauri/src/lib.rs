use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Manager, Window, Emitter};
use rusqlite::params;

mod db;
mod engine;
pub mod linker;
mod watcher;

use linker::{LinkerEngine, NoteLinker, LinkMention};
use std::sync::{Arc, Mutex};

use crate::engine::embeddings::EmbeddingEngine;
use crate::engine::indexer::{suppress_self_write, SELF_WRITE_MASK_MS};

pub struct AppState {
    pub linker: Mutex<Option<LinkerEngine>>,
    pub db_path: Mutex<Option<String>>,
    pub watcher_path: Mutex<Option<String>>,
    /// Cached embedding-engine initialization result. Both success and failure
    /// are memoized so a broken model isn't re-initialized (and doesn't
    /// re-attempt network downloads) on every scan.
    pub embeddings: Mutex<Option<Result<Arc<EmbeddingEngine>, String>>>,
    /// Serializes all ONNX inference (backfill + per-save embeds). fastembed's
    /// onnxruntime fans out across every core per session, so two concurrent
    /// sessions double the all-core spike; this lock guarantees exactly one
    /// inference job at a time.
    pub embed_lock: Mutex<()>,
    /// Cached Aho-Corasick automaton (NoteLinker), rebuilt only when the vault
    /// dictionary changes instead of on every scan (per-keystroke-pause scans
    /// rebuild it today, which is pure CPU waste).
    pub linker_cache: Mutex<Option<(Vec<(String, String)>, Arc<NoteLinker>)>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Delta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl From<linker::differ::Delta> for Delta {
    fn from(d: linker::differ::Delta) -> Self {
        Delta {
            added: d.added,
            removed: d.removed,
        }
    }
}

#[tauri::command]
fn scan_unlinked_mentions(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    content: String,
    current_note_id: String,
    dictionary: Vec<(String, String)>,
) -> Vec<LinkMention> {
    let linker = cached_linker(&state, dictionary);
    let mentions = linker.find_mentions(&content, Some(&current_note_id));

    // Keep the backlink graph in sync with each scan
    if let Ok(conn) = db::init_db(&app_handle) {
        let _ = db::update_backlinks(&conn, &current_note_id, &mentions, &content);
        // Applied [[wikilinks]] drive the graph tab; resync them here too so
        // links removed from the note body never linger as ghost edges.
        let targets = db::extract_applied_links(&content);
        let _ = db::update_links_flat(&conn, &current_note_id, &targets);
    }

    mentions
}

#[tauri::command]
fn init_linker(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    patterns: Vec<String>
) -> Result<(), String> {
    // Ensure the canonical app-data database exists, then point the engine at it
    let conn = db::init_db(&app_handle)?;
    drop(conn);

    let path = db::db_path(&app_handle)?;
    let path_str = path.to_string_lossy().to_string();

    let engine = LinkerEngine::new(&path_str, patterns)?;
    let mut linker = state.linker.lock().unwrap();
    *linker = Some(engine);
    let mut path_guard = state.db_path.lock().unwrap();
    *path_guard = Some(path_str);
    Ok(())
}

#[tauri::command]
fn get_vault_dictionary(app_handle: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let conn = db::init_db(&app_handle)?;
    db::get_vault_dictionary(&conn)
}

#[tauri::command]
fn get_topic_groups(
    app_handle: tauri::AppHandle,
) -> Result<Vec<(String, Vec<(String, String)>)>, String> {
    let conn = db::init_db(&app_handle)?;
    db::get_topic_groups(&conn)
}

/// Model repo + files required by `fastembed` for `bge-base-en-v1.5`
/// (Qdrant int8-quantized build).
const EMBEDDING_REPO_DIR: &str = "models--Qdrant--bge-base-en-v1.5-onnx-Q";
const EMBEDDING_REQUIRED_FILES: [&str; 5] = [
    "config.json",
    "model_optimized.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
];

/// Verifies the local fastembed cache holds the full set of model files.
/// A cache dir without `refs/main` (never downloaded) passes so fastembed can
/// attempt the one-time download; a *started* download that left the snapshot
/// incomplete fails fast with a clear message instead of re-attempting a
/// broken fetch on every scan.
fn verify_model_cache(cache_dir: &std::path::Path) -> Result<(), String> {
    let repo_dir = cache_dir.join(EMBEDDING_REPO_DIR);
    if !repo_dir.exists() {
        return Ok(());
    }

    let refs_file = repo_dir.join("refs").join("main");
    let commit_hash = match std::fs::read_to_string(&refs_file) {
        Ok(h) => h.trim().to_string(),
        Err(_) => return Ok(()),
    };
    let snapshot_dir = repo_dir.join("snapshots").join(&commit_hash);

    let missing: Vec<&str> = EMBEDDING_REQUIRED_FILES
        .iter()
        .copied()
        .filter(|f| !snapshot_dir.join(f).exists())
        .collect();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Embedding model cache is incomplete (missing {} in {}). \
             Close the app, then run `cargo run --example check_model` from src-tauri \
             to repair the cache.",
            missing.join(", "),
            snapshot_dir.display()
        ))
    }
}

/// Lazily initializes the semantic embedding engine (model load + HNSW rebuild).
fn get_embedding_engine(
    state: &tauri::State<'_, AppState>,
    app_handle: &tauri::AppHandle,
) -> Result<Arc<EmbeddingEngine>, String> {
    let mut guard = state.embeddings.lock().unwrap();
    if let Some(result) = guard.as_ref() {
        return result.clone();
    }

    let conn = db::init_db(app_handle)?;
    let home = app_handle.path().home_dir().map_err(|e| e.to_string())?;
    let cache_dir = home.join(".cerebro").join("models");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let result = verify_model_cache(&cache_dir)
        .and_then(|_| {
            EmbeddingEngine::new(&conn, cache_dir).map_err(|e| {
                format!(
                    "{e} - the local embedding model could not be loaded; \
                     a one-time internet connection may be required to download it."
                )
            })
        })
        .map(Arc::new);

    *guard = Some(result.clone());
    result
}

/// Returns a `NoteLinker` for `dictionary`, reusing the cached Aho-Corasick
/// automaton when the dictionary is unchanged (building it is the expensive
/// part, and `scan_unlinked_mentions`/`write_file` run it on every save).
pub fn cached_linker(
    state: &AppState,
    dictionary: Vec<(String, String)>,
) -> Arc<NoteLinker> {
    let mut cache = state.linker_cache.lock().unwrap();
    if let Some((cached_dict, linker)) = cache.as_ref() {
        if *cached_dict == dictionary {
            return linker.clone();
        }
    }
    let linker = Arc::new(NoteLinker::new(dictionary.clone()));
    *cache = Some((dictionary, linker.clone()));
    linker
}

/// Holds the global ONNX-inference lock for the duration of an embedding job.
pub fn embed_guard(state: &AppState) -> std::sync::MutexGuard<'_, ()> {
    state.embed_lock.lock().unwrap()
}

/// Generates and stores a semantic embedding for a note (fire-and-forget on save).
#[tauri::command]
async fn generate_and_store_embedding(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    note_id: String,
    content: String,
) -> Result<(), String> {
    let _lock = embed_guard(&state);
    let engine = get_embedding_engine(&state, &app_handle)?;
    let conn = db::init_db(&app_handle)?;
    engine.generate_and_store(&conn, &note_id, &content)
}

/// Returns the top-K conceptually related notes for a note (HNSW vector search).
#[tauri::command]
async fn find_semantic_related_notes(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    note_id: String,
    top_k: usize,
) -> Result<Vec<db::SemanticMatch>, String> {
    let engine = get_embedding_engine(&state, &app_handle)?;
    let conn = db::init_db(&app_handle)?;
    engine.find_related(&conn, &note_id, top_k)
}

/// Generates and stores block-level embeddings for a note (fire-and-forget).
#[tauri::command]
async fn generate_and_store_block_embeddings(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    note_id: String,
    content: String,
) -> Result<(), String> {
    let _lock = embed_guard(&state);
    let engine = get_embedding_engine(&state, &app_handle)?;
    let conn = db::init_db(&app_handle)?;
    engine.generate_and_store_blocks(&conn, &note_id, &content)
}

/// Returns the top-K semantically matching blocks from other notes.
#[tauri::command]
async fn find_block_related_notes(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    note_id: String,
    top_k: usize,
) -> Result<Vec<db::BlockEmbedding>, String> {
    let engine = get_embedding_engine(&state, &app_handle)?;
    let conn = db::init_db(&app_handle)?;
    engine.find_block_matches(&conn, &note_id, top_k)
}

/// Embeds every note in the vault that does not yet have an embedding
/// (first-run backfill after indexing). Inference is batched so large vaults
/// finish quickly without blocking the Tauri command thread for too long.
///
/// Notes are processed in bounded chunks so a large vault's contents are
/// never all held in memory at once.
const BACKFILL_NOTE_CHUNK: usize = 64;

#[tauri::command]
async fn backfill_embeddings(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<usize, String> {
    let _lock = embed_guard(&state);
    let conn = db::init_db(&app_handle)?;

    // Topic tags must reflect note content regardless of embedding state:
    // re-extract @keyword mentions for every note so tags that no longer
    // meet the @tag boundary rule (e.g. emails like contact@yahoo.com) or
    // were removed by external edits never linger as ghost tags. Runs even
    // if the model below fails to load.
    {
        let mut stmt = conn
            .prepare("SELECT id, path FROM notes WHERE path != ''")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let path: String = row.get(1)?;
                Ok((id, path))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, path) = row.map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let _ = db::sync_note_tags(&conn, &id, &content);
        }
    }

    let engine = get_embedding_engine(&state, &app_handle)?;

    let mut total = 0usize;

    // Note-level backfill: notes with no whole-note embedding yet.
    {
        let mut stmt = conn
            .prepare(
                "SELECT n.id, n.path FROM notes n
                 LEFT JOIN embeddings e ON e.note_id = n.id
                 WHERE e.note_id IS NULL AND n.path != ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let path: String = row.get(1)?;
                Ok((id, path))
            })
            .map_err(|e| e.to_string())?;

        let mut pending: Vec<(String, String)> = Vec::with_capacity(BACKFILL_NOTE_CHUNK);
        for row in rows {
            let (id, path) = row.map_err(|e| e.to_string())?;
            // Skip oversized notes up front (metadata only) so multi-MB notes
            // never get read into memory or embedded (see MAX_EMBED_CHARS).
            let too_large = std::fs::metadata(&path)
                .map(|m| m.len() > crate::engine::embeddings::MAX_EMBED_CHARS as u64)
                .unwrap_or(false);
            if too_large {
                println!("[embeddings] skipping note backfill for oversized note: {path}");
                continue;
            }
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            if content.trim().is_empty() {
                continue;
            }
            pending.push((id, content));
            if pending.len() >= BACKFILL_NOTE_CHUNK {
                total += engine.backfill(&conn, std::mem::take(&mut pending))?;
            }
        }
        if !pending.is_empty() {
            total += engine.backfill(&conn, pending)?;
        }
    }

    // Block-level backfill: notes with no block embeddings yet, or notes whose
    // existing (pre-cap) block count exceeds the per-note cap — those get
    // re-split and re-embedded with the consolidated splitter.
    {
        let mut stmt = conn
            .prepare(
                "SELECT n.id, n.path FROM notes n
                 LEFT JOIN (
                    SELECT note_id, COUNT(*) AS cnt FROM block_embeddings GROUP BY note_id
                 ) b ON b.note_id = n.id
                 WHERE n.path != '' AND (b.note_id IS NULL OR b.cnt > ?1)",
            )
            .map_err(|e| e.to_string())?;
        let cap = crate::engine::embeddings::MAX_BLOCKS_PER_NOTE as i64;
        let rows = stmt
            .query_map([cap], |row| {
                let id: String = row.get(0)?;
                let path: String = row.get(1)?;
                Ok((id, path))
            })
            .map_err(|e| e.to_string())?;

        let mut pending_blocks: Vec<(String, String)> =
            Vec::with_capacity(BACKFILL_NOTE_CHUNK);
        for row in rows {
            let (id, path) = row.map_err(|e| e.to_string())?;
            let too_large = std::fs::metadata(&path)
                .map(|m| m.len() > crate::engine::embeddings::MAX_EMBED_CHARS as u64)
                .unwrap_or(false);
            if too_large {
                println!("[embeddings] skipping block backfill for oversized note: {path}");
                continue;
            }
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            if content.trim().is_empty() {
                continue;
            }
            pending_blocks.push((id, content));
            if pending_blocks.len() >= BACKFILL_NOTE_CHUNK {
                total += engine.backfill_blocks(&conn, std::mem::take(&mut pending_blocks))?;
            }
        }
        if !pending_blocks.is_empty() {
            total += engine.backfill_blocks(&conn, pending_blocks)?;
        }
    }

    Ok(total)
}

#[tauri::command]
fn index_note(
    app_handle: tauri::AppHandle,
    id: String,
    title: String,
    path: String,
    aliases: Vec<String>,
) -> Result<(), String> {
    let conn = db::init_db(&app_handle)?;
    db::upsert_note(&conn, &id, &title, &path, &aliases)
}

#[tauri::command]
fn get_incoming_backlinks(
    app_handle: tauri::AppHandle,
    target_id: String,
) -> Result<Vec<db::BacklinkInfo>, String> {
    let conn = db::init_db(&app_handle)?;
    db::get_incoming_backlinks(&conn, &target_id)
}

#[tauri::command]
fn start_watching_vault(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    vault_path: String,
) -> Result<(), String> {
    {
        let mut guard = state.watcher_path.lock().unwrap();
        if guard.as_deref() == Some(&vault_path) {
            return Ok(());
        }
        *guard = Some(vault_path.clone());
    }
    watcher::start_vault_watcher(vault_path, app_handle)
}

#[tauri::command]
fn linker_scan(
    state: tauri::State<'_, AppState>,
    file_path: String
) -> Result<Vec<String>, String> {
    let linker = state.linker.lock().unwrap();
    let engine = linker.as_ref().ok_or("Linker engine not initialized")?;
    engine.scan_file(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn linker_diff(
    state: tauri::State<'_, AppState>,
    file_path: String
) -> Result<Option<Delta>, String> {
    let linker = state.linker.lock().unwrap();
    let engine = linker.as_ref().ok_or("Linker engine not initialized")?;
    let diff = engine.diff_file(&file_path).map_err(|e| e.to_string())?;
    Ok(diff.map(Delta::from))
}

#[tauri::command]
fn linker_apply(
    state: tauri::State<'_, AppState>,
    file_path: String
) -> Result<bool, String> {
    let mut linker = state.linker.lock().unwrap();
    let engine = linker.as_mut().ok_or("Linker engine not initialized")?;
    engine.apply_file(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_approved_links(
    state: tauri::State<'_, AppState>,
    file_path: String,
    approved_links: Vec<LinkMention>
) -> Result<(), String> {
    let mut linker = state.linker.lock().unwrap();
    let engine = linker.as_mut().ok_or("Linker engine not initialized")?;

    let path = Path::new(&file_path);
    let mut content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Rewrite the body first: replace each approved mention with a real
    // [[wikilink]]. Sort by start descending so earlier offsets stay valid
    // while replacing from the end of the file backwards.
    let mut mentions = approved_links;
    mentions.sort_by(|a, b| b.start.cmp(&a.start));

    let mut targets: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in &mentions {
        let title = engine
            .get_note_title(&m.target_note_id)
            .unwrap_or_else(|_| m.target_note_id.clone());
        let replacement = if m.matched_text == title {
            format!("[[{}]]", title)
        } else {
            format!("[[{}|{}]]", title, m.matched_text)
        };
        content.replace_range(m.start..m.end, &replacement);
        if seen.insert(m.target_note_id.clone()) {
            targets.push(m.target_note_id.clone());
        }
    }

    // Perform atomic write (footer lists the applied targets once each)
    linker::writer::atomic_write(path, &content, &targets)
        .map_err(|e| e.to_string())?;

    // Update DB
    engine.update_db_links(&file_path, &targets)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn add_denied_link(
    app_handle: tauri::AppHandle,
    note_path: String,
    kind: String,
    target: String,
    matched_text: Option<String>,
) -> Result<(), String> {
    let conn = db::init_db(&app_handle)?;
    db::add_denied_link(&conn, &note_path, &kind, &target, matched_text.as_deref())
}

#[tauri::command]
fn get_denied_links(
    app_handle: tauri::AppHandle,
    note_path: String,
) -> Result<Vec<db::DeniedLink>, String> {
    let conn = db::init_db(&app_handle)?;
    // Drop ghost entries (formatted/unlinked text, deleted blocks) before
    // returning, so the Denied/Hidden tabs only show live links.
    let content = std::fs::read_to_string(&note_path).ok();
    db::prune_stale_denied_links(&conn, &note_path, content.as_deref())?;
    db::get_denied_links(&conn, &note_path)
}

#[tauri::command]
fn remove_denied_link(
    app_handle: tauri::AppHandle,
    note_path: String,
    kind: Option<String>,
    target: Option<String>,
    matched_text: Option<String>,
) -> Result<(), String> {
    let conn = db::init_db(&app_handle)?;
    db::remove_denied_link(&conn, &note_path, kind.as_deref(), target.as_deref(), matched_text.as_deref())
}

#[tauri::command]
fn setup_omniroute_environment(_app: tauri::AppHandle) -> Result<String, String> {
    println!("Initializing OmniRoute environment check...");
    
    let mut output = String::new();

    // 1. Check/Install Node.js (via Homebrew for Mac as a baseline)
    #[cfg(target_os = "macos")]
    {
        let node_check = Command::new("node").arg("-v").output();
        if node_check.is_err() {
            output.push_str("Node.js not found. Attempting installation via brew...\n");
            let install_node = Command::new("brew").args(["install", "node"]).output();
            if install_node.is_err() || !install_node.unwrap().status.success() {
                return Err("Failed to install Node.js. Please install it manually from https://nodejs.org".to_string());
            }
            output.push_str("Node.js installed successfully.\n");
        } else {
            output.push_str("Node.js is already installed.\n");
        }
    }

    // 2. Check/Install OmniRoute
    let omniroute_check = Command::new("omniroute").arg("--version").output();
    if omniroute_check.is_err() {
        output.push_str("OmniRoute not found. Installing via npm...\n");
        let install_omni = Command::new("npm").args(["install", "-g", "omniroute"]).output();
        if install_omni.is_err() || !install_omni.unwrap().status.success() {
            return Err("Failed to install OmniRoute. Please run 'npm install -g omniroute' manually.".to_string());
        }
        output.push_str("OmniRoute installed successfully.\n");
    } else {
        output.push_str("OmniRoute is already installed.\n");
    }

    // 3. Start OmniRoute Server in background (assuming it has a server mode)
    // If omniroute is a CLI tool and not a daemon, this might differ.
    // We'll try to launch it as a detached process.
    let _ = Command::new("omniroute")
        .arg("server")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    output.push_str("OmniRoute server started in background.\n");
    
    Ok(output)
}

#[tauri::command]
fn select_file() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select File to Ingest")
        .add_filter("All Supported Files", &["pdf", "docx", "pptx", "xlsx", "mp3", "wav", "m4a", "mp4", "mov", "png", "jpg", "jpeg", "html"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn select_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select Note Vault Folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// Streams the vault through a bounded worker pool and returns lightweight
/// note metadata (no contents) so the sidebar renders without an IPC flood.
/// The full knowledge graph is rebuilt in SQLite as a side effect.
#[tauri::command]
fn index_vault(
    app_handle: tauri::AppHandle,
    vault_path: String,
) -> Result<engine::indexer::IndexedVault, String> {
    engine::indexer::index_vault(Path::new(&vault_path), app_handle)
}

/// Fetches the incoming backlinks (with source line ranges) for the currently
/// active note only. The whole graph never crosses the IPC boundary.
#[tauri::command]
fn get_backlinks_for_note(
    app_handle: tauri::AppHandle,
    note_path: String,
) -> Result<Vec<db::BacklinkInfo>, String> {
    let conn = db::init_db(&app_handle)?;
    db::get_backlinks_for_note(&conn, &note_path)
}

/// Serves the content-free knowledge graph (nodes + edges) from SQLite so the
/// D3 force-graph never holds the full vault contents in React state.
#[tauri::command]
fn get_graph(app_handle: tauri::AppHandle) -> Result<db::GraphPayload, String> {
    let conn = db::init_db(&app_handle)?;
    db::get_graph(&conn)
}

#[tauri::command]
fn write_file(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let path = Path::new(&file_path);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    // Mask the write from the vault watcher. The frontend already refreshed
    // its own state after saving, so letting the watcher re-index here would
    // burn CPU (full dictionary rebuild + mention scan per autosave) and
    // cause a `vault-changed` echo back into the webview on every keystroke.
    suppress_self_write(path, SELF_WRITE_MASK_MS);
    fs::write(path, &content).map_err(|e| e.to_string())?;

    // The watcher is masked for app-initiated writes, so the applied-link
    // graph (which the D3 graph tab reads from) would otherwise go stale —
    // links removed from the note body would linger as "ghost" edges until a
    // full re-index. Keep the SQLite graph in sync right here, every save:
    // notes row + applied [[wikilinks]] + mention backlinks. This is cheap
    // (regex + Aho-Corasick) and makes the graph 1:1 with the vault.
    if let Ok(conn) = db::init_db(&app_handle) {
        let title = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let aliases = watcher::extract_aliases(&content);
        let _ = db::upsert_note(&conn, &file_path, &title, &file_path, &aliases);
        let _ = db::sync_note_tags(&conn, &file_path, &content);

        let targets = db::extract_applied_links(&content);
        let _ = db::update_links_flat(&conn, &file_path, &targets);

        if let Ok(dictionary) = db::get_vault_dictionary(&conn) {
            let linker = cached_linker(&state, dictionary);
            let mentions = linker.find_mentions(&content, Some(&file_path));
            let _ = db::update_backlinks(&conn, &file_path, &mentions, &content);
        }
    }
    Ok(())
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(vault_path: String, relative_path: String, content: Option<String>) -> Result<String, String> {
    let root = Path::new(&vault_path);
    let mut file_path = root.join(&relative_path);
    
    // Ensure extension is .md
    if let Some(ext) = file_path.extension() {
        if ext != "md" && ext != "markdown" {
            file_path.set_extension("md");
        }
    } else {
        file_path.set_extension("md");
    }

    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    let file_content = content.unwrap_or_default();
    // Mask the create event: the frontend re-indexes immediately after, so a
    // watcher re-scan would be duplicate work.
    suppress_self_write(&file_path, SELF_WRITE_MASK_MS);
    fs::write(&file_path, file_content).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_folder(vault_path: String, relative_path: String) -> Result<String, String> {
    let dir = Path::new(&vault_path).join(&relative_path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_folder(vault_path: String, relative_path: String) -> Result<(), String> {
    let root = Path::new(&vault_path);
    let dir = root.join(&relative_path);

    // Reject path traversal, the vault root itself, and the app-managed
    // sidecar folder (its deletion would orphan note metadata).
    let rel = relative_path.replace('\\', "/");
    let rel_trimmed = rel.trim_matches('/');
    if rel_trimmed.is_empty()
        || rel_trimmed == "."
        || rel_trimmed == ".."
        || rel_trimmed.starts_with("../")
        || rel_trimmed.contains("/../")
    {
        return Err("Invalid folder path".to_string());
    }
    if !dir.exists() {
        return Err(format!("Folder not found: {}", relative_path));
    }
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", relative_path));
    }
    if dir == root {
        return Err("Cannot delete the vault root folder".to_string());
    }
    if dir
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("note metadata"))
        .unwrap_or(false)
    {
        return Err("Cannot delete the app-managed 'note metadata' folder".to_string());
    }

    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete folder: {e}"))?;
    Ok(())
}

#[tauri::command]
fn rename_folder(
    app_handle: tauri::AppHandle,
    vault_path: String,
    old_relative_path: String,
    new_relative_path: String,
) -> Result<(), String> {
    let root = Path::new(&vault_path);
    let old_dir = root.join(&old_relative_path);
    let new_dir = root.join(&new_relative_path);

    // Reject path traversal, the vault root itself, and the app-managed
    // sidecar folder (same guards as delete_folder).
    let rel = old_relative_path.replace('\\', "/");
    let rel_trimmed = rel.trim_matches('/');
    if rel_trimmed.is_empty()
        || rel_trimmed == "."
        || rel_trimmed == ".."
        || rel_trimmed.starts_with("../")
        || rel_trimmed.contains("/../")
    {
        return Err("Invalid folder path".to_string());
    }
    if !old_dir.exists() {
        return Err(format!("Folder not found: {}", old_relative_path));
    }
    if !old_dir.is_dir() {
        return Err(format!("Not a folder: {}", old_relative_path));
    }
    if old_dir == root {
        return Err("Cannot rename the vault root folder".to_string());
    }
    if old_dir
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("note metadata"))
        .unwrap_or(false)
    {
        return Err("Cannot rename the app-managed 'note metadata' folder".to_string());
    }
    // The new path must not collide with an existing entry.
    if new_dir.exists() {
        return Err(format!("A folder named '{}' already exists", new_relative_path));
    }
    if let Some(parent) = new_dir.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;

    // Re-point every DB row under the old path to the new path so
    // embeddings, history and graph edges survive the move. (The watcher's
    // rename handler rewrites per-file, but a folder move fires one event per
    // contained note — doing it here in one pass is atomic and cheaper.)
    let old_prefix = old_dir.to_string_lossy().to_string();
    let new_prefix = new_dir.to_string_lossy().to_string();
    if let Ok(conn) = db::init_db(&app_handle) {
        let _ = db::rename_folder_paths(&conn, &old_prefix, &new_prefix);
    }
    Ok(())
}

#[tauri::command]
fn delete_file(app_handle: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if path.exists() {
        // Mask the remove event: the frontend re-indexes immediately after.
        suppress_self_write(path, SELF_WRITE_MASK_MS);
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    // The masked Remove event never reaches the watcher, so purge the note's
    // graph rows here (notes, backlinks, links, embeddings) — otherwise the
    // deleted note would linger as a ghost node/edge in the graph tab.
    if let Ok(conn) = db::init_db(&app_handle) {
        let _ = conn.execute("DELETE FROM notes WHERE id = ?1", params![file_path]);
        let _ = conn.execute(
            "DELETE FROM backlinks WHERE source_path = ?1 OR target_path = ?1",
            params![file_path],
        );
        let _ = conn.execute(
            "DELETE FROM links WHERE source = ?1 OR target = ?1",
            params![file_path],
        );
        let _ = conn.execute("DELETE FROM denied_links WHERE note_path = ?1", params![file_path]);
        let _ = crate::db::clear_block_embeddings(&conn, &file_path);
        let _ = conn.execute("DELETE FROM embeddings WHERE note_id = ?1", params![file_path]);
    }
    Ok(())
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("Source file not found: {old_path}"));
    }

    if let Some(parent) = new.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(old, new).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn run_ingestion_script(script_command: String, vault_path: String) -> Result<String, String> {
    if script_command.trim().is_empty() {
        return Err("No script command provided.".to_string());
    }

    let formatted_command = script_command.replace("{vault_path}", &vault_path);

    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.args(&["/C", &formatted_command]);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = std::process::Command::new("sh");
    #[cfg(not(target_os = "windows"))]
    cmd.args(&["-c", &formatted_command]);

    let output = cmd
        .current_dir(&vault_path)
        .output()
        .map_err(|e| format!("Failed to execute process: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        let out = if stdout.is_empty() {
            "Script executed successfully with no output.".to_string()
        } else {
            stdout
        };
        Ok(out)
    } else {
        Err(format!("Execution error:\n{}\n{}", stdout, stderr))
    }
}

// Helper to discover python executable
fn find_python() -> String {
    #[cfg(target_os = "windows")]
    let candidates = vec!["python", "py", "python3"];

    #[cfg(not(target_os = "windows"))]
    let candidates = vec!["python3.12", "python3", "python"];

    for cand in candidates {
        if std::process::Command::new(cand).arg("--version").output().is_ok() {
            return cand.to_string();
        }
    }

    "python3".to_string()
}

// Helper to find Extractor script
fn resolve_resource_file(app: &tauri::AppHandle, relative_subpath: &str) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p1 = resource_dir.join(relative_subpath);
        if p1.exists() { return p1; }
        let p2 = resource_dir.join("_up_").join(relative_subpath);
        if p2.exists() { return p2; }
    }

    // Dev fallback
    if let Ok(cwd) = std::env::current_dir() {
        let p1 = cwd.join(relative_subpath);
        if p1.exists() { return p1; }
        let p2 = cwd.parent().unwrap_or(&cwd).join(relative_subpath);
        if p2.exists() { return p2; }
    }

    PathBuf::from(relative_subpath)
}

#[tauri::command]
async fn run_builtin_extractor_async(
    app: tauri::AppHandle,
    window: Window,
    vault_path: String,
    ingest_type: String,
    value: String,
    yt_method: String
) -> Result<String, String> {
    if vault_path.trim().is_empty() {
        return Err("Please select a note vault folder first.".to_string());
    }

    let script_path = resolve_resource_file(&app, "Extractor Final/master_extractor.py");
    if !script_path.exists() {
        return Err(format!("Extractor script not found at path: {:?}", script_path));
    }

    let python_cmd = find_python();

    let clean_script_path = script_path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();

    let mut cmd = Command::new(&python_cmd);
    cmd.arg(clean_script_path);
    cmd.arg("--vault");
    cmd.arg(&vault_path);
    cmd.arg("--yt_method");
    cmd.arg(&yt_method);

    if ingest_type == "url" {
        cmd.arg("--urls");
        cmd.arg(&value);
    } else {
        cmd.arg("--files");
        cmd.arg(&value);
    }

    let mut child = cmd
        .current_dir(&vault_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch extractor: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let window_clone = window.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = window_clone.emit("ingestion-progress", l);
            }
        }
    });

    let window_clone_err = window.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = window_clone_err.emit("ingestion-error", l);
            }
        }
    });

    let status = child.wait().map_err(|e| format!("Process wait failed: {}", e))?;
    
    if status.success() {
        Ok("Extraction completed successfully.".to_string())
    } else {
        Err("Extraction failed. Check logs for details.".to_string())
    }
}

#[tauri::command]
fn run_extractor_installer(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let script_name = "Extractor Final/windows_Installer.bat";
    #[cfg(target_os = "macos")]
    let script_name = "Extractor Final/mac_Installer.sh";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let script_name = "Extractor Final/linux_Installer.sh";

    let installer_path = resolve_resource_file(&app, script_name);
    if !installer_path.exists() {
        return Err(format!("Installer script not found at path: {:?}", installer_path));
    }

    #[cfg(target_os = "windows")]
    let clean_installer_path = installer_path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();

    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.arg("/C");
    #[cfg(target_os = "windows")]
    cmd.arg(clean_installer_path);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = std::process::Command::new("bash");
    #[cfg(not(target_os = "windows"))]
    cmd.arg(installer_path.to_string_lossy().to_string());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run installer script: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("Extractor Installation Succeeded:\n\n{}\n{}", stdout, stderr))
    } else {
        Err(format!("Installer Error:\n{}\n{}", stdout, stderr))
    }
}

#[tauri::command]
fn append_ingestion_log(app: tauri::AppHandle, level: String, message: String) -> Result<(), String> {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let log_dir = home.join(".cerebro");
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;

    let log_path = log_dir.join("ingestion.log");

    let epoch_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    let (year, month, day, hour, minute, second) = civil_from_epoch(epoch_secs);
    let line = format!(
        "[{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}] [{level}] {message}\n"
    );

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;

    Ok(())
}

/// Convert UNIX epoch seconds to UTC calendar fields (Howard Hinnant's civil-from-days algorithm).
fn civil_from_epoch(epoch_secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = epoch_secs.div_euclid(86_400);
    let secs_of_day = epoch_secs.rem_euclid(86_400);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    (year, month, day, hour, minute, second)
}

/// Appends an app action/error log line. Logs are written to a folder named
/// `appLogs` (next to the existing `.cerebro` data), organized by date:
///
/// ```text
/// ~/.cerebro/appLogs/2026-08-14/actions.log   <- app actions (info level)
/// ~/.cerebro/appLogs/2026-08-14/errors.log    <- app errors
/// ```
///
/// Each line carries a full timestamp: `[YYYY-MM-DD HH:MM:SS] [LEVEL] message`.
#[tauri::command]
fn append_app_log(app: tauri::AppHandle, level: String, message: String) -> Result<(), String> {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let log_root = home.join(".cerebro").join("appLogs");

    let epoch_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    let (year, month, day, hour, minute, second) = civil_from_epoch(epoch_secs);

    // Daily subfolder so logs are naturally sorted by date.
    let day_dir = log_root.join(format!("{year:04}-{month:02}-{day:02}"));
    fs::create_dir_all(&day_dir).map_err(|e| e.to_string())?;

    let level_upper = level.to_uppercase();
    let file_name = if level_upper == "ERROR" || level_upper == "WARN" {
        "errors.log"
    } else {
        "actions.log"
    };
    let log_path = day_dir.join(file_name);

    let line = format!(
        "[{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}] [{level_upper}] {message}\n"
    );

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn format_note_content(content: String) -> Result<String, String> {
    Ok(crate::engine::formatter::format_note_content(&content))
}

#[tauri::command]
fn record_note_version(
    app_handle: tauri::AppHandle,
    note_path: String,
    content: String,
) -> Result<Option<i64>, String> {
    let conn = db::init_db(&app_handle)?;
    db::history::record_note_version(&conn, &note_path, &content)
}

#[tauri::command]
fn reconstruct_note_version(
    app_handle: tauri::AppHandle,
    note_path: String,
    target_delta_id: Option<i64>,
) -> Result<String, String> {
    let conn = db::init_db(&app_handle)?;
    db::history::reconstruct_note_version(&conn, &note_path, target_delta_id)
}

#[tauri::command]
fn get_note_history(
    app_handle: tauri::AppHandle,
    note_path: String,
) -> Result<Option<db::history::NoteVersionHistory>, String> {
    let conn = db::init_db(&app_handle)?;
    db::history::get_note_history(&conn, &note_path)
}

#[tauri::command]
fn get_all_reconstructed_versions(
    app_handle: tauri::AppHandle,
    note_path: String,
) -> Result<Vec<db::history::ReconstructedVersion>, String> {
    let conn = db::init_db(&app_handle)?;
    db::history::get_all_reconstructed_versions(&conn, &note_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(AppState {
                linker: Mutex::new(None),
                db_path: Mutex::new(None),
                watcher_path: Mutex::new(None),
                embeddings: Mutex::new(None),
                embed_lock: Mutex::new(()),
                linker_cache: Mutex::new(None),
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            init_linker,
            get_vault_dictionary,
            get_topic_groups,
            index_note,
            get_incoming_backlinks,
            start_watching_vault,
            linker_scan,
            linker_diff,
            linker_apply,
            apply_approved_links,
            add_denied_link,
            get_denied_links,
            remove_denied_link,
            scan_unlinked_mentions,
            get_backlinks_for_note,
            get_graph,
            index_vault,
            select_file,
            select_folder,
            write_file,
            read_file,
            create_file,
            create_folder,
            delete_folder,
            rename_folder,
            delete_file,
            rename_file,
            run_ingestion_script,
            run_builtin_extractor_async,
            run_extractor_installer,
            append_ingestion_log,
            append_app_log,
            generate_and_store_embedding,
            generate_and_store_block_embeddings,
            find_block_related_notes,
            find_semantic_related_notes,
            backfill_embeddings,
            setup_omniroute_environment,
            format_note_content,
            record_note_version,
            reconstruct_note_version,
            get_note_history,
            get_all_reconstructed_versions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

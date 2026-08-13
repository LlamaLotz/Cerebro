use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use regex::Regex;
use rusqlite::params;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::db;
use crate::linker::NoteLinker;

const DEBOUNCE_MS: u64 = 500;

#[derive(serde::Serialize, Clone)]
pub struct VaultChangePayload {
    pub path: String,
    pub kind: String,
}

/// Starts a background watcher on `vault_path` that keeps the SQLite index
/// and backlink graph in sync with the files on disk.
pub fn start_vault_watcher(vault_path: String, app_handle: AppHandle) -> Result<(), String> {
    let (tx, mut rx) = mpsc::channel::<Event>(256);

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let _ = tx.blocking_send(event);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&vault_path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // The watcher is moved into the task and kept alive for the process lifetime.
    tauri::async_runtime::spawn(async move {
        let mut pending: HashMap<PathBuf, EventKind> = HashMap::new();

        loop {
            tokio::select! {
                event = rx.recv() => {
                    match event {
                        Some(ev) => {
                            if let Some(path) = ev.paths.first().cloned() {
                                pending.insert(path, ev.kind);
                            }
                        }
                        None => break,
                    }
                }
                // 500ms debounce window: flushes once events quiet down
                _ = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)) => {
                    if pending.is_empty() {
                        continue;
                    }
                    let batch = std::mem::take(&mut pending);
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        process_batch(&handle, batch);
                    });
                }
            }
        }
    });

    Ok(())
}

fn process_batch(app_handle: &AppHandle, batch: HashMap<PathBuf, EventKind>) {
    let mut rename_from: Vec<PathBuf> = Vec::new();
    let mut rename_to: Vec<PathBuf> = Vec::new();
    let mut removes: Vec<PathBuf> = Vec::new();
    let mut changes: Vec<PathBuf> = Vec::new();

    for (path, kind) in batch {
        if !is_markdown(&path) {
            continue;
        }
        match kind {
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => rename_from.push(path),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => rename_to.push(path),
            EventKind::Remove(_) => removes.push(path),
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any => changes.push(path),
            _ => {}
        }
    }

    // Pair rename From/To events (a rename emits both within the same batch).
    let pairs = rename_from.len().min(rename_to.len());
    for i in 0..pairs {
        handle_rename(app_handle, &rename_from[i], &rename_to[i]);
    }
    for p in rename_from.iter().skip(pairs) {
        handle_remove(app_handle, p);
    }
    for p in rename_to.iter().skip(pairs) {
        handle_change(app_handle, p);
    }

    for p in &removes {
        handle_remove(app_handle, p);
    }
    for p in &changes {
        handle_change(app_handle, p);
    }
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("markdown")
    )
}

/// Indexes a created/modified note, rescans its mentions and updates backlinks.
fn handle_change(app_handle: &AppHandle, path: &Path) {
    let path_str = path.to_string_lossy().to_string();
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Some(title) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
        return;
    };

    let Ok(conn) = db::init_db(app_handle) else {
        return;
    };

    let aliases = extract_aliases(&content);
    if db::upsert_note(&conn, &path_str, &title, &path_str, &aliases).is_err() {
        return;
    }

    if let Ok(dictionary) = db::get_vault_dictionary(&conn) {
        let linker = NoteLinker::new(dictionary);
        let mentions = linker.find_mentions(&content, Some(&path_str));
        let _ = db::update_backlinks(&conn, &path_str, &mentions);
    }

    let _ = app_handle.emit(
        "vault-changed",
        VaultChangePayload {
            path: path_str,
            kind: "modified".to_string(),
        },
    );
}

/// Removes a deleted note from the index and clears its graph edges.
fn handle_remove(app_handle: &AppHandle, path: &Path) {
    let path_str = path.to_string_lossy().to_string();

    if let Ok(conn) = db::init_db(app_handle) {
        let _ = conn.execute("DELETE FROM notes WHERE id = ?1", params![path_str]);
        let _ = conn.execute(
            "DELETE FROM backlinks WHERE source_id = ?1 OR target_id = ?1",
            params![path_str],
        );
        let _ = conn.execute(
            "DELETE FROM links WHERE source = ?1 OR target = ?1",
            params![path_str],
        );
    }

    let _ = app_handle.emit(
        "vault-changed",
        VaultChangePayload {
            path: path_str,
            kind: "removed".to_string(),
        },
    );
}

/// Refactors every `[[Old Title]]` / `[[Old Title|Alias]]` reference across
/// the vault when a note is renamed, and updates the graph accordingly.
fn handle_rename(app_handle: &AppHandle, from: &Path, to: &Path) {
    let old_path = from.to_string_lossy().to_string();
    let new_path = to.to_string_lossy().to_string();
    let Some(old_title) = from.file_stem().map(|s| s.to_string_lossy().to_string()) else {
        return;
    };
    let Some(new_title) = to.file_stem().map(|s| s.to_string_lossy().to_string()) else {
        return;
    };

    let Ok(conn) = db::init_db(app_handle) else {
        return;
    };

    // 1. Find every source note that links to the old note
    let mut sources: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT source_id FROM backlinks WHERE target_id = ?1") {
        if let Ok(rows) = stmt.query_map(params![old_path], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                sources.push(row);
            }
        }
    }

    // 2. Rewrite [[Old Title]] and [[Old Title|Alias]] to the new title
    let pattern = format!(
        r"\[\[{}\|([^\]]*)\]\]|\[\[{}\]\]",
        regex::escape(&old_title),
        regex::escape(&old_title)
    );
    let Ok(re) = Regex::new(&pattern) else {
        return;
    };
    for src in &sources {
        let Ok(content) = std::fs::read_to_string(src) else {
            continue;
        };
        let updated = re
            .replace_all(&content, |caps: &regex::Captures| {
                if let Some(alias) = caps.get(1) {
                    format!("[[{}|{}]]", new_title, alias.as_str())
                } else {
                    format!("[[{}]]", new_title)
                }
            })
            .to_string();
        if updated != content {
            let _ = std::fs::write(src, updated);
        }
    }

    // 3. Re-point every graph edge to the new note
    let _ = conn.execute(
        "UPDATE backlinks SET target_id = ?1 WHERE target_id = ?2",
        params![new_path, old_path],
    );
    let _ = conn.execute(
        "UPDATE backlinks SET source_id = ?1 WHERE source_id = ?2",
        params![new_path, old_path],
    );
    let _ = conn.execute(
        "UPDATE links SET target = ?1 WHERE target = ?2",
        params![new_path, old_path],
    );
    let _ = conn.execute(
        "UPDATE links SET source = ?1 WHERE source = ?2",
        params![new_path, old_path],
    );

    // 4. Move the note row (id is the primary key; flip FK enforcement for the swap)
    let _ = conn.execute_batch("PRAGMA foreign_keys = OFF");
    let _ = conn.execute(
        "UPDATE notes SET id = ?1, title = ?2, path = ?3 WHERE id = ?4",
        params![new_path, new_title, new_path, old_path],
    );
    let _ = conn.execute_batch("PRAGMA foreign_keys = ON");

    // 5. Re-index the renamed note's own outgoing links
    handle_change(app_handle, to);

    let _ = app_handle.emit(
        "vault-changed",
        VaultChangePayload {
            path: new_path,
            kind: "renamed".to_string(),
        },
    );
}

/// Lightweight regex-based YAML frontmatter alias extractor.
/// Supports both inline (`aliases: [A, B]`, `aliases: A, B`) and
/// block list (`aliases:\n  - A\n  - B`) forms.
pub fn extract_aliases(content: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    let frontmatter = Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---")
        .ok()
        .and_then(|re| re.captures(content).map(|c| c[1].to_string()));
    let Some(block) = frontmatter else {
        return aliases;
    };

    if let Ok(re) = Regex::new(r"(?m)^aliases?:\s*(.+)$") {
        if let Some(caps) = re.captures(&block) {
            let value = caps[1].trim().trim_start_matches('[').trim_end_matches(']');
            aliases.extend(
                value
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty()),
            );
        }
    }

    if let Ok(re) = Regex::new(r"(?m)^aliases?:\s*\r?\n((?:\s+-\s+.+[\r\n]*)+)") {
        if let Some(caps) = re.captures(&block) {
            for line in caps[1].lines() {
                let alias = line
                    .trim()
                    .trim_start_matches("- ")
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                if !alias.is_empty() {
                    aliases.push(alias);
                }
            }
        }
    }

    aliases
}

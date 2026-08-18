use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteHistoryBase {
    pub note_path: String,
    pub original_content: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteHistoryDelta {
    pub id: i64,
    pub note_path: String,
    pub delta_patch: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteVersionHistory {
    pub base: NoteHistoryBase,
    pub deltas: Vec<NoteHistoryDelta>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReconstructedVersion {
    pub note_path: String,
    pub version_id: Option<i64>,
    pub content: String,
    pub created_at: String,
}

enum DiffOp<'a> {
    Equal(&'a str),
    Insert(&'a str),
    Delete(&'a str),
}

/// Myers O((N+M)·D) diff — near-linear for typical edits, versus the old
/// O(N·M) LCS matrix that spiked CPU/memory to gigabytes on large notes.
/// Produces the same line-based ops (` `, `+`, `-`) `apply_patch` consumes.
fn myers_diff<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<DiffOp<'a>> {
    let n = a.len() as i64;
    let m = b.len() as i64;
    let max = n + m;
    let offset = max as usize;
    // v[k] = furthest x on diagonal k; indexed from -max..=max via `offset`.
    let mut v = vec![0i64; 2 * max as usize + 1];
    // Snapshot of v before each D iteration, used to backtrack the edit path.
    let mut trace: Vec<Vec<i64>> = Vec::new();
    let mut found_d: i64 = -1;

    'outer: for d in 0..=max {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[(offset as i64 + k - 1) as usize] < v[(offset as i64 + k + 1) as usize])
            {
                v[(offset as i64 + k + 1) as usize]
            } else {
                v[(offset as i64 + k - 1) as usize] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(offset as i64 + k) as usize] = x;
            if x >= n && y >= m {
                found_d = d;
                break 'outer;
            }
            k += 2;
        }
    }

    // Backtrack from the end, emitting ops in reverse order.
    let mut ops: Vec<DiffOp<'a>> = Vec::new();
    let mut x = n;
    let mut y = m;
    for d in (0..=found_d).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && v[(offset as i64 + k - 1) as usize] < v[(offset as i64 + k + 1) as usize])
        {
            k + 1
        } else {
            k - 1
        };
        let prev_x = v[(offset as i64 + prev_k) as usize];
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            ops.push(DiffOp::Equal(a[(x - 1) as usize]));
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            if x == prev_x {
                ops.push(DiffOp::Insert(b[(y - 1) as usize]));
            } else {
                ops.push(DiffOp::Delete(a[(x - 1) as usize]));
            }
            x = prev_x;
            y = prev_y;
        }
    }
    ops.reverse();
    ops
}

/// Generates a line-based diff patch string from old_text to new_text.
pub fn generate_patch(old_text: &str, new_text: &str) -> String {
    if old_text == new_text {
        return String::new();
    }

    let a: Vec<&str> = if old_text.is_empty() {
        Vec::new()
    } else {
        old_text.lines().collect()
    };
    let b: Vec<&str> = if new_text.is_empty() {
        Vec::new()
    } else {
        new_text.lines().collect()
    };

    let mut patch_ops = Vec::new();
    for op in myers_diff(&a, &b) {
        match op {
            DiffOp::Equal(line) => patch_ops.push(format!(" {}", line)),
            DiffOp::Insert(line) => patch_ops.push(format!("+{}", line)),
            DiffOp::Delete(line) => patch_ops.push(format!("-{}", line)),
        }
    }
    patch_ops.join("\n")
}

/// Applies a line-based diff patch string to old_text to produce reconstructed_text.
pub fn apply_patch(old_text: &str, patch: &str) -> Result<String, String> {
    if patch.trim().is_empty() {
        return Ok(old_text.to_string());
    }

    let mut old_lines = if old_text.is_empty() {
        Vec::new()
    } else {
        old_text.lines().collect::<Vec<&str>>()
    };
    old_lines.reverse(); // Use as stack

    let mut new_lines = Vec::new();

    for line in patch.lines() {
        if line.is_empty() {
            continue;
        }
        let (prefix, val) = line.split_at(1);
        match prefix {
            " " => {
                if let Some(old_val) = old_lines.pop() {
                    if old_val != val {
                        // Context mismatch - fallback to best effort or return error
                        new_lines.push(val);
                    } else {
                        new_lines.push(old_val);
                    }
                } else {
                    new_lines.push(val);
                }
            }
            "+" => {
                new_lines.push(val);
            }
            "-" => {
                if let Some(old_val) = old_lines.pop() {
                    if old_val != val {
                        // Skip if mismatched, best effort
                    }
                }
            }
            _ => {
                return Err(format!("Invalid patch operation line: {}", line));
            }
        }
    }

    Ok(new_lines.join("\n"))
}

/// Records a new version snapshot for note_path in SQLite.
/// If base history does not exist, creates the base record.
/// Otherwise, reconstructs latest version, computes delta patch, and inserts a delta record if changed.
/// Notes above this size skip version history entirely. Version snapshots of
/// multi-MB imported/OCR notes (huge base rows + a diff per save) burn CPU and
/// disk for little value — the Format button and autosave would otherwise diff
/// megabytes on every pause.
pub const MAX_HISTORY_NOTE_CHARS: usize = 512 * 1024;

pub fn record_note_version(
    conn: &Connection,
    note_path: &str,
    content: &str,
) -> Result<Option<i64>, String> {
    // Oversized notes: skip history (see MAX_HISTORY_NOTE_CHARS).
    if content.len() > MAX_HISTORY_NOTE_CHARS {
        return Ok(None);
    }

    // Check if base exists
    let mut stmt = conn
        .prepare("SELECT original_content FROM note_history_base WHERE note_path = ?1")
        .map_err(|e| e.to_string())?;

    let base_exists = stmt.exists(params![note_path]).map_err(|e| e.to_string())?;

    if !base_exists {
        conn.execute(
            "INSERT INTO note_history_base (note_path, original_content) VALUES (?1, ?2)",
            params![note_path, content],
        )
        .map_err(|e| e.to_string())?;
        return Ok(None);
    }

    // Base exists: reconstruct latest content
    let latest_content = reconstruct_note_version(conn, note_path, None)?;

    if latest_content == content {
        // No changes
        return Ok(None);
    }

    let patch = generate_patch(&latest_content, content);
    if patch.is_empty() {
        return Ok(None);
    }

    conn.execute(
        "INSERT INTO note_history_deltas (note_path, delta_patch) VALUES (?1, ?2)",
        params![note_path, patch],
    )
    .map_err(|e| e.to_string())?;

    let delta_id = conn.last_insert_rowid();

    // Space-optimized checkpoints: once a note accumulates more than 50
    // patches, squash them into the base (reconstruct the current content and
    // reset the delta chain). Keeps any reconstruction under a couple of ms.
    let delta_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM note_history_deltas WHERE note_path = ?1",
            params![note_path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if delta_count > 50 {
        if let Ok(latest) = reconstruct_note_version(conn, note_path, None) {
            conn.execute(
                "UPDATE note_history_base SET original_content = ?1 WHERE note_path = ?2",
                params![latest, note_path],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM note_history_deltas WHERE note_path = ?1",
                params![note_path],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(Some(delta_id))
}

/// Reconstructs the full content of a note at a given delta_id (or latest if target_delta_id is None).
pub fn reconstruct_note_version(
    conn: &Connection,
    note_path: &str,
    target_delta_id: Option<i64>,
) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT original_content FROM note_history_base WHERE note_path = ?1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query_map(params![note_path], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut current_content = match rows.next() {
        Some(Ok(content)) => content,
        _ => return Err(format!("No history base found for note: {}", note_path)),
    };

    let sql = match target_delta_id {
        Some(limit_id) => {
            format!("SELECT delta_patch FROM note_history_deltas WHERE note_path = ?1 AND id <= {} ORDER BY id ASC", limit_id)
        }
        None => {
            "SELECT delta_patch FROM note_history_deltas WHERE note_path = ?1 ORDER BY id ASC".to_string()
        }
    };

    let mut delta_stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let delta_rows = delta_stmt
        .query_map(params![note_path], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    for patch in delta_rows {
        let p = patch.map_err(|e| e.to_string())?;
        current_content = apply_patch(&current_content, &p)?;
    }

    Ok(current_content)
}

/// Retrieves the version history details for a note.
pub fn get_note_history(
    conn: &Connection,
    note_path: &str,
) -> Result<Option<NoteVersionHistory>, String> {
    let mut stmt = conn
        .prepare("SELECT note_path, original_content, created_at FROM note_history_base WHERE note_path = ?1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query_map(params![note_path], |row| {
            Ok(NoteHistoryBase {
                note_path: row.get(0)?,
                original_content: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let base = match rows.next() {
        Some(Ok(b)) => b,
        _ => return Ok(None),
    };

    let mut delta_stmt = conn
        .prepare("SELECT id, note_path, delta_patch, created_at FROM note_history_deltas WHERE note_path = ?1 ORDER BY id ASC")
        .map_err(|e| e.to_string())?;

    let delta_rows = delta_stmt
        .query_map(params![note_path], |row| {
            Ok(NoteHistoryDelta {
                id: row.get(0)?,
                note_path: row.get(1)?,
                delta_patch: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut deltas = Vec::new();
    for r in delta_rows {
        deltas.push(r.map_err(|e| e.to_string())?);
    }

    Ok(Some(NoteVersionHistory { base, deltas }))
}

/// Retrieves all reconstructed version snapshots for a note history timeline.
pub fn get_all_reconstructed_versions(
    conn: &Connection,
    note_path: &str,
) -> Result<Vec<ReconstructedVersion>, String> {
    let history = match get_note_history(conn, note_path)? {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };

    let mut versions = Vec::new();

    // Base version
    versions.push(ReconstructedVersion {
        note_path: note_path.to_string(),
        version_id: None,
        content: history.base.original_content.clone(),
        created_at: history.base.created_at.clone(),
    });

    let mut current_text = history.base.original_content;

    for delta in history.deltas {
        current_text = apply_patch(&current_text, &delta.delta_patch)?;
        versions.push(ReconstructedVersion {
            note_path: note_path.to_string(),
            version_id: Some(delta.id),
            content: current_text.clone(),
            created_at: delta.created_at,
        });
    }

    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_patch_generate_and_apply() {
        let old_text = "Line 1\nLine 2\nLine 3";
        let new_text = "Line 1\nLine 2 Modified\nLine 3\nLine 4";

        let patch = generate_patch(old_text, new_text);
        assert!(!patch.is_empty());

        let applied = apply_patch(old_text, &patch).unwrap();
        assert_eq!(applied, new_text);
    }

    #[test]
    fn test_delta_history_engine_sqlite() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE note_history_base (
                note_path TEXT PRIMARY KEY,
                original_content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE note_history_deltas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_path TEXT NOT NULL,
                delta_patch TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .unwrap();

        let path = "/vault/test.md";

        // Step 1: Base recording
        let d1 = record_note_version(&conn, path, "Version 1\nHello World").unwrap();
        assert_eq!(d1, None);

        // Step 2: No change -> no delta
        let d2 = record_note_version(&conn, path, "Version 1\nHello World").unwrap();
        assert_eq!(d2, None);

        // Step 3: Change -> Delta 1
        let d3 = record_note_version(&conn, path, "Version 2\nHello World\nLine 3").unwrap();
        assert_eq!(d3, Some(1));

        // Step 4: Change -> Delta 2
        let d4 = record_note_version(&conn, path, "Version 3\nHello Universe\nLine 3").unwrap();
        assert_eq!(d4, Some(2));

        // Reconstruct latest
        let latest = reconstruct_note_version(&conn, path, None).unwrap();
        assert_eq!(latest, "Version 3\nHello Universe\nLine 3");

        // Reconstruct at Delta 1
        let at_d1 = reconstruct_note_version(&conn, path, Some(1)).unwrap();
        assert_eq!(at_d1, "Version 2\nHello World\nLine 3");

        // Reconstruct base (before Delta 1, e.g., target_delta_id = 0)
        let at_base = reconstruct_note_version(&conn, path, Some(0)).unwrap();
        assert_eq!(at_base, "Version 1\nHello World");
    }

    #[test]
    fn test_squash_checkpoint_after_50_deltas() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE note_history_base (
                note_path TEXT PRIMARY KEY,
                original_content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE note_history_deltas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_path TEXT NOT NULL,
                delta_patch TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .unwrap();

        let path = "/vault/squash.md";
        record_note_version(&conn, path, "v0").unwrap();

        // Push 55 small changes: 50 stay as deltas, the 51st triggers a squash.
        let mut content = "v0".to_string();
        for i in 1..=55 {
            content = format!("v{}", i);
            record_note_version(&conn, path, &content).unwrap();
        }

        // The 51st change triggered a squash (delta chain reset to 0); the
        // 4 changes after it (52..=55) are fresh deltas.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_history_deltas WHERE note_path = ?1",
                params![path],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 4);

        // Base holds the squash checkpoint (v51); the 4 trailing deltas
        // advance it to v55.
        let base: String = conn
            .query_row(
                "SELECT original_content FROM note_history_base WHERE note_path = ?1",
                params![path],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(base, "v51");

        // Reconstruction still yields the latest content after the squash.
        let latest = reconstruct_note_version(&conn, path, None).unwrap();
        assert_eq!(latest, "v55");
    }
}

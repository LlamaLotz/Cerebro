use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub title: String,
    pub content: String,
    pub updated_at: f64,
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

#[tauri::command]
fn read_vault_files(vault_path: String) -> Vec<NoteFile> {
    let mut results = Vec::new();
    let root_path = Path::new(&vault_path);
    if !root_path.exists() {
        return results;
    }

    for entry in WalkDir::new(root_path)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() {
            // Skip hidden directories and hidden files (starting with .)
            let is_hidden = path.components().any(|c| {
                c.as_os_str().to_string_lossy().starts_with('.')
            });
            if is_hidden {
                continue;
            }

            if let Some(ext) = path.extension() {
                if ext == "md" || ext == "markdown" {
                    let relative_path = match path.strip_prefix(root_path) {
                        Ok(p) => p.to_string_lossy().to_string(),
                        Err(_) => continue,
                    };

                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let title = path.file_stem().unwrap_or_default().to_string_lossy().to_string();

                    let content = fs::read_to_string(path).unwrap_or_default();
                    let metadata = fs::metadata(path);
                    let updated_at = match metadata {
                        Ok(m) => m.modified()
                            .unwrap_or(UNIX_EPOCH)
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as f64,
                        Err(_) => 0.0,
                    };

                    results.push(NoteFile {
                        path: path.to_string_lossy().to_string(),
                        relative_path,
                        name,
                        title,
                        content,
                        updated_at,
                    });
                }
            }
        }
    }
    results
}

#[tauri::command]
fn write_file(file_path: String, content: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
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
    fs::write(&file_path, file_content).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_file(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);
    if old.exists() {
        if let Some(parent) = new.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        fs::rename(old, new).map_err(|e| e.to_string())?;
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
            select_file,
            select_folder,
            read_vault_files,
            write_file,
            create_file,
            delete_file,
            rename_file,
            run_ingestion_script
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

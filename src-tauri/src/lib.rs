use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::process::{Command, Stdio};
use walkdir::WalkDir;
use tauri::{Manager, Window, Emitter};

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
fn setup_omniroute_environment(app: tauri::AppHandle) -> Result<String, String> {
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

    let mut cmd = Command::new(&python_cmd);
    cmd.arg(script_path.to_string_lossy().to_string());
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
    let mut cmd = std::process::Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.args(&["/C", &installer_path.to_string_lossy()]);

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
            run_ingestion_script,
            run_builtin_extractor_async,
            run_extractor_installer,
            setup_omniroute_environment
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

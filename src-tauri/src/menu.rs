use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::{App, AppHandle, Emitter, Manager};

/// Builds the native application menu bar.
///
/// On macOS the menu appears in the system menu bar at the top of the screen,
/// even with `decorations: false`.  On Windows the menu is accessible via
/// Alt-key or right-click on the titlebar region.
pub fn build_app_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app).build()?;

    // ── File ──────────────────────────────────────────────────────────
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::new("New Note")
                .id("file_new_note")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("New Folder")
                .id("file_new_folder")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Open a Prism…")
                .id("file_open_prism")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Prism"))?)
        .build()?;

    // ── Edit ──────────────────────────────────────────────────────────
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // ── View ──────────────────────────────────────────────────────────
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::new("Note Editor")
                .id("view_editor")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Graph")
                .id("view_graph")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Tags")
                .id("view_topics")
                .accelerator("CmdOrCtrl+3")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Ingestion Logs")
                .id("view_ingestion_logs")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("AI Sidebar")
                .id("view_ai_sidebar")
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Sidebar")
                .id("view_sidebar")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .build()?;

    // ── Help ──────────────────────────────────────────────────────────
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(
            &MenuItemBuilder::new("Prism Documentation")
                .id("help_docs")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Join our Discord")
                .id("help_discord")
                .build(app)?,
        )
        .build()?;

    // ── macOS app-name menu (Prism) ───────────────────────────────────
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Prism")
        .item(
            &MenuItemBuilder::new("Settings…")
                .id("app_settings")
                .accelerator("Cmd+,")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Reload App")
                .id("app_reload")
                .accelerator("Cmd+Shift+R")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::about(app, Some("About Prism"), None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("Services"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Prism"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Hide Others"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Show All"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Prism"))?)
        .build()?;

    // ── Windows/Linux app-name menu ───────────────────────────────────
    #[cfg(not(target_os = "macos"))]
    let app_menu = SubmenuBuilder::new(app, "Prism")
        .item(
            &MenuItemBuilder::new("Settings")
                .id("app_settings")
                .accelerator("Ctrl+,")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Reload App")
                .id("app_reload")
                .accelerator("Ctrl+Shift+R")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Prism"))?)
        .build()?;

    menu.append(&app_menu)?;
    menu.append(&file_menu)?;
    menu.append(&edit_menu)?;
    menu.append(&view_menu)?;
    menu.append(&help_menu)?;

    Ok(menu)
}

/// Wires menu-bar events to frontend messages or native actions.
pub fn setup_menu_handler(app: &App) {
    let handle = app.handle().clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();

        match id {
            // ── App menu ──────────────────────────────────────────────
            "app_settings" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://open-settings", ());
                }
            }
            "app_reload" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://reload-app", ());
                }
            }

            // ── File menu ─────────────────────────────────────────────
            "file_new_note" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://new-note", ());
                }
            }
            "file_new_folder" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://new-folder", ());
                }
            }
            "file_open_prism" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://open-prism", ());
                }
            }

            // ── View menu ─────────────────────────────────────────────
            "view_editor" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://set-layout", "editor");
                }
            }
            "view_graph" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://set-layout", "graph");
                }
            }
            "view_topics" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://set-layout", "topics");
                }
            }
            "view_ingestion_logs" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://toggle-ingestion-logs", ());
                }
            }
            "view_ai_sidebar" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://toggle-ai-sidebar", ());
                }
            }
            "view_sidebar" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://toggle-sidebar", ());
                }
            }

            // ── Help menu ─────────────────────────────────────────────
            "help_docs" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://open-url", "https://docs.prismapp.io");
                }
            }
            "help_discord" => {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.emit("menu://open-url", "https://discord.gg/prism");
                }
            }

            _ => {}
        }
    });
}

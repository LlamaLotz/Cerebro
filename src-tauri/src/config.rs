//! Runtime configuration bridge.
//!
//! The full `AppSettings` model (vault, AI, appearance, editor, linking,
//! system) is owned by Rust and persisted as JSON at `~/.cerebro/settings.json`
//! — the single source of truth. The frontend loads it over IPC on startup
//! (migrating legacy localStorage settings on first run) and saves it back
//! whenever the user hits Save in the Settings page.
//!
//! Field names use `#[serde(rename_all = "camelCase")]` so the wire format
//! matches the TypeScript `AppSettings` interface exactly — no mapping layer
//! needed on either side.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OmniRouteConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub inject_user_profile: bool,
    /// Free-form user context injected into AI system prompts when
    /// `inject_user_profile` is enabled.
    pub user_profile: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceConfig {
    pub startup_view: String,
    pub default_graph_mode: String,
    pub background_pattern: String,
    pub ai_panel_open_on_start: bool,
    pub sidebar_collapsed_on_start: bool,
    pub link_hub_visible_by_default: bool,
    pub link_hub_default_height: f64,
    pub label_quality: String,
    pub auto_rotate_on_load: bool,
    pub auto_rotate_speed: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    pub autosave_debounce_ms: u64,
    pub full_render_line_threshold: u64,
    pub find_debounce_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkingConfig {
    pub auto_link_on_save: bool,
    pub similarity_threshold: f32,
    pub embed_debounce_ms: u64,
    pub backfill_on_vault_open: bool,
    pub embedding_threads: usize,
    pub embedding_batch_size: usize,
    pub persist_node_positions: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfig {
    pub watch_vault: bool,
    pub sync_h1_on_startup: bool,
    pub version_retention_days: u64,
}

/// Full runtime configuration, wire-compatible with the frontend
/// `AppSettings` interface (camelCase keys).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub vault_path: String,
    pub ingestion_script: String,
    pub omni_route: OmniRouteConfig,
    pub appearance: AppearanceConfig,
    pub editor: EditorConfig,
    pub linking: LinkingConfig,
    pub system: SystemConfig,
}

impl Default for OmniRouteConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.omniroute.ai/v1".to_string(),
            model: "gpt-4o".to_string(),
            temperature: 0.7,
            inject_user_profile: false,
            user_profile: String::new(),
        }
    }
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            startup_view: "graph".to_string(),
            default_graph_mode: "3d".to_string(),
            background_pattern: "grid".to_string(),
            ai_panel_open_on_start: false,
            sidebar_collapsed_on_start: false,
            link_hub_visible_by_default: true,
            link_hub_default_height: 220.0,
            label_quality: "high".to_string(),
            auto_rotate_on_load: false,
            auto_rotate_speed: 0.67,
        }
    }
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            autosave_debounce_ms: 800,
            full_render_line_threshold: 8_000,
            find_debounce_ms: 1_000,
        }
    }
}

impl Default for LinkingConfig {
    fn default() -> Self {
        Self {
            auto_link_on_save: true,
            // Mirrors the engine's MIN_SIMILARITY_SCORE constant so the two
            // defaults can never drift apart.
            similarity_threshold: crate::engine::embeddings::MIN_SIMILARITY_SCORE,
            embed_debounce_ms: 4_000,
            backfill_on_vault_open: true,
            // fastembed intra-op thread cap (see vendor/fastembed patch).
            embedding_threads: 1,
            embedding_batch_size: crate::engine::embeddings::BACKFILL_BATCH_SIZE,
            persist_node_positions: true,
        }
    }
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            watch_vault: true,
            sync_h1_on_startup: true,
            version_retention_days: 0,
        }
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            vault_path: String::new(),
            ingestion_script: "python \"/Users/Shiver/Documents/Cerebro/Extractor Final/master_extractor.py\" --vault {vault_path}".to_string(),
            omni_route: OmniRouteConfig::default(),
            appearance: AppearanceConfig::default(),
            editor: EditorConfig::default(),
            linking: LinkingConfig::default(),
            system: SystemConfig::default(),
        }
    }
}

/// `~/.cerebro/settings.json` — same data directory as the SQLite index and
/// log files.
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".cerebro").join("settings.json"))
}

/// Loads the persisted config. Returns `None` when no file exists yet (first
/// run) or the file is corrupt — the caller falls back to legacy localStorage
/// settings and re-saves, so a corrupt file never bricks the app.
pub fn load_runtime_config(app: &tauri::AppHandle) -> Option<RuntimeConfig> {
    let path = config_path(app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Persists the config to disk (pretty-printed JSON for debuggability).
pub fn save_runtime_config(app: &tauri::AppHandle, config: &RuntimeConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw =
        serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to write config: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_config_roundtrips_camel_case() {
        let cfg = RuntimeConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();

        // Wire format must use camelCase keys matching the TS AppSettings
        // interface exactly — no mapping layer on either side.
        assert!(json.contains("\"vaultPath\""), "expected vaultPath key: {json}");
        assert!(json.contains("\"similarityThreshold\""));
        assert!(json.contains("\"embeddingThreads\""));
        assert!(json.contains("\"versionRetentionDays\""));
        assert!(json.contains("\"injectUserProfile\""));
        assert!(json.contains("\"backgroundPattern\""));
        assert!(json.contains("\"userProfile\""));

        let back: RuntimeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.appearance.background_pattern, "grid");
        assert_eq!(back.appearance.default_graph_mode, "3d");
        assert!((back.linking.similarity_threshold - 0.70).abs() < 1e-6);
        assert_eq!(back.linking.embedding_threads, 1);
        assert_eq!(back.system.version_retention_days, 0);
    }
}
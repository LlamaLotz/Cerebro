import { invoke } from '@tauri-apps/api/core';

export interface NoteFile {
  path: string;
  relativePath: string;
  name: string;
  title: string;
  // Metadata-only until the note is opened: `undefined` means "not loaded
  // yet" (and must be distinguished from a genuinely empty note, `""`).
  content?: string;
  updatedAt: number;
}

export interface WikiLink {
  targetTitle: string;
  alias?: string;
  blockId?: string;
  raw: string;
}

export interface GraphNode {
  id: string; // The note title
  title: string;
  exists: boolean;
  linksCount: number;
}

// Content-free graph snapshot served from the SQLite index (zero-IPC vault).
export interface GraphNodeMeta {
  id: string;
  title: string;
  exists: boolean;
}

export interface GraphLinkMeta {
  source: string;
  target: string;
}

export interface GraphPayload {
  nodes: GraphNodeMeta[];
  links: GraphLinkMeta[];
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface OmniRouteConfig {
  /** Provider id from the API provider registry (see apiProviders.ts). */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Chat sampling temperature (0..2) sent with every AI request. */
  temperature: number;
  /** When true, the user profile below is injected into AI system prompts. */
  injectUserProfile: boolean;
  /** Free-form user context prepended to AI prompts when injectUserProfile is on. */
  userProfile: string;
}

// Result of a full vault index: note metadata plus every folder under the
// vault (POSIX-style relative paths), including folders with no notes, so the
// sidebar can render the real folder structure.
export interface IndexedVault {
  files: NoteFile[];
  folders: string[];
}

// One entry in a note's version timeline: the original snapshot (versionId
// null) or a later delta, reconstructed to its full content so the frontend
// never has to apply patches.
// Shape returned by `get_all_reconstructed_versions`: Tauri serializes Rust
// struct fields as-is (snake_case), so these match the wire format exactly.
export interface ReconstructedVersion {
  note_path: string;
  version_id: number | null;
  content: string;
  created_at: string;
}

export interface AppSettings {
  vaultPath: string;
  ingestionScript: string;
  omniRoute: OmniRouteConfig & {
    temperature: number;
    injectUserProfile: boolean;
  };
  appearance: {
    startupView: 'graph' | 'editor' | 'split' | 'topics';
    defaultGraphMode: '2d' | '3d';
    backgroundPattern: 'grid' | 'mesh' | 'solid';
    aiPanelOpenOnStart: boolean;
    sidebarCollapsedOnStart: boolean;
    linkHubVisibleByDefault: boolean;
    linkHubDefaultHeight: number;
    labelQuality: 'standard' | 'high';
    autoRotateOnLoad: boolean;
    autoRotateSpeed: number;
    /** Brand accent color (hex) applied as the CSS --color-brand-* ramp. */
    accentColor: string;
    /** Color of the button/slider hover underglow (hex). */
    hoverGlowColor: string;
    /** Base color for knowledge-graph nodes (hex). */
    graphNodeColor: string;
    /** Custom app icon as a data URL (empty = default /logo.png). */
    appIcon: string;
    /** Status line beside the sidebar logo; supports {date} and {time} tokens. */
    sidebarStatusText: string;
  };
  editor: {
    autosaveDebounceMs: number;
    fullRenderLineThreshold: number;
    findDebounceMs: number;
  };
  linking: {
    autoLinkOnSave: boolean;
    similarityThreshold: number; // Rust MIN_SIMILARITY_SCORE (default 0.70)
    embedDebounceMs: number;
    backfillOnVaultOpen: boolean;
    embeddingThreads: number; // fastembed intra-op cap (default 1)
    embeddingBatchSize: number;
    persistNodePositions: boolean;
  };
  system: {
    watchVault: boolean;
    syncH1OnStartup: boolean;
    versionRetentionDays: number;
  };
}

// Unified API Wrapper mapping frontend calls to Tauri Rust commands
export const tauriAPI = {
  selectFile: async (): Promise<string | null> => {
    return await invoke<string | null>('select_file');
  },
  selectFolder: async (): Promise<string | null> => {
    return await invoke<string | null>('select_folder');
  },
  // Indexes the vault in Rust (bounded worker pool) and returns lightweight
  // metadata WITHOUT contents (`content` is absent). Note contents are fetched
  // lazily via `readFile` when opened; the Editor/App normalize `undefined`
  // to an empty string where needed. Also returns every folder under the
  // vault (incl. empty ones) so the sidebar can render the real tree.
  indexVault: async (vaultPath: string): Promise<IndexedVault> => {
    return await invoke<IndexedVault>('index_vault', { vaultPath });
  },
  // Content-free knowledge graph (nodes + edges) straight from SQLite.
  getGraph: async (): Promise<GraphPayload> => {
    return await invoke<GraphPayload>('get_graph');
  },
  readFile: async (filePath: string): Promise<string> => {
    return await invoke<string>('read_file', { filePath });
  },
  // Space-optimized delta version history: records a snapshot only when the
  // frontend explicitly asks (explicit save, note switch/unmount, formatter
  // run, 30s idle debounce) — never per autosave.
  recordNoteVersion: async (notePath: string, content: string): Promise<number | null> => {
    return await invoke<number | null>('record_note_version', { notePath, content });
  },
  // Full version timeline for a note (base snapshot + every delta, each
  // reconstructed to its full content). Powers the Time Machine restore UI.
  getNoteVersionHistory: async (notePath: string): Promise<ReconstructedVersion[]> => {
    return await invoke<ReconstructedVersion[]>('get_all_reconstructed_versions', { notePath });
  },
  renameFolder: async (data: { vaultPath: string; oldRelativePath: string; newRelativePath: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      await invoke('rename_folder', {
        vaultPath: data.vaultPath,
        oldRelativePath: data.oldRelativePath,
        newRelativePath: data.newRelativePath,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  writeFile: async (data: { filePath: string; content: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      await invoke('write_file', { filePath: data.filePath, content: data.content });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  createFile: async (data: { vaultPath: string; relativePath: string; content?: string }): Promise<{ success: boolean; fullPath?: string; error?: string }> => {
    try {
      const fullPath = await invoke<string>('create_file', { 
        vaultPath: data.vaultPath, 
        relativePath: data.relativePath, 
        content: data.content 
      });
      return { success: true, fullPath };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  deleteFile: async (filePath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await invoke('delete_file', { filePath });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  createFolder: async (data: { vaultPath: string; relativePath: string }): Promise<{ success: boolean; fullPath?: string; error?: string }> => {
    try {
      const fullPath = await invoke<string>('create_folder', {
        vaultPath: data.vaultPath,
        relativePath: data.relativePath,
      });
      return { success: true, fullPath };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  deleteFolder: async (data: { vaultPath: string; relativePath: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      await invoke('delete_folder', {
        vaultPath: data.vaultPath,
        relativePath: data.relativePath,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  renameFile: async (data: { oldPath: string; newPath: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      await invoke('rename_file', { oldPath: data.oldPath, newPath: data.newPath });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },
  runIngestionScript: async (data: { scriptCommand: string; vaultPath: string }): Promise<{ success: boolean; output: string }> => {
    try {
      const output = await invoke<string>('run_ingestion_script', { 
        scriptCommand: data.scriptCommand, 
        vaultPath: data.vaultPath 
      });
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: err.toString() };
    }
  },
  runBuiltinExtractorAsync: async (data: { vaultPath: string; ingestType: 'url' | 'file'; value: string; ytMethod: string }): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const output = await invoke<string>('run_builtin_extractor_async', {
        vaultPath: data.vaultPath,
        ingestType: data.ingestType,
        value: data.value,
        ytMethod: data.ytMethod,
      });
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: err.toString(), error: err.toString() };
    }
  },
  runBuiltinExtractor: async (data: { vaultPath: string; ingestType: 'url' | 'file'; value: string }): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const output = await invoke<string>('run_builtin_extractor', {
        vaultPath: data.vaultPath,
        ingestType: data.ingestType,
        value: data.value,
      });
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: err.toString() };
    }
  },
  runExtractorInstaller: async (): Promise<{ success: boolean; output: string }> => {
    try {
      const output = await invoke<string>('run_extractor_installer');
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: err.toString() };
    }
  },
  appendIngestionLog: async (level: string, message: string): Promise<void> => {
    try {
      await invoke('append_ingestion_log', { level, message });
    } catch (err) {
      console.error('Failed to append ingestion log file entry:', err);
    }
  },
  // --- Rust runtime config bridge ------------------------------------------
  // Settings are persisted by Rust to ~/.prism/settings.json (single source
  // of truth), with localStorage kept only as a legacy migration source.
  // Returns null when no config file exists yet (first run / corrupt file) so
  // the frontend can migrate legacy localStorage settings before saving.
  getRuntimeConfig: async (): Promise<AppSettings | null> => {
    return await invoke<AppSettings | null>('get_runtime_config');
  },
  // Persists the full settings object and hot-applies the runtime-tunable
  // values (similarity threshold, embedding batch) on the Rust side.
  saveRuntimeConfig: async (settings: AppSettings): Promise<void> => {
    await invoke('save_runtime_config', { config: settings });
  },
  // Deletes version-history rows older than `retentionDays` (0 = keep all).
  purgeExpiredHistory: async (retentionDays: number): Promise<void> => {
    await invoke('purge_expired_history', { retentionDays });
  },
  // Fully closes Prism and starts a fresh instance (real process restart, not
  // a webview reload). Never resolves on success — the process exits.
  relaunchApp: async (): Promise<void> => {
    await invoke('relaunch_app');
  },
  onVaultChanged: (callback: (data: { eventType: string; filename: string }) => void) => {
    // Return unsubscribe no-op since UI action saves trigger list refresh directly
    return () => {};
  },
  isElectron: false,
};

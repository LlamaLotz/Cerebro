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
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AppSettings {
  vaultPath: string;
  ingestionScript: string;
  omniRoute: OmniRouteConfig;
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
  // to an empty string where needed.
  indexVault: async (vaultPath: string): Promise<NoteFile[]> => {
    return await invoke<NoteFile[]>('index_vault', { vaultPath });
  },
  // Content-free knowledge graph (nodes + edges) straight from SQLite.
  getGraph: async (): Promise<GraphPayload> => {
    return await invoke<GraphPayload>('get_graph');
  },
  readFile: async (filePath: string): Promise<string> => {
    return await invoke<string>('read_file', { filePath });
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
  onVaultChanged: (callback: (data: { eventType: string; filename: string }) => void) => {
    // Return unsubscribe no-op since UI action saves trigger list refresh directly
    return () => {};
  },
  isElectron: false,
};

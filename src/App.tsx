import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { Editor } from './components/Editor';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GraphViewContainer } from './components/GraphViewContainer';
import { TopicsView } from './components/TopicsView';
import { AISidebar } from './components/AISidebar';
import { SettingsModal } from './components/SettingsModal';
import { IngestModal } from './components/IngestModal';
import { IngestionLogPanel } from './components/IngestionLogPanel';
import { useIngestion } from './services/ingestionStore';
import { AppSettings, NoteFile, GraphNode, GraphLink, GraphPayload, tauriAPI } from './types';
import { listen } from '@tauri-apps/api/event';
import { linkerService } from './services/linkerService';
import { backfillEmbeddings, generateAndStoreEmbedding, generateAndStoreBlockEmbeddings } from './services/semantic';
import { appLogger } from './services/appLogger';
import { formatNote, noteTitleMatches } from './utils/formatter';
import { ResizeHandle } from './components/ResizeHandle';
import { ContextMenu } from './components/ContextMenu';
import { useDialog } from './components/DialogProvider';
import { FileText, Network, PanelLeftClose, PanelLeftOpen, SplitSquareVertical, Sparkles, Tags } from 'lucide-react';

const LOCAL_STORAGE_KEY = 'cerebro_app_settings';

// Reconstructs the D3 graph from the SQLite-served snapshot, adding uncreated
// nodes for any linked-but-missing titles (same semantics as buildGraphData).
function buildGraphFromPayload(payload: GraphPayload): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of payload.nodes) {
    nodeMap.set(n.title.toLowerCase(), {
      id: n.title,
      title: n.title,
      exists: true,
      linksCount: 0,
    });
  }
  const links: GraphLink[] = [];
  const linkSet = new Set<string>();
  for (const l of payload.links) {
    if (l.source.toLowerCase() === l.target.toLowerCase()) continue;
    // Dedup case-insensitively (both directions) so a graph refresh never
    // double-counts an edge that differs only in title casing.
    const key = `${l.source.toLowerCase()} -> ${l.target.toLowerCase()}`;
    const reverseKey = `${l.target.toLowerCase()} -> ${l.source.toLowerCase()}`;
    if (linkSet.has(key) || linkSet.has(reverseKey)) continue;
    linkSet.add(key);
    // Both endpoints MUST exist as nodes: d3-force's forceLink throws
    // "node not found: <id>" when a link references an id that isn't in the
    // simulation's node set, which crashes the whole graph pane. The Rust
    // snapshot can race a full re-index (split/rename), so a link's source
    // may reference a note whose node hasn't landed yet — drop the link
    // rather than feed d3 a dangling reference. Missing targets become
    // uncreated (dashed) nodes, same as before.
    const sourceNode = nodeMap.get(l.source.toLowerCase());
    if (!sourceNode) continue;
    let targetNode = nodeMap.get(l.target.toLowerCase());
    if (!targetNode) {
      targetNode = {
        id: l.target,
        title: l.target,
        exists: false,
        linksCount: 0,
      };
      nodeMap.set(l.target.toLowerCase(), targetNode);
    }
    // Use each node's canonical id (NOT the raw link text) for the edge:
    // the SQL snapshot resolves targets from the raw [[wiki-link]] text
    // (which keeps its own casing), while node ids come from the note
    // title/file stem. d3 matches ids exactly, so a "Introduction" vs
    // "introduction" mismatch would throw "node not found" too.
    links.push({ source: sourceNode.id, target: targetNode.id });
    sourceNode.linksCount += 1;
    targetNode.linksCount += 1;
  }
  return { nodes: Array.from(nodeMap.values()), links };
}

const DEFAULT_SETTINGS: AppSettings = {
  vaultPath: '',
  ingestionScript: 'python "/Users/Shiver/Documents/Cerebro/Extractor Final/master_extractor.py" --vault {vault_path}',
  omniRoute: {
    apiKey: '',
    baseUrl: 'https://api.omniroute.ai/v1',
    model: 'gpt-4o',
  },
};

export default function App() {
  // Cerebro's own dialog system (replaces native alert/confirm/prompt).
  const { alert, confirm, prompt } = useDialog();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  // Every folder under the vault (incl. empty ones), POSIX-style relative
  // paths, from the indexer — drives the sidebar's folder tree.
  const [folders, setFolders] = useState<string[]>([]);
  const [activeNote, setActiveNote] = useState<NoteFile | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isIngestModalOpen, setIsIngestModalOpen] = useState(false);
  
  // Layout views: 'editor' | 'graph' | 'split' | 'topics'
  const [layout, setLayout] = useState<'editor' | 'graph' | 'split' | 'topics'>('split');
  const [showAICoPilot, setShowAICoPilot] = useState(true);
  // Requested block scroll (blockId or 1-based line + timestamp), passed to the Editor.
  const [scrollRequest, setScrollRequest] = useState<{ blockId?: string; line?: number; ts: number } | null>(null);

  // Persisted panel sizes
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cerebro_sidebar_width'));
    return Number.isFinite(saved) && saved > 0 ? saved : 264;
  });
  const [aiWidth, setAiWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cerebro_ai_width'));
    return Number.isFinite(saved) && saved > 0 ? saved : 320;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('cerebro_sidebar_collapsed') === 'true'
  );

  // Custom dark context menu position (null = hidden). The default
  // WebView2/Edge right-click menu is disabled app-wide; see the effect below.
  // Right-click menu: position + which region it opened in. `region` decides
  // the menu contents (sidebar = folder actions, editor = text actions) and
  // whether a menu shows at all (graph/topics = none). When the right-click
  // lands on a specific note/folder row (`target`), the menu shows that
  // item's rename/delete actions instead of the generic folder actions.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    region: 'sidebar' | 'editor' | 'none';
    target?: { type: 'note' | 'folder'; path: string };
  } | null>(null);
  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('cerebro_sidebar_collapsed', String(next));
      return next;
    });
  };

  // Debounced, coalesced semantic embedding generation on save: rapid saves
  // (autosave every ~800ms while typing) collapse into a single embedding job
  // that runs only after the user pauses, and never overlaps itself per note.
  const EMBED_DEBOUNCE_MS = 4000;
  const embedTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const embedInFlightRef = useRef<Record<string, boolean>>({});
  const embedContentRef = useRef<Record<string, string>>({});
  const scheduleEmbedding = (filePath: string, content: string) => {
    embedContentRef.current[filePath] = content;
    if (embedTimersRef.current[filePath]) {
      clearTimeout(embedTimersRef.current[filePath]);
    }
    embedTimersRef.current[filePath] = setTimeout(() => {
      delete embedTimersRef.current[filePath];
      if (embedInFlightRef.current[filePath]) return;
      embedInFlightRef.current[filePath] = true;
      const latest = embedContentRef.current[filePath] ?? content;
      Promise.all([
        generateAndStoreEmbedding(filePath, latest),
        generateAndStoreBlockEmbeddings(filePath, latest),
      ]).finally(() => {
        embedInFlightRef.current[filePath] = false;
        delete embedContentRef.current[filePath];
        // Embeddings changed: nudge the Editor so its semantic/block suggestion
        // lists re-query and drop stale entries (e.g. deleted blocks).
        setSemanticTick((t) => t + 1);
      });
    }, EMBED_DEBOUNCE_MS);
  };


  const saveSidebarWidth = (w: number) => {
    setSidebarWidth(w);
    localStorage.setItem('cerebro_sidebar_width', String(w));
  };
  const saveAiWidth = (w: number) => {
    setAiWidth(w);
    localStorage.setItem('cerebro_ai_width', String(w));
  };

  const { addLog, updateProgress } = useIngestion();

  // Debounced snapshot of the graph inputs: updates immediately on note switch,
  // but only after a typing pause (1s) when the active note is being edited,
  // so the D3 force simulation is not rebuilt on every keystroke.
  const [graphActiveNote, setGraphActiveNote] = useState<NoteFile | null>(null);
  const graphDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graphNotePathRef = useRef<string | null>(null);
  const backfillRanRef = useRef(false);
  const h1SyncRanRef = useRef<string | null>(null);
  const watcherStartedRef = useRef<string | null>(null);
  // Content-free graph snapshot served from SQLite (zero-IPC force graph).
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({
    nodes: [],
    links: [],
  });
  // Incremented when the once-per-session semantic backfill completes, so the
  // Related Notes panel knows embeddings now exist and refreshes itself.
  const [semanticTick, setSemanticTick] = useState(0);

  const loadGraph = () => {
    tauriAPI
      .getGraph()
      .then((payload) => setGraphData(buildGraphFromPayload(payload)))
      .catch((e) => {
        console.error('Failed to load graph:', e);
        appLogger.error('Failed to load graph', e);
      });
  };

  useEffect(() => {
    if (graphDebounceRef.current) clearTimeout(graphDebounceRef.current);
    if (!activeNote) {
      graphNotePathRef.current = null;
      setGraphActiveNote(null);
      loadGraph();
      return;
    }
    if (graphNotePathRef.current !== activeNote.path) {
      graphNotePathRef.current = activeNote.path;
      setGraphActiveNote(activeNote);
      loadGraph();
      return;
    }
    graphDebounceRef.current = setTimeout(() => {
      setGraphActiveNote(activeNote);
      loadGraph();
    }, 1000);
  }, [activeNote, notes]);

  // Disable the default browser/WebView2 right-click menu app-wide and show
  // the custom dark context menu only where it makes sense: the sidebar gets
  // folder actions, the editor keeps the text actions, and the graph/topics
  // panes get no menu at all. Regions are marked with `data-region` on the
  // root of each pane.
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault(); // Disables Edge / WKWebView default right-click menu
      const el = e.target as Element | null;
      const region = el?.closest('[data-region]')?.getAttribute('data-region');
      if (region === 'graph' || region === 'topics') {
        // No right-click menu on the graph / tags panes — swallow it.
        setCtxMenu(null);
        return;
      }
      // Right-clicking a note/folder row targets that item: rename/delete
      // actions on the item itself (the sidebar rows carry data-note-path /
      // data-folder-path so the menu knows which entry was hovered).
      const noteRow = el?.closest('[data-note-path]') as HTMLElement | null;
      if (noteRow) {
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          region: 'sidebar',
          target: { type: 'note', path: noteRow.dataset.notePath || '' },
        });
        return;
      }
      const folderRow = el?.closest('[data-folder-path]') as HTMLElement | null;
      if (folderRow) {
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          region: 'sidebar',
          target: { type: 'folder', path: folderRow.dataset.folderPath || '' },
        });
        return;
      }
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        region: region === 'sidebar' ? 'sidebar' : 'editor',
      });
    };
    const closeMenu = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', closeMenu);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (graphDebounceRef.current) clearTimeout(graphDebounceRef.current);
      Object.values(embedTimersRef.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  // 1. Load settings from localStorage on startup
  useEffect(() => {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // Deep merge with defaults to ensure missing properties don't cause crashes
        const merged: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          omniRoute: {
            ...DEFAULT_SETTINGS.omniRoute,
            ...(parsed.omniRoute || {}),
          },
        };
        setSettings(merged);
      } catch (e) {
        console.error('Failed to parse localStorage settings:', e);
        appLogger.error('Failed to parse localStorage settings', e);
      }
    }
  }, []);

  // 2. Fetch files from designated Notes Directory when vaultPath or settings change
  const fetchNotes = async (customPath?: string) => {
    const path = customPath !== undefined ? customPath : settings.vaultPath;
    if (!path) {
      setNotes([]);
      setFolders([]);
      return;
    }
    
    try {
      // Rust streams the vault through a bounded worker pool and returns
      // lightweight metadata (no contents) — no IPC flood, no full-vault
      // buffering. Note contents are lazy-loaded when opened. Folders (incl.
      // empty ones) come along so the sidebar renders the real tree.
      const { files, folders: vaultFolders } = await tauriAPI.indexVault(path);
      setFolders(vaultFolders);
      // Sort notes alphabetically by title
      const sorted = [...files].sort((a, b) => a.title.localeCompare(b.title));
      
      // Apply custom order if it exists, otherwise alphabetical
      const savedOrderRaw = localStorage.getItem(`cerebro_order_${path}`);
      let finalNotes: NoteFile[] = sorted;
      if (savedOrderRaw) {
        try {
          const savedOrder: string[] = JSON.parse(savedOrderRaw);
          const orderedNotes: NoteFile[] = [];
          const remainingNotes = [...sorted];
          for (const p of savedOrder) {
            const idx = remainingNotes.findIndex(n => n.path === p);
            if (idx !== -1) {
              orderedNotes.push(remainingNotes[idx]);
              remainingNotes.splice(idx, 1);
            }
          }
          finalNotes = [...orderedNotes, ...remainingNotes];
        } catch (e) {
          finalNotes = sorted;
        }
      }
      
      appLogger.info(`Vault indexed: ${sorted.length} notes (${path})`);

      // Startup sync: if a note's H1 doesn't match its filename (e.g. it was
      // renamed outside Cerebro), rewrite the H1 to match. Runs once per vault.
      // Contents are read one file at a time (they aren't bundled anymore).
      if (h1SyncRanRef.current !== path) {
        h1SyncRanRef.current = path;
        for (const n of sorted) {
          if (!n.title) continue;
          const c = await tauriAPI.readFile(n.path).catch(() => '');
          if (c && !noteTitleMatches(c, n.title)) {
            const formatted = formatNote(c, n.title);
            if (formatted !== c) {
              try {
                await tauriAPI.writeFile({ filePath: n.path, content: formatted });
              } catch (e) {
                console.error(`Failed to sync H1 for "${n.title}":`, e);
              }
            }
          }
        }
      }

      setNotes(finalNotes);
      // The SQLite index is fully populated by `index_vault` above, so the
      // backfill can query it immediately.
      if (!backfillRanRef.current) {
        backfillRanRef.current = true;
        const count = await backfillEmbeddings();
        console.log(`Semantic backfill complete: ${count} notes embedded.`);
        // Refresh the Related Notes panel now that embeddings exist
        setSemanticTick((t) => t + 1);
      }

      // Keep the index in sync reactively as files change on disk (once per vault)
      if (watcherStartedRef.current !== path) {
        watcherStartedRef.current = path;
        try {
          await linkerService.startWatchingVault(path);
        } catch (err) {
          console.error('Failed to start vault watcher:', err);
        }
      }

      // Keep activeNote updated with refreshed files
      if (activeNote) {
        const currentActive = sorted.find((n) => n.path === activeNote.path);
        if (currentActive) {
          setActiveNote(currentActive);
        } else {
          setActiveNote(null);
        }
      }
    } catch (err) {
      console.error('Error reading vault files:', err);
    }
  };

  useEffect(() => {
    fetchNotes();
  }, [settings.vaultPath]);

  // React to watcher events for OTHER notes (self-writes are masked in Rust,
  // so these are external edits/deletes). Refresh the list (debounced) so a
  // note deleted on disk disappears from the sidebar instead of lingering as
  // a ghost, and externally created/edited notes appear.
  const vaultRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!settings.vaultPath) return;
    const unlisten = listen('vault-changed', (event) => {
      const payload = (event.payload ?? {}) as { path?: string; kind?: string };
      if (!payload.path) return;
      if (vaultRefreshDebounceRef.current) clearTimeout(vaultRefreshDebounceRef.current);
      vaultRefreshDebounceRef.current = setTimeout(() => {
        vaultRefreshDebounceRef.current = null;
        fetchNotes();
      }, 400);
    });
    return () => {
      unlisten.then((fn) => fn());
      if (vaultRefreshDebounceRef.current) clearTimeout(vaultRefreshDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.vaultPath]);

  // Lazy-load the active note's contents (index_vault returns metadata only,
  // so `content` is undefined until loaded — an empty note loads as `""`).
  // Guard on `typeof content === 'string'` (NOT truthiness) so genuinely
  // empty notes don't re-trigger reads forever: `""` is a string, undefined
  // is not. Deps are `path` + `content`: a refresh that replaces the active
  // note with a fresh metadata-only object (content: undefined) re-fires the
  // load, while saves/typing (content: string) are no-ops.
  useEffect(() => {
    if (!activeNote || typeof activeNote.content === 'string') return;
    let cancelled = false;
    tauriAPI
      .readFile(activeNote.path)
      .then((content) => {
        if (cancelled) return;
        setActiveNote((prev) =>
          prev && prev.path === activeNote.path ? { ...prev, content } : prev
        );
        setNotes((prev) =>
          prev.map((n) => (n.path === activeNote.path ? { ...n, content } : n))
        );
      })
      .catch((e) => {
        console.error('Failed to load note content:', e);
        appLogger.error(`Failed to load note content: ${activeNote.path}`, e);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNote?.path, activeNote?.content]);

  // 3. Save Settings Handler
  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newSettings));
  };

  // 4. Folder Select Trigger
  const handleSelectVault = async () => {
    const path = await tauriAPI.selectFolder();
    if (path) {
      const updated = { ...settings, vaultPath: path };
      handleSaveSettings(updated);
    }
  };

  // 5. Native Ingest Engine Action
  const handleRunIngest = async (type: 'url' | 'file', value: string, method: string = 'yt-dlp') => {
    if (!settings.vaultPath) {
      await alert('Please connect a notes vault folder in settings first.', {
        title: 'No vault connected',
      });
      return;
    }

    setIsIngesting(true);
    appLogger.info(`Ingestion started: ${type} (${value.slice(0, 120)})`);
    addLog({ level: 'info', message: 'Initializing ingestion pipeline...' });
    updateProgress({ status: 'ingesting', current: 0, total: 0, currentFileName: '' });

    const args: any = {
      vaultPath: settings.vaultPath,
      ingestType: type,
      value,
    };

    // Always pass a method, map file-mode to ytMethod slot for rust compatibility
    args.ytMethod = method;

    try {
      // Background output is collected by the IngestionProvider listeners
      // (ingestion-progress / ingestion-error) while the panel is minimized.
      const result = await tauriAPI.runBuiltinExtractorAsync(args);

      if (result.success) {
        addLog({ level: 'success', message: 'DONE: ' + result.output });
        updateProgress({ status: 'completed' });
        appLogger.info(`Ingestion completed: ${type}`);
      } else {
        addLog({ level: 'error', message: 'FAILED: ' + (result.error || result.output) });
        updateProgress({ status: 'error' });
        appLogger.error(`Ingestion failed: ${type}`, new Error(result.error || result.output));
      }
    } catch (err) {
      addLog({ level: 'error', message: `Critical error: ${err}` });
      updateProgress({ status: 'error' });
      appLogger.error(`Ingestion critical error: ${type}`, err);
    } finally {
      setIsIngesting(false);
      // Small delay to allow OS filesystem to finalize writes before refreshing notes
      setTimeout(async () => {
        await fetchNotes();
      }, 500);
    }
  };

  // 6. Save Note content (autosave blurs or keys)
  const handleSaveContent = async (filePath: string, content: string) => {
    const result = await tauriAPI.writeFile({ filePath, content });
    if (result.success) {
      // Inline update state so editor doesn't flicker or lose focus
      setNotes((prevNotes) =>
        prevNotes.map((note) =>
          note.path === filePath ? { ...note, content } : note
        )
      );
      if (activeNote && activeNote.path === filePath) {
        setActiveNote((prev) => (prev ? { ...prev, content } : null));
      }

      // Keep the semantic index warm on save (debounced + coalesced so
      // rapid autosaves collapse into a single embedding job per note)
      scheduleEmbedding(filePath, content);
      appLogger.info(`Note saved: ${filePath}`);
    } else {
      console.error('Failed to write file:', result.error);
      appLogger.error(`Failed to write note: ${filePath}`, new Error(result.error));
    }
  };

  // 7. Create New Note
  const handleNewNote = async () => {
    if (!settings.vaultPath) return;

    const titleInput = await prompt('Enter new note title:', {
      initialValue: 'Untitled Note',
      title: 'New note',
    });
    if (titleInput === null) return; // cancelled

    const formattedTitle = titleInput.trim() || 'Untitled Note';
    const relativePath = `${formattedTitle}.md`;

    // Prevent duplicate files
    const alreadyExists = notes.some((n) => n.title.toLowerCase() === formattedTitle.toLowerCase());
    if (alreadyExists) {
      await alert(`A note named "${formattedTitle}" already exists!`, {
        title: 'Duplicate note',
      });
      return;
    }

    const result = await tauriAPI.createFile({
      vaultPath: settings.vaultPath,
      relativePath,
      content: `# ${formattedTitle}\n\nStart writing here...`,
    });

    if (result.success && result.fullPath) {
      const { files, folders: vaultFolders } = await tauriAPI.indexVault(settings.vaultPath);
      setFolders(vaultFolders);
      const sorted = [...files].sort((a, b) => a.title.localeCompare(b.title));
      setNotes(sorted);
      appLogger.info(`Note created: ${formattedTitle} (${result.fullPath})`);
      
      const newNote = sorted.find((n) => n.path === result.fullPath);
      if (newNote) {
        handleSelectNote(newNote);
        // Switch to editor mode to start editing immediately
        if (layout === 'graph' || layout === 'topics') setLayout('split');
      }
    } else {
      await alert(`Error creating note: ${result.error}`, { title: 'Could not create note' });
      appLogger.error(`Failed to create note: ${formattedTitle}`, new Error(result.error));
    }
  };

  // Create a folder in the vault (nested paths like "Projects/Book" work).
  const handleNewFolder = async () => {
    if (!settings.vaultPath) return;
    const name = await prompt('Enter folder name (nested paths work, e.g. Projects/Book):', {
      title: 'New folder',
    });
    if (!name?.trim()) return;
    const res = await tauriAPI.createFolder({
      vaultPath: settings.vaultPath,
      relativePath: name.trim(),
    });
    if (!res.success) {
      await alert(`Error creating folder: ${res.error ?? 'unknown error'}`, {
        title: 'Could not create folder',
      });
    } else {
      fetchNotes();
    }
  };

  // Delete a folder and EVERYTHING inside it. Double-gated: a name prompt
  // (so typos can't nuke a folder by accident) followed by a warning that
  // lists how many notes live inside. When called from a folder pill in the
  // sidebar, `folderPath` is already known, so the name prompt is skipped and
  // only the confirmation warning shows.
  const handleDeleteFolder = async (folderPath?: string) => {
    if (!settings.vaultPath) return;
    let rel = folderPath?.trim().replace(/^[\\/]+|[\\/]+$/g, '');
    if (!rel) {
      const name = await prompt('Enter the folder to delete (relative to the vault, e.g. Projects/Book):', {
        title: 'Delete folder',
      });
      if (!name?.trim()) return;
      rel = name.trim().replace(/^[\\/]+|[\\/]+$/g, '');
    }
    if (!rel) return;
    const noteCount = notes.filter((n) =>
      n.relativePath.replace(/\\/g, '/').startsWith(`${rel}/`)
    ).length;
    const ok = await confirm(
      `Delete the folder \"${rel}\"?\n\n` +
        `This will permanently delete the folder and ALL its contents ` +
        `(${noteCount} note${noteCount === 1 ? '' : 's'} and any other files).\n` +
        `This cannot be undone.`,
      { title: 'Delete folder', confirmLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    const res = await tauriAPI.deleteFolder({ vaultPath: settings.vaultPath, relativePath: rel });
    if (!res.success) {
      await alert(`Error deleting folder: ${res.error ?? 'unknown error'}`, {
        title: 'Could not delete folder',
      });
    } else {
      fetchNotes();
    }
  };

  // Rename a folder (and everything inside it). The folder path is passed
  // from the sidebar pill/context menu; only the leaf name is prompted.
  const handleRenameFolder = async (folderPath?: string) => {
    if (!settings.vaultPath || !folderPath) return;
    const rel = folderPath.trim().replace(/^[\\/]+|[\\/]+$/g, '');
    if (!rel) return;
    const leaf = rel.split(/[\\/]/).pop() || rel;
    const newNameInput = await prompt(`Rename folder \"${leaf}\" to:`, {
      initialValue: leaf,
      title: 'Rename folder',
    });
    if (newNameInput === null) return;
    const formatted = newNameInput.trim();
    if (!formatted || formatted === leaf) return;
    const newRel = rel.slice(0, rel.length - leaf.length) + formatted;
    const res = await tauriAPI.renameFolder({
      vaultPath: settings.vaultPath,
      oldRelativePath: rel,
      newRelativePath: newRel,
    });
    if (!res.success) {
      await alert(`Error renaming folder: ${res.error ?? 'unknown error'}`, {
        title: 'Could not rename folder',
      });
    } else {
      fetchNotes();
    }
  };

  // 8. Delete note file
  const handleDeleteNote = async (note: NoteFile) => {
    const confirmDelete = await confirm(
      `Are you sure you want to delete "${note.title}"? This cannot be undone.`,
      { title: 'Delete note', confirmLabel: 'Delete', danger: true }
    );
    if (!confirmDelete) return;

    const result = await tauriAPI.deleteFile(note.path);
    if (result.success) {
      if (activeNote?.path === note.path) {
        setScrollRequest(null);
        setActiveNote(null);
      }
      await fetchNotes();
      appLogger.info(`Note deleted: ${note.title} (${note.path})`);
    } else {
      await alert(`Error deleting note: ${result.error}`, { title: 'Could not delete note' });
      appLogger.error(`Failed to delete note: ${note.title}`, new Error(result.error));
    }
  };

  // 9. Rename note file
  const handleRenameNote = async (note: NoteFile) => {
    const newTitleInput = await prompt(`Rename "${note.title}" to:`, {
      initialValue: note.title,
      title: 'Rename note',
    });
    if (newTitleInput === null) return;

    const formattedNewTitle = newTitleInput.trim();
    if (!formattedNewTitle || formattedNewTitle === note.title) return;

    // Split on the last separator (works for both Windows '\' and POSIX '/' paths)
    const sepIndex = Math.max(note.path.lastIndexOf('/'), note.path.lastIndexOf('\\'));
    const folder = sepIndex >= 0 ? note.path.substring(0, sepIndex) : '';
    const newPath = folder ? `${folder}/${formattedNewTitle}.md` : `${formattedNewTitle}.md`;

    const result = await tauriAPI.renameFile({
      oldPath: note.path,
      newPath,
    });

    if (result.success) {
      // Keep the H1 title in sync with the new filename. Content is
      // lazy-loaded (metadata-only) so fetch the real body if it's not
      // already in memory, otherwise the rewrite would clobber the file.
      let currentContent = note.content;
      if (!currentContent) {
        currentContent = await tauriAPI.readFile(newPath).catch(() => '');
      }
      const formatted = formatNote(currentContent, formattedNewTitle);
      if (formatted !== currentContent) {
        try {
          await tauriAPI.writeFile({ filePath: newPath, content: formatted });
        } catch (e) {
          console.error('Failed to sync H1 after rename:', e);
          appLogger.error(`Failed to sync H1 after rename: ${note.title}`, e);
        }
      }
      await fetchNotes();
      // Keep the note's position in the persisted custom order (the path
      // changed, so swap the old path for the new one).
      const orderKey = `cerebro_order_${settings.vaultPath}`;
      const orderRaw = localStorage.getItem(orderKey);
      if (orderRaw) {
        try {
          const order: string[] = JSON.parse(orderRaw);
          const idx = order.findIndex((p) => p === note.path);
          if (idx !== -1) {
            order[idx] = newPath;
            localStorage.setItem(orderKey, JSON.stringify(order));
          }
        } catch (e) {
          // ignore malformed order
        }
      }
      appLogger.info(`Note renamed: ${note.title} -> ${formattedNewTitle} (${newPath})`);
    } else {
      await alert(`Error renaming note: ${result.error}`, { title: 'Could not rename note' });
      appLogger.error(`Failed to rename note: ${note.title}`, new Error(result.error));
    }
  };

  // 10. Reorder note file
  const handleMoveNote = async (note: NoteFile, direction: 'up' | 'down') => {
    const currentIndex = notes.findIndex((n) => n.path === note.path);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= notes.length) return;

    const newNotes = [...notes];
    const temp = newNotes[currentIndex];
    newNotes[currentIndex] = newNotes[newIndex];
    newNotes[newIndex] = temp;

    setNotes(newNotes);
    // Persist order
    localStorage.setItem(`cerebro_order_${settings.vaultPath}`, JSON.stringify(newNotes.map(n => n.path)));
  };

  // Plain note selection (sidebar/new/delete): never a block jump, so clear
  // any stale scrollRequest from a previous wiki-link traversal — otherwise
  // the Editor's jump effect would re-fire against the newly opened note.
  const handleSelectNote = (note: NoteFile) => {
    setScrollRequest(null);
    setActiveNote(note);
    appLogger.info(`Note opened: ${note.title}`);
  };

  // 10. Wiki link traversal & automatic connection note creation
  const handleWikiLinkClick = async (targetTitle: string, blockId?: string, line?: number) => {
    // Trim a trailing .md extension so [label](Note.md) resolves like [[Note]]
    const resolvedTitle = targetTitle.trim().replace(/\.md$/i, '');

    // Look for matching note (case-insensitive). An empty target means a
    // same-note link (e.g. [[#^block-id]] / [label](#^block-id)): resolve it
    // against the note that is currently open.
    let matched: NoteFile | null = null;
    if (resolvedTitle) {
      matched = notes.find((n) => n.title.toLowerCase() === resolvedTitle.toLowerCase()) ?? null;
    } else if (activeNote) {
      matched = activeNote;
    }

    if (matched) {
      setActiveNote(matched);
      if (layout === 'graph' || layout === 'topics') setLayout('split');
      if (blockId || line) {
        setScrollRequest({ blockId, line, ts: Date.now() });
        console.log('[nav] scrollRequest set', { blockId, line, note: matched.title });
        appLogger.info(`Link navigation (block jump): ${matched.title}${blockId ? ` #${blockId}` : ` line ${line}`}`);
      } else {
        console.log('[nav] plain note navigation (no block) ->', matched.title);
        appLogger.info(`Link navigation: ${matched.title}`);
      }
    } else {
      // Note doesn't exist yet! Ask user to create it (Obsidian connection model!)
      const confirmCreate = await confirm(
        `Note "${targetTitle}" does not exist yet.\nWould you like to create it and connect them?`,
        { title: 'Create connected note', confirmLabel: 'Create & connect' }
      );

      if (confirmCreate && settings.vaultPath) {
        const relativePath = `${targetTitle}.md`;
        const result = await tauriAPI.createFile({
          vaultPath: settings.vaultPath,
          relativePath,
          content: `# ${targetTitle}\n\nConnected from other notes...`,
        });

        if (result.success && result.fullPath) {
          const { files, folders: vaultFolders } = await tauriAPI.indexVault(settings.vaultPath);
          setFolders(vaultFolders);
          const sorted = [...files].sort((a, b) => a.title.localeCompare(b.title));
          setNotes(sorted);
          appLogger.info(`Connected note created via link: ${targetTitle} (${result.fullPath})`);
          
          const newNote = sorted.find((n) => n.path === result.fullPath);
          if (newNote) {
            setActiveNote(newNote);
            if (layout === 'graph' || layout === 'topics') setLayout('split');
          }
        } else {
          await alert(`Error creating connected note: ${result.error}`, {
            title: 'Could not create connected note',
          });
          appLogger.error(`Failed to create connected note: ${targetTitle}`, new Error(result.error));
        }
      }
    }
  };

  const handleInsertText = (text: string) => {
    if (!activeNote) return;
    const newContent = (activeNote.content ?? '') + '\n' + text;
    handleSaveContent(activeNote.path, newContent);
  };

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-neutral-100 font-sans overflow-hidden select-none">
      
      {/* Sidebar navigation (collapsible) */}
      {sidebarCollapsed ? (
        <div
          data-region="sidebar"
          className="shrink-0 h-full w-11 border-r border-slate-900 bg-slate-950 flex flex-col items-center py-3 gap-2 select-none"
        >
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-md text-slate-400 hover:text-orange-400 hover:bg-slate-900 transition-colors"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="w-5 h-5" />
          </button>
        </div>
      ) : (
        <div className="relative shrink-0 h-full" style={{ width: sidebarWidth }}>
          <Sidebar
            notes={notes}
            folders={folders}
            activeNote={activeNote}
            onSelectNote={handleSelectNote}
            onNewNote={handleNewNote}
            onNewFolder={handleNewFolder}
            onDeleteFolder={handleDeleteFolder}
            onDeleteNote={handleDeleteNote}
            onRenameNote={handleRenameNote}
            onMoveNote={handleMoveNote}
            vaultPath={settings.vaultPath}
            onSelectVault={handleSelectVault}
            onRefresh={() => fetchNotes()}
            onRunIngest={() => setIsIngestModalOpen(true)}
            isIngesting={isIngesting}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onCollapse={toggleSidebar}
          />
          <ResizeHandle
            direction="horizontal"
            onResize={(d) => saveSidebarWidth(Math.min(480, Math.max(180, sidebarWidth + d)))}
            className="absolute right-0 top-0 bottom-0"
          />
        </div>
      )}

      {/* Primary Workspace Panel */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        
        {/* Workspace Toolbar/Tabs */}
        <div className="workspace-toolbar h-14 border-b border-neutral-900 bg-neutral-950/40 px-6 flex items-center justify-between shrink-0">
           <div className="flex items-center gap-1 bg-neutral-950 border border-neutral-900 rounded-lg p-1">
             <button
               onClick={() => setLayout('editor')}
               className={`p-2 rounded-md transition-all ${
                 layout === 'editor'
                   ? 'bg-neutral-900 text-orange-400'
                   : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/50'
               }`}
               title="Note Editor"
             >
               <FileText className="w-4 h-4" />
             </button>
             <button
               onClick={() => setLayout('split')}
               className={`p-2 rounded-md transition-all ${
                 layout === 'split'
                   ? 'bg-neutral-900 text-orange-400'
                   : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/50'
               }`}
               title="Split View"
             >
               <SplitSquareVertical className="w-4 h-4" />
             </button>
             <button
               onClick={() => setLayout('graph')}
               className={`p-2 rounded-md transition-all ${
                 layout === 'graph'
                   ? 'bg-neutral-900 text-orange-400'
                   : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/50'
               }`}
               title="Graph Network"
             >
               <Network className="w-4 h-4" />
             </button>
             <button
               onClick={() => setLayout('topics')}
               className={`p-2 rounded-md transition-all ${
                 layout === 'topics'
                   ? 'bg-neutral-900 text-orange-400'
                   : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/50'
               }`}
               title="Topic Groups (@tags)"
             >
               <Tags className="w-4 h-4" />
             </button>
           </div>

           <button
             onClick={() => setShowAICoPilot(!showAICoPilot)}
             className={`p-2 border rounded-lg transition-all ${
               showAICoPilot 
                 ? 'bg-orange-600/10 border-orange-500/30 text-orange-400' 
                 : 'bg-neutral-950 border-neutral-900 text-neutral-400 hover:text-neutral-200'
             }`}
             title="OmniRoute AI Co-Pilot"
           >
             <Sparkles className="w-4 h-4" />
           </button>
         </div>

        {/* Workspace Main Panels */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Note Editor Pane */}
          {(layout === 'editor' || layout === 'split') && (
            <ErrorBoundary fallbackTitle="Editor Component Crashed">
              <Editor
                note={activeNote}
                allNotes={notes}
                vaultPath={settings.vaultPath}
                onSaveContent={handleSaveContent}
                onWikiLinkClick={handleWikiLinkClick}
                scrollRequest={scrollRequest}
                semanticRefreshToken={semanticTick}
                onVaultChanged={() => {
                  fetchNotes();
                  loadGraph();
                }}
              />
            </ErrorBoundary>
          )}

          {/* Connected Force Graph Network Pane (2D/3D toggle inside) */}
          {(layout === 'graph' || layout === 'split') && (
            <GraphViewContainer
              graphData={graphData}
              activeNote={graphActiveNote}
              onSelectNoteByTitle={handleWikiLinkClick}
            />
          )}

          {/* Vault-wide @topic groups Pane */}
          {layout === 'topics' && <TopicsView onWikiLinkClick={handleWikiLinkClick} />}

          {/* OmniRoute AI chat bar right sidebar */}
          {showAICoPilot && (
            <div className="relative shrink-0 h-full" style={{ width: aiWidth }}>
              <ResizeHandle
                direction="horizontal"
                onResize={(d) => saveAiWidth(Math.min(560, Math.max(240, aiWidth - d)))}
                className="absolute left-0 top-0 bottom-0"
              />
              <AISidebar
                note={activeNote}
                allNotes={notes}
                config={settings.omniRoute}
                onOpenSettings={() => setIsSettingsOpen(true)}
                onInsertText={handleInsertText}
              />
            </div>
          )}

        </div>
      </div>

      {/* Settings Modal overlay */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />

      {/* Ingest Modal overlay */}
      <IngestModal
        isOpen={isIngestModalOpen}
        onClose={() => setIsIngestModalOpen(false)}
        onIngest={handleRunIngest}
      />

      {/* Persistent, reopenable ingestion log (minimizable badge + drawer) */}
      <IngestionLogPanel />

      {/* Custom dark context menu (replaces the WebView2 default) — only the
          sidebar and editor regions get one; graph/topics get nothing. */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          variant={
            ctxMenu.target
              ? ctxMenu.target.type === 'note'
                ? 'note'
                : 'folder'
              : ctxMenu.region === 'sidebar'
                ? 'sidebar'
                : 'editor'
          }
          onNewFolder={handleNewFolder}
          // Generic sidebar background (no target): prompt for the folder. The
          // 'folder' variant passes '__current__' so the hovered path is used.
          onDeleteFolder={(folderPath) =>
            folderPath === '__current__'
              ? ctxMenu.target?.type === 'folder' && handleDeleteFolder(ctxMenu.target.path)
              : handleDeleteFolder()
          }
          // Right-clicked a specific folder: use its path directly.
          onRenameFolder={() =>
            ctxMenu.target?.type === 'folder' && handleRenameFolder(ctxMenu.target.path)
          }
          // Right-clicked a specific note: resolve it and run its handlers.
          onRenameNote={() => {
            if (ctxMenu.target?.type !== 'note') return;
            const n = notes.find((x) => x.path === ctxMenu.target!.path);
            if (n) handleRenameNote(n);
          }}
          onDeleteNote={() => {
            if (ctxMenu.target?.type !== 'note') return;
            const n = notes.find((x) => x.path === ctxMenu.target!.path);
            if (n) handleDeleteNote(n);
          }}
        />
      )}

    </div>
  );
}

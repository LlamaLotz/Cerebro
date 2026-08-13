import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { Editor } from './components/Editor';
import { GraphView } from './components/GraphView';
import { AISidebar } from './components/AISidebar';
import { SettingsModal } from './components/SettingsModal';
import { IngestModal } from './components/IngestModal';
import { IngestionLogPanel } from './components/IngestionLogPanel';
import { useIngestion } from './services/ingestionStore';
import { AppSettings, NoteFile, tauriAPI } from './types';
import { linkerService } from './services/linkerService';
import { backfillEmbeddings, generateAndStoreEmbedding } from './services/semantic';
import { FileText, Network, SplitSquareVertical, Sparkles } from 'lucide-react';

const LOCAL_STORAGE_KEY = 'cerebro_app_settings';

// Extract `aliases:` entries from a note's YAML frontmatter
function extractAliases(content: string): string[] {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const block = m[1];
  const out: string[] = [];

  const inline = block.match(/^aliases?:\s*(.+)$/m);
  if (inline) {
    out.push(
      ...inline[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    );
  }

  const list = block.match(/^aliases?:\s*\r?\n((?:\s+-\s+.+\r?\n?)+)/m);
  if (list) {
    out.push(
      ...list[1]
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, ''))
    );
  }

  return out.filter((a) => a.length > 0);
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
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [activeNote, setActiveNote] = useState<NoteFile | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isIngestModalOpen, setIsIngestModalOpen] = useState(false);
  
  // Layout views: 'editor' | 'graph' | 'split'
  const [layout, setLayout] = useState<'editor' | 'graph' | 'split'>('split');
  const [showAICoPilot, setShowAICoPilot] = useState(true);

  const { addLog, updateProgress } = useIngestion();

  // Debounced snapshot of the graph inputs: updates immediately on note switch,
  // but only after a typing pause (1s) when the active note is being edited,
  // so the D3 force simulation is not rebuilt on every keystroke.
  const [graphNotes, setGraphNotes] = useState<NoteFile[]>([]);
  const [graphActiveNote, setGraphActiveNote] = useState<NoteFile | null>(null);
  const graphDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graphNotePathRef = useRef<string | null>(null);
  const backfillRanRef = useRef(false);
  // Incremented when the once-per-session semantic backfill completes, so the
  // Related Notes panel knows embeddings now exist and refreshes itself.
  const [semanticTick, setSemanticTick] = useState(0);

  useEffect(() => {
    if (graphDebounceRef.current) clearTimeout(graphDebounceRef.current);
    if (!activeNote) {
      graphNotePathRef.current = null;
      setGraphActiveNote(null);
      setGraphNotes(notes);
      return;
    }
    if (graphNotePathRef.current !== activeNote.path) {
      graphNotePathRef.current = activeNote.path;
      setGraphNotes(notes);
      setGraphActiveNote(activeNote);
      return;
    }
    graphDebounceRef.current = setTimeout(() => {
      setGraphNotes(notes);
      setGraphActiveNote(activeNote);
    }, 1000);
  }, [activeNote, notes]);

  useEffect(() => {
    return () => {
      if (graphDebounceRef.current) clearTimeout(graphDebounceRef.current);
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
      }
    }
  }, []);

  // 2. Fetch files from designated Notes Directory when vaultPath or settings change
  const fetchNotes = async (customPath?: string) => {
    const path = customPath !== undefined ? customPath : settings.vaultPath;
    if (!path) {
      setNotes([]);
      return;
    }
    
    try {
      const files = await tauriAPI.readVaultFiles(path);
      // Sort notes alphabetically by title
      const sorted = [...files].sort((a, b) => a.title.localeCompare(b.title));
      setNotes(sorted);
      // Wait for the SQLite index to be fully populated BEFORE the backfill
      // queries it, otherwise the backfill finds zero notes and embeds nothing.
      await indexVault(sorted);

      // First-run backfill: embed any notes missing an embedding (once per session)
      if (!backfillRanRef.current) {
        backfillRanRef.current = true;
        const count = await backfillEmbeddings();
        console.log(`Semantic backfill complete: ${count} notes embedded.`);
        // Refresh the Related Notes panel now that embeddings exist
        setSemanticTick((t) => t + 1);
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

  // Sync the SQLite vault index with the files on disk
  const indexVault = async (files: NoteFile[]) => {
    try {
      await linkerService.initLinker(['**/*.md']);
      for (const n of files) {
        await linkerService.indexNote(n.path, n.title, n.path, extractAliases(n.content));
      }
      // Keep the index in sync reactively as files change on disk
      await linkerService.startWatchingVault(settings.vaultPath);
    } catch (err) {
      console.error('Vault indexing failed:', err);
    }
  };

  useEffect(() => {
    fetchNotes();
  }, [settings.vaultPath]);

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
      alert('Please connect a notes vault folder in settings first.');
      return;
    }

    setIsIngesting(true);
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
      } else {
        addLog({ level: 'error', message: 'FAILED: ' + (result.error || result.output) });
        updateProgress({ status: 'error' });
      }
    } catch (err) {
      addLog({ level: 'error', message: `Critical error: ${err}` });
      updateProgress({ status: 'error' });
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

      // Keep the semantic index warm on save (fire-and-forget)
      generateAndStoreEmbedding(filePath, content);
    } else {
      console.error('Failed to write file:', result.error);
    }
  };

  // 7. Create New Note
  const handleNewNote = async () => {
    if (!settings.vaultPath) return;

    const titleInput = prompt('Enter new note title:', 'Untitled Note');
    if (titleInput === null) return; // cancelled

    const formattedTitle = titleInput.trim() || 'Untitled Note';
    const relativePath = `${formattedTitle}.md`;

    // Prevent duplicate files
    const alreadyExists = notes.some((n) => n.title.toLowerCase() === formattedTitle.toLowerCase());
    if (alreadyExists) {
      alert(`A note named "${formattedTitle}" already exists!`);
      return;
    }

    const result = await tauriAPI.createFile({
      vaultPath: settings.vaultPath,
      relativePath,
      content: `# ${formattedTitle}\n\nStart writing here...`,
    });

    if (result.success && result.fullPath) {
      const files = await tauriAPI.readVaultFiles(settings.vaultPath);
      const sorted = [...files].sort((a, b) => a.title.localeCompare(b.title));
      setNotes(sorted);
      
      const newNote = sorted.find((n) => n.path === result.fullPath);
      if (newNote) {
        setActiveNote(newNote);
        // Switch to editor mode to start editing immediately
        if (layout === 'graph') setLayout('split');
      }
    } else {
      alert(`Error creating note: ${result.error}`);
    }
  };

  // 8. Delete note file
  const handleDeleteNote = async (note: NoteFile) => {
    const confirmDelete = window.confirm(`Are you sure you want to delete "${note.title}"? This cannot be undone.`);
    if (!confirmDelete) return;

    const result = await tauriAPI.deleteFile(note.path);
    if (result.success) {
      if (activeNote?.path === note.path) {
        setActiveNote(null);
      }
      await fetchNotes();
    } else {
      alert(`Error deleting note: ${result.error}`);
    }
  };

  // 9. Rename note file
  const handleRenameNote = async (note: NoteFile) => {
    const newTitleInput = prompt(`Rename "${note.title}" to:`, note.title);
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
      await fetchNotes();
    } else {
      alert(`Error renaming note: ${result.error}`);
    }
  };

  // 10. Wiki link traversal & automatic connection note creation
  const handleWikiLinkClick = async (targetTitle: string) => {
    // Look for matching note (case-insensitive)
    const matched = notes.find((n) => n.title.toLowerCase() === targetTitle.toLowerCase());
    
    if (matched) {
      setActiveNote(matched);
      if (layout === 'graph') setLayout('split');
    } else {
      // Note doesn't exist yet! Ask user to create it (Obsidian connection model!)
      const confirmCreate = window.confirm(
        `Note "${targetTitle}" does not exist yet.\nWould you like to create it and connect them?`
      );

      if (confirmCreate && settings.vaultPath) {
        const relativePath = `${targetTitle}.md`;
        const result = await tauriAPI.createFile({
          vaultPath: settings.vaultPath,
          relativePath,
          content: `# ${targetTitle}\n\nConnected from other notes...`,
        });

        if (result.success && result.fullPath) {
          const files = await tauriAPI.readVaultFiles(settings.vaultPath);
          const sorted = [...files].sort((a, b) => a.title.localeCompare(b.title));
          setNotes(sorted);
          
          const newNote = sorted.find((n) => n.path === result.fullPath);
          if (newNote) {
            setActiveNote(newNote);
            if (layout === 'graph') setLayout('split');
          }
        } else {
          alert(`Error creating connected note: ${result.error}`);
        }
      }
    }
  };

  const handleInsertText = (text: string) => {
    if (!activeNote) return;
    const newContent = activeNote.content + '\n' + text;
    handleSaveContent(activeNote.path, newContent);
  };

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-neutral-100 font-sans overflow-hidden select-none">
      
      {/* Sidebar navigation */}
      <Sidebar
        notes={notes}
        activeNote={activeNote}
        onSelectNote={setActiveNote}
        onNewNote={handleNewNote}
        onDeleteNote={handleDeleteNote}
        onRenameNote={handleRenameNote}
        vaultPath={settings.vaultPath}
        onSelectVault={handleSelectVault}
        onRefresh={() => fetchNotes()}
        onRunIngest={() => setIsIngestModalOpen(true)}
        isIngesting={isIngesting}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

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
                   : 'text-neutral-400 hover:text-neutral-200'
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
                   : 'text-neutral-400 hover:text-neutral-200'
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
                   : 'text-neutral-400 hover:text-neutral-200'
               }`}
               title="Graph Network"
             >
               <Network className="w-4 h-4" />
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
            <Editor
              note={activeNote}
              allNotes={notes}
              vaultPath={settings.vaultPath}
              onSaveContent={handleSaveContent}
              onWikiLinkClick={handleWikiLinkClick}
              semanticRefreshToken={semanticTick}
            />
          )}

          {/* Connected Force Graph Network Pane */}
          {(layout === 'graph' || layout === 'split') && (
            <GraphView
              notes={graphNotes}
              activeNote={graphActiveNote}
              onSelectNoteByTitle={handleWikiLinkClick}
            />
          )}

          {/* OmniRoute AI chat bar right sidebar */}
          {showAICoPilot && (
            <AISidebar
              note={activeNote}
              allNotes={notes}
              config={settings.omniRoute}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onInsertText={handleInsertText}
            />
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

    </div>
  );
}

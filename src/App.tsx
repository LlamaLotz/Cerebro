import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Sidebar } from './components/Sidebar';
import { Editor } from './components/Editor';
import { GraphView } from './components/GraphView';
import { AISidebar } from './components/AISidebar';
import { SettingsModal } from './components/SettingsModal';
import { IngestModal } from './components/IngestModal';
import { AppSettings, NoteFile, tauriAPI } from './types';
import { 
  FileText, Network, SplitSquareVertical, Sparkles, 
  HelpCircle, AlertCircle, X, Terminal, CheckCircle 
} from 'lucide-react';

const LOCAL_STORAGE_KEY = 'cerebro_app_settings';

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

  // Ingestion output console modal state
  const [ingestOutput, setIngestOutput] = useState<{ isOpen: boolean; success: boolean; output: string }>({
    isOpen: false,
    success: true,
    output: '',
  });

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
    setIngestOutput({ isOpen: true, success: true, output: 'Initializing ingestion pipeline...' });
    
    try {
      // Start listening for real-time progress events from Rust
      const unlistenProgress = await listen<string>('ingestion-progress', (event) => {
        setIngestOutput((prev) => ({ ...prev, output: prev.output + '\n' + event.payload }));
      });
      const unlistenError = await listen<string>('ingestion-error', (event) => {
        setIngestOutput((prev) => ({ ...prev, output: prev.output + '\n[ERROR] ' + event.payload }));
      });
    
      // Call the async native extractor
      const result = await tauriAPI.runBuiltinExtractorAsync({
        vaultPath: settings.vaultPath,
        ingestType: type,
        value,
        ytMethod: method,
      });
    
      if (result.success) {
        setIngestOutput((prev) => ({ ...prev, success: true, output: prev.output + '\n\nDONE: ' + result.output }));
      } else {
        setIngestOutput((prev) => ({ ...prev, success: false, output: prev.output + '\n\nFAILED: ' + result.error }));
      }
    
      unlistenProgress();
      unlistenError();
    } catch (err) {
      setIngestOutput({ isOpen: true, success: false, output: `Critical error: ${err}` });
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

    const folder = note.path.substring(0, note.path.lastIndexOf('/'));
    const newPath = `${folder}/${formattedNewTitle}.md`;

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
        <div className="h-14 border-b border-neutral-900 bg-neutral-950/40 px-6 flex items-center justify-between shrink-0">
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
              onSaveContent={handleSaveContent}
              onWikiLinkClick={handleWikiLinkClick}
            />
          )}

          {/* Connected Force Graph Network Pane */}
          {(layout === 'graph' || layout === 'split') && (
            <GraphView
              notes={notes}
              activeNote={activeNote}
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

      {/* Ingestion Script Output Console Overlay */}
      {ingestOutput.isOpen && (
<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
           <div className="w-full max-w-xl bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl flex flex-col max-h-[80vh]">
             <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
               <h3 className="text-sm font-bold text-neutral-200 flex items-center gap-2">
                 {ingestOutput.success ? (
                   <CheckCircle className="w-5 h-5 text-orange-400" />
                 ) : (
                   <AlertCircle className="w-5 h-5 text-rose-400" />
                 )}
                 Ingestion Script Status: {ingestOutput.success ? 'Success' : 'Failed'}
               </h3>
               <button 
                 onClick={() => setIngestOutput((prev) => ({ ...prev, isOpen: false }))}
                 className="text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 p-1 rounded-lg transition-colors"
               >
                 <X className="w-4.5 h-4.5" />
               </button>
             </div>
             
             <div className="flex-1 overflow-y-auto p-6 font-mono text-xs bg-neutral-950 text-neutral-300 whitespace-pre-wrap select-text leading-relaxed">
               {ingestOutput.output}
             </div>
 
             <div className="px-6 py-3 border-t border-neutral-800/60 bg-neutral-950/40 flex justify-end shrink-0 rounded-b-xl">
               <button
                 onClick={() => setIngestOutput((prev) => ({ ...prev, isOpen: false }))}
                 className="px-4 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold rounded-lg transition-colors border border-neutral-750"
               >
                 Close Logs
               </button>
             </div>
           </div>
         </div>
      )}

    </div>
  );
}

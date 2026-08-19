import React, { useEffect, useMemo, useRef, useState } from 'react';
import { 
  Folder, FolderOpen, FolderPlus, FolderMinus, Plus, Search, FileText, Trash2, Edit3, 
  RefreshCw, Terminal, Settings, ChevronRight, Play, PanelLeftClose,
  ArrowUp, ArrowDown, TerminalSquare
} from 'lucide-react';
import { NoteFile, tauriAPI } from '../types';
import { useIngestion } from '../services/ingestionStore';

interface SidebarProps {
  notes: NoteFile[];
  /** Every folder under the vault (POSIX-style relative paths), including
   *  empty ones — used to render folders that hold no notes yet. */
  folders: string[];
  activeNote: NoteFile | null;
  onSelectNote: (note: NoteFile) => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  /** Delete a folder (and everything inside it). Receives the folder's
   *  POSIX-style relative path (e.g. `Projects/Book`). */
  onDeleteFolder: (folderPath: string) => void;
  onDeleteNote: (note: NoteFile) => void;
  onRenameNote: (note: NoteFile) => void;
  onMoveNote: (note: NoteFile, direction: 'up' | 'down') => void;
  vaultPath: string;
  onSelectVault: () => void;
  onRefresh: () => void;
  onRunIngest: () => void;
  isIngesting: boolean;
  onOpenSettings: () => void;
  onCollapse: () => void;
}

/** A single folder in the sidebar tree. */
interface FolderNode {
  name: string;
  /** POSIX-style relative path of this folder (e.g. `Projects/Book`). */
  relativePath: string;
  children: FolderNode[];
  notes: NoteFile[];
}

const EXPANDED_KEY = 'cerebro_expanded_folders';

function countNotes(folder: FolderNode): number {
  return folder.notes.length + folder.children.reduce((n, c) => n + countNotes(c), 0);
}

/** Groups notes into a nested folder tree. `onDiskFolders` (POSIX-style
 *  relative paths, incl. empty ones) seed the tree first so folders without
 *  any notes still render; notes are then dropped into their folder chain.
 *  Notes sitting directly in the vault root come back as `rootNotes`. */
function buildFolderTree(
  notes: NoteFile[],
  onDiskFolders: string[]
): { rootNotes: NoteFile[]; folders: FolderNode[] } {
  const folderMap = new Map<string, FolderNode>();
  const rootNotes: NoteFile[] = [];

  // Create a node for a folder path (and every ancestor), returning it.
  const ensureFolder = (path: string): FolderNode => {
    let node = folderMap.get(path);
    if (node) return node;
    const slashIdx = path.lastIndexOf('/');
    const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
    node = { name, relativePath: path, children: [], notes: [] };
    folderMap.set(path, node);
    if (slashIdx >= 0) {
      ensureFolder(path.slice(0, slashIdx)).children.push(node);
    }
    return node;
  };

  // 1. Seed folders straight from disk (empty folders included).
  for (const f of onDiskFolders) {
    ensureFolder(f);
  }

  // 2. Drop each note into its folder chain.
  for (const note of notes) {
    const rel = note.relativePath.replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    // No folder segments left after the filename → the note sits directly in
    // the vault root (e.g. `relativePath === "note.md"`).
    if (parts.length === 0) {
      rootNotes.push(note);
      continue;
    }
    ensureFolder(parts.join('/')).notes.push(note);
  }

  const folders = Array.from(folderMap.values())
    .filter((f) => !f.relativePath.includes('/'))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Nested children were pushed in discovery order; sort them for a stable UI.
  const sortRecursive = (f: FolderNode) => {
    f.children.sort((a, b) => a.name.localeCompare(b.name));
    f.children.forEach(sortRecursive);
  };
  folders.forEach(sortRecursive);

  return { rootNotes, folders };
}

export const Sidebar: React.FC<SidebarProps> = ({
  notes,
  folders: foldersProp,
  activeNote,
  onSelectNote,
  onNewNote,
  onNewFolder,
  onDeleteFolder,
  onDeleteNote,
  onRenameNote,
  onMoveNote,
  vaultPath,
  onSelectVault,
  onRefresh,
  onRunIngest,
  isIngesting,
  onOpenSettings,
  onCollapse,
}) => {
  const [search, setSearch] = useState('');
  const { isMinimized, setMinimized, isHidden, setHidden, progress } = useIngestion();

  // Collapsed folder set (relative paths), persisted so the tree reopens the
  // way it was left. Default: all folders expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'));
    } catch {
      return new Set();
    }
  });
  const toggleFolder = (relativePath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // Storage unavailable — collapse state just won't persist this time.
      }
      return next;
    });
  };

  // Create-menu (the + button) dropdown state + outside-click/Escape close.
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!createMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCreateMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [createMenuOpen]);

  // Toggle the log window: hidden → open expanded; minimized (badge) → expand;
  // fully expanded → vanish.
  const toggleLogs = () => {
    if (isHidden) {
      setHidden(false);
      setMinimized(false);
    } else if (isMinimized) {
      setMinimized(false);
    } else {
      setHidden(true);
    }
  };

  const filteredNotes = useMemo(() =>
    notes.filter((note) =>
      note.title.toLowerCase().includes(search.toLowerCase()) ||
      (note.content ?? '').toLowerCase().includes(search.toLowerCase())
    ),
    [notes, search]
  );

  const { rootNotes, folders } = useMemo(
    () => buildFolderTree(notes, foldersProp),
    [notes, foldersProp]
  );

  // Note row (shared by root notes and folder contents; `depth` controls the
  // left padding so nested notes read as belonging to their folder).
  const renderNote = (note: NoteFile, depth: number) => {
    const isActive = activeNote?.path === note.path;
    return (
      <div
        key={note.path}
        data-note-path={note.path}
        className={`group flex items-center justify-between text-xs px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
          isActive 
            ? 'bg-slate-900 border-l-2 border-orange-400 text-orange-100 font-medium' 
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
        }`}
        style={{ paddingLeft: depth * 16 + 12 }}
        onClick={() => onSelectNote(note)}
      >
        <div className="flex items-center gap-2 truncate flex-1 pr-2">
          <FileText className={`w-4 h-4 shrink-0 ${isActive ? 'text-orange-400' : 'text-slate-500'}`} />
          <span className="truncate">{note.title}</span>
        </div>

        {/* Note Hover Actions */}
        <div className="flex items-center gap-1.5 shrink-0 opacity-50 hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRenameNote(note);
            }}
            className="p-1 hover:bg-slate-800 text-slate-400 hover:text-orange-400 rounded transition-colors"
            title="Rename Note"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteNote(note);
            }}
            className="p-1 hover:bg-slate-800 text-slate-400 hover:text-rose-400 rounded transition-colors"
            title="Delete Note"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  // Folder row: expand/collapse chevron, name, note count, and a delete
  // button in the pill (shown on hover) that removes the folder + contents.
  const renderFolder = (folder: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(folder.relativePath);
    const total = countNotes(folder);
    return (
      <div key={folder.relativePath}>
        <div
          data-folder-path={folder.relativePath}
          className={`group flex items-center justify-between text-xs px-3 py-2 rounded-lg cursor-pointer transition-all ${
            isCollapsed
              ? 'text-slate-500 hover:text-slate-300'
              : 'text-slate-300 hover:text-slate-100 hover:bg-slate-900/50'
          }`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => toggleFolder(folder.relativePath)}
          title={isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
        >
          <div className="flex items-center gap-1.5 truncate flex-1 pr-2">
            <ChevronRight
              className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                isCollapsed ? '' : 'rotate-90'
              }`}
            />
            {isCollapsed ? (
              <Folder className="w-4 h-4 shrink-0 text-slate-500" />
            ) : (
              <FolderOpen className="w-4 h-4 shrink-0 text-orange-400/80" />
            )}
            <span className="truncate font-medium">{folder.name}</span>
            <span className="text-[10px] text-slate-600 shrink-0 tabular-nums">
              {total} {total === 1 ? 'note' : 'notes'}
            </span>
          </div>

          {/* Folder Hover Actions — delete lives in the folder pill */}
          <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(folder.relativePath);
              }}
              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-rose-400 rounded transition-colors"
              title={`Delete Folder "${folder.name}" (all contents)`}
            >
              <FolderMinus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <div>
            {folder.notes.map((note) => renderNote(note, depth + 1))}
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const showTree = search.trim() === '';

  return (
    <div
      data-region="sidebar"
      className="sidebar w-full border-r border-slate-900 bg-slate-950 flex flex-col h-full select-none"
    >
      {/* App Header */}
      <div className="p-4 border-b border-slate-900 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-orange-500 to-amber-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
            <span className="font-extrabold text-white text-base">C</span>
          </div>
          <div>
            <h1 className="text-sm font-bold bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-amber-500 leading-none">CEREBRO</h1>
            <span className="text-[10px] text-slate-500 font-medium">Knowledge & AI Vault</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onCollapse}
            className="text-slate-400 hover:text-slate-200 hover:bg-slate-900 p-1.5 rounded-lg transition-colors border border-transparent hover:border-slate-800"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
          <button
            onClick={onOpenSettings}
            className="text-slate-400 hover:text-slate-200 hover:bg-slate-900 p-1.5 rounded-lg transition-colors border border-transparent hover:border-slate-800"
            title="Open Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Note Folder Info & Actions */}
      <div className="p-3 bg-slate-900/40 border-b border-slate-900 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Vault Location</span>
          <button 
            onClick={onSelectVault}
            className="text-[10px] font-semibold text-orange-400 hover:text-orange-300 transition-colors flex items-center gap-1"
          >
            <FolderOpen className="w-3 h-3" /> Change
          </button>
        </div>

        {vaultPath ? (
          <div 
            className="text-xs bg-slate-950/80 border border-slate-800/60 rounded px-2.5 py-1.5 text-slate-300 font-mono truncate cursor-pointer hover:border-slate-700 hover:text-slate-100 transition-colors flex items-center gap-1.5"
            onClick={onSelectVault}
            title={vaultPath}
          >
            <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
            <span className="truncate">{vaultPath}</span>
          </div>
        ) : (
          <button 
            onClick={onSelectVault}
            className="w-full text-left text-xs bg-orange-950/30 hover:bg-orange-950/50 border border-orange-900/50 text-orange-300 rounded px-3 py-2 flex items-center justify-center gap-1.5 transition-all font-medium"
          >
            <FolderOpen className="w-4 h-4" /> Connect Note Folder
          </button>
        )}

        {/* Quick Sync / Ingestion controls */}
        {vaultPath && (
          <div className="flex gap-2 pt-1">
            <button
              onClick={onRefresh}
              className="flex-1 bg-slate-950 hover:bg-slate-900 text-slate-300 hover:text-slate-100 border border-slate-800/80 rounded p-1.5 flex items-center justify-center transition-colors"
              title="Sync / Refresh Notes"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleLogs}
              className="flex-1 bg-slate-950 hover:bg-slate-900 text-slate-300 hover:text-orange-400 border border-slate-800/80 rounded p-1.5 flex items-center justify-center transition-colors relative"
              title="Open / close ingestion logs"
            >
              <TerminalSquare className="w-4 h-4" />
              {/* Status dot mirrors the logs window's progress-bar color:
                  emerald = completed, rose = error, orange = ingesting, slate = idle */}
              <span
                className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-slate-950 ${
                  progress.status === 'completed'
                    ? 'bg-emerald-400'
                    : progress.status === 'error'
                      ? 'bg-rose-400'
                      : progress.status === 'ingesting'
                        ? 'bg-orange-400 animate-pulse'
                        : 'bg-slate-500'
                }`}
              />
            </button>
            <button
              onClick={onRunIngest}
              disabled={isIngesting}
              className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-800/40 text-white border border-orange-500/30 rounded p-1.5 flex items-center justify-center transition-colors shadow-sm shadow-orange-600/10"
              title={isIngesting ? "Ingesting..." : "Run custom ingestion script"}
            >
              {isIngesting ? (
                <RefreshCw className="w-4 h-4 animate-spin text-orange-300" />
              ) : (
                <Play className="w-4 h-4 fill-current text-white" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Note Search & Creation */}
      <div className="p-3 flex gap-2 border-b border-slate-900">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900/60 hover:bg-slate-900 border border-slate-850 focus:border-slate-700 text-xs rounded-lg pl-8 pr-2.5 py-1.5 text-slate-200 focus:outline-none transition-colors"
          />
        </div>
        {/* Single + button: dropdown between New Note and New Folder */}
        <div className="relative" ref={createMenuRef}>
          <button
            onClick={() => setCreateMenuOpen((o) => !o)}
            disabled={!vaultPath}
            className="bg-orange-500/10 hover:bg-orange-500/20 disabled:opacity-30 disabled:pointer-events-none text-orange-400 border border-orange-500/20 px-2 rounded-lg transition-all flex items-center justify-center h-full"
            title="Create"
          >
            <Plus className="w-4.5 h-4.5" />
          </button>
          {createMenuOpen && vaultPath && (
            <div className="absolute right-0 top-full mt-1 z-50 w-44 py-1 rounded-lg border border-neutral-800 bg-neutral-950/95 backdrop-blur-sm shadow-2xl shadow-black/60">
              <button
                onClick={() => {
                  setCreateMenuOpen(false);
                  onNewNote();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:bg-orange-500/10 hover:text-orange-300 transition-colors"
              >
                <FileText className="w-3.5 h-3.5 text-slate-500" />
                New Note
              </button>
              <button
                onClick={() => {
                  setCreateMenuOpen(false);
                  onNewFolder();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:bg-orange-500/10 hover:text-orange-300 transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-slate-500" />
                New Folder
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Notes List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {notes.length === 0 && folders.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-8">
            {vaultPath 
              ? search 
                ? 'No notes match your search.' 
                : 'No notes found. Create a new one!'
              : 'Connect folder to load notes.'}
          </div>
        ) : showTree ? (
          <>
            {rootNotes.map((note) => renderNote(note, 0))}
            {folders.map((folder) => renderFolder(folder, 0))}
          </>
        ) : filteredNotes.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-8">
            No notes match your search.
          </div>
        ) : (
          filteredNotes.map((note) => renderNote(note, 0))
        )}
      </div>
    </div>
  );
};

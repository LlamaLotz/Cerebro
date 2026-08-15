import React, { useMemo, useState } from 'react';
import { 
  FolderOpen, Plus, Search, FileText, Trash2, Edit3, 
  RefreshCw, Terminal, Settings, ChevronRight, Play, PanelLeftClose 
} from 'lucide-react';
import { NoteFile, tauriAPI } from '../types';

interface SidebarProps {
  notes: NoteFile[];
  activeNote: NoteFile | null;
  onSelectNote: (note: NoteFile) => void;
  onNewNote: () => void;
  onDeleteNote: (note: NoteFile) => void;
  onRenameNote: (note: NoteFile) => void;
  vaultPath: string;
  onSelectVault: () => void;
  onRefresh: () => void;
  onRunIngest: () => void;
  isIngesting: boolean;
  onOpenSettings: () => void;
  onCollapse: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  notes,
  activeNote,
  onSelectNote,
  onNewNote,
  onDeleteNote,
  onRenameNote,
  vaultPath,
  onSelectVault,
  onRefresh,
  onRunIngest,
  isIngesting,
  onOpenSettings,
  onCollapse,
}) => {
  const [search, setSearch] = useState('');

  const filteredNotes = useMemo(() =>
    notes.filter((note) =>
      note.title.toLowerCase().includes(search.toLowerCase()) ||
      (note.content ?? '').toLowerCase().includes(search.toLowerCase())
    ),
    [notes, search]
  );

  return (
    <div className="sidebar w-full border-r border-slate-900 bg-slate-950 flex flex-col h-full select-none">
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
        <button
          onClick={onNewNote}
          disabled={!vaultPath}
          className="bg-orange-500/10 hover:bg-orange-500/20 disabled:opacity-30 disabled:pointer-events-none text-orange-400 border border-orange-500/20 px-2 rounded-lg transition-all flex items-center justify-center"
          title="Create New Note"
        >
          <Plus className="w-4.5 h-4.5" />
        </button>
      </div>

      {/* Notes List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredNotes.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-8">
            {vaultPath 
              ? search 
                ? 'No notes match your search.' 
                : 'No notes found. Create a new one!'
              : 'Connect folder to load notes.'}
          </div>
        ) : (
          filteredNotes.map((note) => {
            const isActive = activeNote?.path === note.path;
            return (
              <div
                key={note.path}
                className={`group flex items-center justify-between text-xs px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                  isActive 
                    ? 'bg-slate-900 border-l-2 border-orange-400 text-orange-100 font-medium' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
                }`}
                onClick={() => onSelectNote(note)}
              >
                <div className="flex items-center gap-2 truncate flex-1 pr-2">
                  <FileText className={`w-4 h-4 shrink-0 ${isActive ? 'text-orange-400' : 'text-slate-500'}`} />
                  <span className="truncate">{note.title}</span>
                </div>
                
                {/* Note Hover Actions */}
                <div className="hidden group-hover:flex items-center gap-1.5 shrink-0 animate-in fade-in duration-100">
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
          })
        )}
      </div>
    </div>
  );
};

import React, { useState, useEffect, useRef } from 'react';
import { Eye, Edit2, FileText, Calendar, Link2, Info } from 'lucide-react';
import { NoteFile } from '../types';
import { segmentContent } from '../utils/markdownParser';

interface EditorProps {
  note: NoteFile | null;
  allNotes: NoteFile[];
  onSaveContent: (filePath: string, content: string) => void;
  onWikiLinkClick: (targetTitle: string) => void;
}

export const Editor: React.FC<EditorProps> = ({
  note,
  allNotes,
  onSaveContent,
  onWikiLinkClick,
}) => {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [content, setContent] = useState('');
  const [isSaved, setIsSaved] = useState(true);
  
  const timerRef = useRef<any>(null);
  const noteTitles = allNotes.map((n) => n.title);

  // Sync content state when note changes
  useEffect(() => {
    if (note) {
      setContent(note.content);
      setIsSaved(true);
      // Keep mode as edit if switching notes, or default to preview
    } else {
      setContent('');
    }
  }, [note]);

  // Clean up timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!note) {
    return (
      <div className="flex-1 bg-slate-900/30 flex flex-col items-center justify-center p-8 select-none">
        <div className="text-center space-y-3 max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto text-orange-400/80 shadow-inner">
            <FileText className="w-8 h-8" />
          </div>
          <h3 className="text-sm font-semibold text-slate-300">No Note Selected</h3>
          <p className="text-xs text-slate-500 leading-relaxed">
            Select an existing markdown note from the sidebar or create a new one to begin connecting your knowledge.
          </p>
        </div>
      </div>
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);
    setIsSaved(false);

    // Debounce autosave (800ms)
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onSaveContent(note.path, val);
      setIsSaved(true);
    }, 800);
  };

  const forceSave = () => {
    if (!isSaved) {
      if (timerRef.current) clearTimeout(timerRef.current);
      onSaveContent(note.path, content);
      setIsSaved(true);
    }
  };

  // Find incoming links (backlinks) to the current note
  const backlinks = allNotes.filter((n) => {
    if (n.title.toLowerCase() === note.title.toLowerCase()) return false;
    const wikiLinkPattern = new RegExp(`\\[\\[${escapeRegExp(note.title)}(\\||\\]\\])`, 'i');
    return wikiLinkPattern.test(n.content);
  });

  function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Simple Markdown Parsing Renderer for preview mode
  const renderMarkdown = (text: string) => {
    if (!text) {
      return <div className="text-slate-600 italic text-xs">This note is empty. Click "Edit" to add content.</div>;
    }

    // Split text into line elements first
    const lines = text.split('\n');

    return (
      <div className="space-y-3">
        {lines.map((line, lineIdx) => {
          const trimmedLine = line.trim();

          // 1. Headers
          if (trimmedLine.startsWith('# ')) {
            return (
              <h1 key={lineIdx} className="text-2xl font-bold text-slate-100 border-b border-slate-800/80 pb-1 mt-6 mb-2">
                {renderInlineElements(line.substring(2))}
              </h1>
            );
          }
          if (trimmedLine.startsWith('## ')) {
            return (
              <h2 key={lineIdx} className="text-xl font-bold text-slate-200 mt-5 mb-2">
                {renderInlineElements(line.substring(3))}
              </h2>
            );
          }
          if (trimmedLine.startsWith('### ')) {
            return (
              <h3 key={lineIdx} className="text-lg font-semibold text-slate-300 mt-4 mb-2">
                {renderInlineElements(line.substring(4))}
              </h3>
            );
          }

          // 2. Unordered List Items
          if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
            return (
              <ul key={lineIdx} className="list-disc pl-6 text-sm text-slate-300">
                <li>{renderInlineElements(line.substring(2))}</li>
              </ul>
            );
          }

          // 3. Blockquotes
          if (trimmedLine.startsWith('> ')) {
            return (
              <blockquote key={lineIdx} className="border-l-4 border-orange-500/50 bg-slate-900/40 px-4 py-2 my-2 rounded-r-lg text-sm italic text-slate-300 font-sans">
                {renderInlineElements(line.substring(2))}
              </blockquote>
            );
          }

          // 4. Code block markers (very simple parser)
          if (trimmedLine.startsWith('```')) {
            return <hr key={lineIdx} className="border-slate-800 my-2" />; // Render separator for code borders
          }

          // 5. Empty lines
          if (trimmedLine === '') {
            return <div key={lineIdx} className="h-2" />;
          }

          // 6. Regular paragraphs
          return (
            <p key={lineIdx} className="text-sm text-slate-300 leading-relaxed font-sans">
              {renderInlineElements(line)}
            </p>
          );
        })}
      </div>
    );
  };

  // Renders inline text and extracts Bold, Code tags, and Wiki links
  const renderInlineElements = (lineText: string) => {
    const segments = segmentContent(lineText, noteTitles);
    
    return segments.map((seg, idx) => {
      if (seg.type === 'wiki-link' && seg.target) {
        return (
          <span
            key={idx}
            onClick={() => onWikiLinkClick(seg.target!)}
            className={`wiki-link ${!seg.exists ? 'wiki-link-uncreated' : ''}`}
            title={seg.exists ? `Navigate to ${seg.target}` : `Create note "${seg.target}"`}
          >
            {seg.alias || seg.target}
          </span>
        );
      }

      // Quick inline formats for bold (**) and code (`)
      let contentNode: React.ReactNode = seg.content;
      
      // Inline bold regex match
      const boldRegex = /\*\*(.*?)\*\*/g;
      if (boldRegex.test(seg.content)) {
        const parts = seg.content.split(/\*\*/);
        contentNode = parts.map((part, pIdx) => {
          return pIdx % 2 === 1 ? <strong key={pIdx} className="font-bold text-slate-100">{part}</strong> : part;
        });
      }

      return <span key={idx}>{contentNode}</span>;
    });
  };

  const formattedDate = () => {
    if (!note.updatedAt) return '';
    const d = new Date(note.updatedAt);
    return d.toLocaleString(undefined, { 
      year: 'numeric', month: 'short', day: 'numeric', 
      hour: '2-digit', minute: '2-digit' 
    });
  };

  return (
    <div className="flex-1 bg-slate-900/10 flex flex-col h-full overflow-hidden">
      
      {/* Top Editor Bar */}
      <div className="px-6 py-3 border-b border-slate-900/60 bg-slate-950/20 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 truncate">
          <div className="p-1 bg-orange-500/10 border border-orange-500/20 rounded-md text-orange-400">
            <FileText className="w-4 h-4" />
          </div>
          <div className="truncate">
            <h2 className="text-sm font-semibold text-slate-100 leading-tight truncate">{note.title}</h2>
            <div className="flex items-center gap-3 text-[10px] text-slate-500 font-medium">
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Modified: {formattedDate()}
              </span>
              <span>•</span>
              <span className={isSaved ? "text-emerald-500/80" : "text-amber-500/80 animate-pulse"}>
                {isSaved ? 'Saved' : 'Typing...'}
              </span>
            </div>
          </div>
        </div>

        {/* Edit / Preview Segmented Controller */}
        <div className="flex bg-slate-950 border border-slate-800 rounded-lg p-1">
          <button
            onClick={() => {
              forceSave();
              setMode('preview');
            }}
            className={`flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md transition-all ${
              mode === 'preview'
                ? 'bg-slate-800 text-orange-400 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3.5 h-3.5" /> Preview
          </button>
          <button
            onClick={() => setMode('edit')}
            className={`flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md transition-all ${
              mode === 'edit'
                ? 'bg-slate-800 text-orange-400 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Edit2 className="w-3.5 h-3.5" /> Edit
          </button>
        </div>
      </div>

      {/* Editor Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {mode === 'edit' ? (
          <textarea
            value={content}
            onChange={handleChange}
            onBlur={forceSave}
            placeholder="# Write your markdown here... Use [[Note Title]] to link notes together."
            className="flex-1 w-full bg-slate-950/20 text-slate-200 font-mono text-sm p-8 focus:outline-none resize-none overflow-y-auto leading-relaxed border-0"
          />
        ) : (
          <div className="flex-1 overflow-y-auto px-8 py-6 max-w-4xl mx-auto w-full select-text selection:bg-orange-500/30 selection:text-white">
            {renderMarkdown(content)}
          </div>
        )}
      </div>

      {/* Bottom Collapsible Pane for Backlinks */}
      <div className="border-t border-slate-900/80 bg-slate-950/30 shrink-0">
        <div className="px-6 py-2 border-b border-slate-900/40 flex items-center justify-between">
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-orange-400" /> Backlinks ({backlinks.length})
          </h3>
          <span className="text-[10px] text-slate-500 italic">Notes that link here</span>
        </div>
        
        <div className="px-6 py-3 max-h-36 overflow-y-auto">
          {backlinks.length === 0 ? (
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
              <Info className="w-3.5 h-3.5 text-slate-600 shrink-0" />
              <span>No other notes link to this file yet. Use <code className="bg-slate-950 px-1 py-0.5 rounded font-mono">{"[[" + note.title + "]]"}</code> in other files to connect.</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
              {backlinks.map((linkNote) => (
                <div
                  key={linkNote.path}
                  onClick={() => onWikiLinkClick(linkNote.title)}
                  className="bg-slate-950/60 border border-slate-850/80 hover:border-orange-500/30 hover:bg-slate-900/40 p-2.5 rounded-lg cursor-pointer transition-all flex flex-col justify-between"
                >
                  <span className="text-xs font-semibold text-slate-300 truncate">{linkNote.title}</span>
                  <span className="text-[10px] text-slate-500 truncate mt-1">Open note connection</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Eye, Edit2, FileText, Calendar } from 'lucide-react';
import { NoteFile } from '../types';
import { segmentContent } from '../utils/markdownParser';
import { LinkerToolbar } from './LinkerToolbar';
import { LinkHub } from './LinkHub';
import { linkerService, LinkMention, BacklinkInfo } from '../services/linkerService';
import {
  findSemanticRelatedNotes,
  generateAndStoreEmbedding,
  SemanticMatch,
} from '../services/semantic';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const REVIEW_STORAGE_KEY = 'cerebro_review_state';

// Windowed rendering: estimated height of a preview line (px) + overscan buffer
const PREVIEW_LINE_HEIGHT = 28;
const PREVIEW_BUFFER = 12;

// Pause before auto-rescanning all link types while the user types
const SCAN_DEBOUNCE_MS = 1000;

interface EditorProps {
  note: NoteFile | null;
  allNotes: NoteFile[];
  vaultPath: string;
  onSaveContent: (filePath: string, content: string) => void;
  onWikiLinkClick: (targetTitle: string) => void;
  semanticRefreshToken?: number;
}

export const Editor: React.FC<EditorProps> = ({
  note,
  allNotes,
  vaultPath,
  onSaveContent,
  onWikiLinkClick,
  semanticRefreshToken = 0,
}) => {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [content, setContent] = useState('');
  const [isSaved, setIsSaved] = useState(true);
  const [dictionary, setDictionary] = useState<[string, string][]>([]);
  const [pendingMentions, setPendingMentions] = useState<LinkMention[]>([]);
  const [incomingBacklinks, setIncomingBacklinks] = useState<BacklinkInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isLinkerReady, setIsLinkerReady] = useState(false);
  const [relatedMatches, setRelatedMatches] = useState<SemanticMatch[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const scanDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScannedPathRef = useRef<string | null>(null);
  
  const timerRef = useRef<any>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewScrollTop, setPreviewScrollTop] = useState(0);
  const [previewViewportHeight, setPreviewViewportHeight] = useState(0);

  const noteTitles = useMemo(() => allNotes.map((n) => n.title), [allNotes]);

  // Track preview scroll position for windowed rendering of large notes
  useEffect(() => {
    const el = previewRef.current;
    if (!el || mode !== 'preview') return;
    const update = () => {
      setPreviewScrollTop(el.scrollTop);
      setPreviewViewportHeight(el.clientHeight);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [mode]);

  // Initialize linker and fetch the vault dictionary
  useEffect(() => {
    if (!vaultPath) {
      setIsLinkerReady(false);
      setDictionary([]);
      return;
    }
    linkerService
      .initLinker(['**/*.md'])
      .then(() => linkerService.getVaultDictionary())
      .then((dict) => {
        setDictionary(dict);
        setIsLinkerReady(true);
      })
      .catch((e) => console.error('Linker initialization failed:', e));
  }, [vaultPath]);

  // Unified scan: keyword mentions + backlinks + semantic related notes.
  const runScan = async (overrideContent?: string) => {
    if (!note) return;
    const targetContent = overrideContent ?? content;
    setIsScanning(true);
    setSemanticLoading(true);
    setLinkError(null);
    try {
      const keywordPromise =
        dictionary.length > 0
          ? linkerService.scanUnlinkedMentions(targetContent, note.path, dictionary)
          : Promise.resolve<LinkMention[]>([]);

      const [mentionsRes, backlinksRes, relatedRes] = await Promise.allSettled([
        keywordPromise,
        linkerService.getIncomingBacklinks(note.path),
        findSemanticRelatedNotes(note.path, 8),
      ]);

      if (mentionsRes.status === 'fulfilled') setPendingMentions(mentionsRes.value);
      else console.error('Link scan failed:', mentionsRes.reason);

      if (backlinksRes.status === 'fulfilled') setIncomingBacklinks(backlinksRes.value);
      else console.error('Backlink fetch failed:', backlinksRes.reason);

      if (relatedRes.status === 'fulfilled') {
        setRelatedMatches(relatedRes.value);
      } else {
        const reason =
          typeof relatedRes.reason === 'string' ? relatedRes.reason : String(relatedRes.reason);
        if (reason.includes('No embedding stored')) {
          // Note was never embedded: embed it on the spot, then retry once.
          try {
            await generateAndStoreEmbedding(note.path, targetContent);
            setRelatedMatches(await findSemanticRelatedNotes(note.path, 8));
          } catch (e2) {
            console.error('Semantic search failed after embedding:', e2);
            setLinkError('Semantic index unavailable.');
          }
        } else {
          console.error('Semantic search failed:', relatedRes.reason);
          setLinkError(reason);
        }
      }
    } finally {
      setIsScanning(false);
      setSemanticLoading(false);
    }
  };

  const runScanRef = useRef(runScan);
  runScanRef.current = runScan;

  // Immediate scan when the active note changes
  useEffect(() => {
    if (!note) return;
    lastScannedPathRef.current = note.path;
    setPendingMentions([]);
    setIncomingBacklinks([]);
    setRelatedMatches([]);
    setLinkError(null);
    runScan(note.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.path]);

  // Debounced re-scan while editing (skip the content jump from note switching)
  useEffect(() => {
    if (!note) return;
    if (lastScannedPathRef.current !== note.path) {
      lastScannedPathRef.current = note.path;
      return;
    }
    if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
    scanDebounceRef.current = setTimeout(() => {
      scanDebounceRef.current = null;
      runScan();
    }, SCAN_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, note?.path]);

  // Re-scan when files on disk change (saved / renamed / deleted via the app)
  useEffect(() => {
    const unlisten = listen('vault-changed', () => {
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
      runScanRef.current();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Re-scan once the once-per-session semantic backfill completes
  useEffect(() => {
    if (!note || semanticRefreshToken === 0) return;
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticRefreshToken]);

  const titleByPath = useCallback(
    (path: string): string => {
      const found = allNotes.find((n) => n.path === path);
      return found ? found.title : path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? path;
    },
    [allNotes]
  );

  // Approve a keyword suggestion: turn the matched text into a [[wiki link]]
  const approveMention = (mention: LinkMention) => {
    if (!note) return;
    const title =
      dictionary.find(([id]) => id === mention.targetNoteId)?.[1] ?? mention.targetNoteId;
    const replacement =
      mention.matchedText === title
        ? `[[${title}]]`
        : `[[${title}|${mention.matchedText}]]`;
    const nextContent =
      content.slice(0, mention.start) + replacement + content.slice(mention.end);
    onSaveContent(note.path, nextContent);
    setPendingMentions((prev) => prev.filter((m) => m !== mention));
  };

  // Approve a semantic suggestion: append a [[wiki link]] to the target note
  const approveSemantic = (match: SemanticMatch) => {
    if (!note) return;
    const title = titleByPath(match.note_id);
    const nextContent = content.trimEnd() + `\n[[${title}]]`;
    onSaveContent(note.path, nextContent);
    setRelatedMatches((prev) => prev.filter((m) => m.note_id !== match.note_id));
  };

  const openReviewWindow = async () => {
    if (!note || pendingMentions.length === 0) return;
    localStorage.setItem(
      REVIEW_STORAGE_KEY,
      JSON.stringify({
        filePath: note.path,
        noteTitle: note.title,
        content,
        mentions: pendingMentions,
      })
    );
    const existing = await WebviewWindow.getByLabel('review-window');
    if (existing) {
      existing.setFocus();
      return;
    }
    new WebviewWindow('review-window', {
      url: 'index.html',
      title: `Review Links - ${note.title}`,
      width: 640,
      height: 520,
      resizable: true,
    });
  };

  // Sync content state when note changes
  useEffect(() => {
    if (note) {
      setContent(note.content);
      setIsSaved(true);
      setPendingMentions([]);
      // Keep mode as edit if switching notes, or default to preview
    } else {
      setContent('');
    }
  }, [note]);

  // Clean up timers
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
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

  // Auto-scan when the user leaves the note (blur in edit mode)
  const handleBlur = () => {
    forceSave();
    runScan();
  };

  // Simple Markdown Parsing Renderer for preview mode (renders a window of lines)
  const renderMarkdown = (lines: string[], startIndex: number) => {
    return (
      <div className="space-y-3">
        {lines.map((line, i) => {
          const lineIdx = startIndex + i;
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
    <div className="editor-container flex-1 bg-slate-900/10 flex flex-col h-full overflow-hidden">
      
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
        <div className="flex items-center gap-4">
          <LinkerToolbar
            pendingCount={pendingMentions.length}
            isScanning={isScanning}
            isReady={isLinkerReady && dictionary.length > 0}
            onScan={runScan}
            onOpenReview={openReviewWindow}
          />
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
      </div>

      {/* Editor Body */}
      <div className="editor-body flex-1 overflow-hidden flex flex-col">
        {mode === 'edit' ? (
          <textarea
            value={content}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="# Write your markdown here... Use [[Note Title]] to link notes together."
            className="flex-1 w-full bg-slate-950/20 text-slate-200 font-mono text-sm p-8 focus:outline-none resize-none overflow-y-auto leading-relaxed border-0"
          />
        ) : (
          <div
            ref={previewRef}
            className="markdown-body flex-1 overflow-y-auto px-8 py-6 max-w-4xl mx-auto w-full select-text selection:bg-orange-500/30 selection:text-white"
          >
            {content.length === 0 ? (
              <div className="text-slate-600 italic text-xs">This note is empty. Click "Edit" to add content.</div>
            ) : (
              (() => {
                const lines = content.split('\n');
                const totalLines = lines.length;
                const totalHeight = totalLines * PREVIEW_LINE_HEIGHT;
                const windowed = previewViewportHeight > 0;
                const start = windowed
                  ? Math.max(0, Math.floor(previewScrollTop / PREVIEW_LINE_HEIGHT) - PREVIEW_BUFFER)
                  : 0;
                const end = windowed
                  ? Math.min(totalLines, Math.ceil((previewScrollTop + previewViewportHeight) / PREVIEW_LINE_HEIGHT) + PREVIEW_BUFFER)
                  : totalLines;
                return (
                  <div
                    style={{
                      paddingTop: start * PREVIEW_LINE_HEIGHT,
                      paddingBottom: (totalLines - end) * PREVIEW_LINE_HEIGHT,
                      height: totalHeight,
                      boxSizing: 'border-box',
                    }}
                  >
                    {renderMarkdown(lines.slice(start, end), start)}
                  </div>
                );
              })()
            )}
          </div>
        )}
      </div>

      {/* Unified Links section: keyword mentions, backlinks, semantic matches */}
      <div className="border-t border-slate-900/80 bg-slate-950/30 shrink-0">
        <LinkHub
          mentions={pendingMentions}
          backlinks={incomingBacklinks}
          related={relatedMatches}
          dictionary={dictionary}
          allNotes={allNotes}
          isLoading={isScanning || semanticLoading}
          error={linkError}
          onWikiLinkClick={onWikiLinkClick}
          onApproveMention={approveMention}
          onApproveSemantic={approveSemantic}
          onRefresh={() => runScan()}
        />
      </div>

    </div>
  );
};

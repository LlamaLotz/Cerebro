import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Eye, Edit2, FileText, Calendar, Link2, ChevronUp, ChevronDown, X, Search, Anchor, Wand2, Undo2 } from 'lucide-react';
import { NoteFile, WikiLink } from '../types';
import { segmentContent, extractWikiLinks, findBlockLine, findLinkAtOffset } from '../utils/markdownParser';
import { formatNote } from '../utils/formatter';
import { LinkerToolbar } from './LinkerToolbar';
import { LinkHub } from './LinkHub';
import { ResizeHandle } from './ResizeHandle';
import { linkerService, LinkMention, BacklinkInfo, DeniedLink } from '../services/linkerService';
import {
  findSemanticRelatedNotes,
  findSemanticBlockMatches,
  generateAndStoreEmbedding,
  SemanticMatch,
  BlockMatch,
} from '../services/semantic';
import { listen } from '@tauri-apps/api/event';
import { tauriAPI } from '../types';
import { EditorView, keymap, lineNumbers, highlightActiveLine, Decoration, ViewUpdate, WidgetType } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Range, Text } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { appLogger } from '../services/appLogger';
import {
  extractKeywords,
  findKeywordRanges,
  keywordToken,
  normalizeKeyword,
  stripKeywordTokens,
  LOCAL_KEYWORD_TOKEN_RE,
} from '../utils/keywords';

// Windowed rendering: estimated height of a preview line (px) + overscan buffer
const PREVIEW_LINE_HEIGHT = 28;
const PREVIEW_BUFFER = 12;

// Notes above this size get the heavy paths disabled: no semantic/block
// embedding (see MAX_EMBED_CHARS in Rust), plain-text CodeMirror (no Lezer
// parse), and per-keystroke scans are skipped. A 512-token embedding of a
// multi-MB note is noise anyway.
const LARGE_NOTE_CHARS = 200_000;

// During a block jump the preview temporarily renders beyond the window so the
// target line element is guaranteed to exist. For huge notes rendering *all*
// lines would mount 100k+ DOM nodes, so the full render is capped to a band
// around the target line (the target is always inside the band).
const MAX_FULL_RENDER_LINES = 8_000;
const FULL_RENDER_BAND = 4_000;

// Pause before auto-rescanning all link types while the user types
const SCAN_DEBOUNCE_MS = 1000;

// Semantic (ONNX) results can only change after a re-embed, which happens at
// most once per save-pause — re-querying them on every keystroke-pause just
// burns CPU. They refresh on this cadence, or immediately when embeddings
// finish (semanticRefreshToken bump).
const SEMANTIC_SCAN_THROTTLE_MS = 10_000;

// Autosave delay after the last keystroke
const SAVE_DEBOUNCE_MS = 800;

// ---- CodeMirror flash-highlight machinery ----------------------------------
// `flashLineEffect` marks a target line; the StateField renders a line
// decoration whose class alternates (flash-a / flash-b) so re-clicking the
// same link restarts the CSS animation (the animation-name actually changes).
const flashLineEffect = StateEffect.define<{ line: number; ts: number }>();

const flashField = StateField.define<{ line: number; cls: string }>({
  create: () => ({ line: -1, cls: '' }),
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        v = { line: e.value.line, cls: `block-highlight ${e.value.ts % 2 ? 'flash-b' : 'flash-a'}` };
      }
    }
    if (tr.docChanged && v.line >= 0 && v.line > tr.newDoc.lines) {
      v = { line: -1, cls: '' };
    }
    return v;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (v) => (view) => {
      if (v.line <= 0) return Decoration.none;
      const line = view.state.doc.line(v.line);
      return Decoration.set([Decoration.line({ class: v.cls }).range(line.from)]);
    }),
});

const cmTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '28px 24px' },
});

// ---- Find-in-note machinery ------------------------------------------------
// One shared match list drives highlighting + navigation in BOTH modes:
// CodeMirror decorations (edit) and the markdown renderer (preview).
interface SearchMatch {
  line: number; // 1-based line number
  from: number; // absolute offset in the raw doc
  to: number;   // absolute end offset in the raw doc
  ch: number;   // 0-based char offset of the match within its line
}

function findMatches(doc: string, query: string, caseSensitive: boolean): SearchMatch[] {
  if (!query) return [];
  const haystack = caseSensitive ? doc : doc.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const lineStarts: number[] = [0];
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] === '\n') lineStarts.push(i + 1);
  }
  const lineIndexAt = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= pos) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return idx;
  };

  const matches: SearchMatch[] = [];
  let idx = 0;
  while (idx < haystack.length) {
    const pos = haystack.indexOf(needle, idx);
    if (pos === -1) break;
    const lineStart = lineStarts[lineIndexAt(pos)];
    matches.push({
      line: lineIndexAt(pos) + 1,
      from: pos,
      to: pos + needle.length,
      ch: pos - lineStart,
    });
    idx = pos + Math.max(needle.length, 1);
  }
  return matches;
}

const setSearchQueryEffect = StateEffect.define<{ query: string; caseSensitive: boolean }>();
const setSearchActiveEffect = StateEffect.define<number>();

// Renders all search matches as .search-match decorations, with the active
// match additionally marked .search-match-active. Recomputes when the query
// changes or the document is edited.
const searchField = StateField.define<{
  query: string;
  caseSensitive: boolean;
  matches: SearchMatch[];
  active: number;
}>({
  create: () => ({ query: '', caseSensitive: false, matches: [], active: -1 }),
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (e.is(setSearchQueryEffect)) {
        const matches = findMatches(tr.state.doc.toString(), e.value.query, e.value.caseSensitive);
        v = {
          query: e.value.query,
          caseSensitive: e.value.caseSensitive,
          matches,
          active: matches.length ? 0 : -1,
        };
      } else if (e.is(setSearchActiveEffect)) {
        v = { ...v, active: e.value };
      }
    }
    if (tr.docChanged && v.query) {
      const matches = findMatches(tr.state.doc.toString(), v.query, v.caseSensitive);
      v = {
        ...v,
        matches,
        active: matches.length ? Math.min(Math.max(v.active, 0), matches.length - 1) : -1,
      };
    }
    return v;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (v) => {
      if (!v.query || v.matches.length === 0) return Decoration.none;
      const ranges: Range<Decoration>[] = [];
      for (let i = 0; i < v.matches.length; i++) {
        const m = v.matches[i];
        const cls = i === v.active ? 'search-match search-match-active' : 'search-match';
        ranges.push(Decoration.mark({ class: cls }).range(m.from, m.to));
      }
      return Decoration.set(ranges);
    }),
});

// Decorates "@Topic" keyword groups in the edit mode with a pill mark, so they
// read as groupings rather than plain text. Only mounted for non-oversized
// notes (a per-keystroke full-doc scan is too costly on multi-MB notes).
const topicTagMark = Decoration.mark({ class: 'topic-tag' });

const buildTopicTagRanges = (doc: Text): Range<Decoration>[] => {
  const ranges: Range<Decoration>[] = [];
  const topicRe = /@[A-Za-z][\w-]*/g;
  const linkRe = /\[\[.*?\]\]/g;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const linkSpans: Array<[number, number]> = [];
    let lm: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((lm = linkRe.exec(line.text)) !== null) {
      linkSpans.push([lm.index, lm.index + lm[0].length]);
    }
    let m: RegExpExecArray | null;
    topicRe.lastIndex = 0;
    while ((m = topicRe.exec(line.text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // Skip @tokens that live inside [[...]] (link aliases like [[Note|@Math]])
      if (linkSpans.some(([s, e]) => start >= s && end <= e)) continue;
      ranges.push(topicTagMark.range(line.from + start, line.from + end));
    }
  }
  return ranges;
};

const topicTagField = StateField.define<Range<Decoration>[]>({
  create(state) {
    return buildTopicTagRanges(state.doc);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildTopicTagRanges(tr.newDoc);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => Decoration.set(v, true)),
});

// Hidden local keywords (`---kw---`): metadata managed from the LinkHub, so
// the tokens are replaced with a zero-width widget in edit mode and never
// shown in the note body. The raw text stays in the file (source of truth).
class LocalKeywordWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createElement('span');
  }
  ignoreEvent() {
    return true;
  }
}

const buildKeywordRanges = (doc: Text): Range<Decoration>[] => {
  const ranges: Range<Decoration>[] = [];
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    LOCAL_KEYWORD_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOCAL_KEYWORD_TOKEN_RE.exec(line.text)) !== null) {
      const from = line.from + m.index;
      ranges.push(Decoration.replace({ widget: new LocalKeywordWidget() }).range(from, from + m[0].length));
    }
  }
  return ranges;
};

const localKeywordField = StateField.define<Range<Decoration>[]>({
  create(state) {
    return buildKeywordRanges(state.doc);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildKeywordRanges(tr.newDoc);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => Decoration.set(v, true)),
});

interface EditorProps {
  note: NoteFile | null;
  allNotes: NoteFile[];
  vaultPath: string;
  onSaveContent: (filePath: string, content: string) => void;
  onWikiLinkClick: (targetTitle: string, blockId?: string) => void;
  scrollRequest?: { blockId?: string; line?: number; ts: number } | null;
  semanticRefreshToken?: number;
}

export const Editor: React.FC<EditorProps> = ({
  note,
  allNotes,
  vaultPath,
  onSaveContent,
  onWikiLinkClick,
  scrollRequest,
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
  const [blockMatches, setBlockMatches] = useState<BlockMatch[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Persisted dismissals (denied suggestions) for the active note. Lifted here
  // so the toolbar badge, LinkHub filtering and the approve/deny flows all see
  // the same set — dismissing every suggestion hides the Review button.
  const [deniedEntries, setDeniedEntries] = useState<DeniedLink[]>([]);
  const [deniedLoaded, setDeniedLoaded] = useState(false);
  const [linkHubVisible, setLinkHubVisible] = useState(
    () => localStorage.getItem('cerebro_linkhub_visible') !== 'false'
  );
  const [formatSnapshot, setFormatSnapshot] = useState<string | null>(null);
  const [linkHubHeight, setLinkHubHeight] = useState(() => {
    const saved = Number(localStorage.getItem('cerebro_linkhub_height'));
    return Number.isFinite(saved) && saved > 0 ? saved : 220;
  });
  const toggleLinkHub = (visible: boolean) => {
    setLinkHubVisible(visible);
    localStorage.setItem('cerebro_linkhub_visible', String(visible));
  };
  const resizeLinkHub = (delta: number) => {
    setLinkHubHeight((h) => {
      const next = Math.min(520, Math.max(140, h - delta));
      localStorage.setItem('cerebro_linkhub_height', String(next));
      return next;
    });
  };
  const scanDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScannedPathRef = useRef<string | null>(null);
  const lastSemanticScanRef = useRef(0);
  // Mirrors `previewScrollTop` without re-renders: used to restore the preview
  // viewport when switching back from edit mode (the preview div unmounts).
  const previewScrollTopRef = useRef(0);
  
  const timerRef = useRef<any>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const cmContainerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Authoritative latest content (mirrored in React state, refs, and the CM doc).
  const contentRef = useRef('');
  const dirtyRef = useRef(false);
  const noteRef = useRef(note);
  noteRef.current = note;
  const saveRef = useRef(onSaveContent);
  saveRef.current = onSaveContent;
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;
  const [previewScrollTop, setPreviewScrollTop] = useState(0);
  const [previewViewportHeight, setPreviewViewportHeight] = useState(0);
  // Target line + flash class for the preview mode block-jump highlight.
  const [previewHighlight, setPreviewHighlight] = useState<{ line: number; cls: string } | null>(null);
  // While a block-jump/scroll is in flight, render the full note (no windowed
  // rendering) so the target line element is guaranteed to be mounted.
  const [fullRender, setFullRender] = useState(false);
  // Target line (1-based) for the capped full-render band on huge notes.
  const [fullRenderAnchor, setFullRenderAnchor] = useState<number | null>(null);
  // Heavy paths are disabled for oversized notes (see LARGE_NOTE_CHARS).
  const isLargeNote = useMemo(
    () => (note?.content?.length ?? 0) > LARGE_NOTE_CHARS,
    [note?.content]
  );
  // Hidden local keywords (`---kw---`) declared in the note body, surfaced
  // only in the LinkHub. Oversized notes skip the per-keystroke token scan.
  const localKeywords = useMemo(
    () => (isLargeNote ? [] : extractKeywords(content)),
    [content, isLargeNote]
  );
  // Transient diagnostic message shown when a jump is performed (debug aid).
  const [jumpStatus, setJumpStatus] = useState<string | null>(null);
  const jumpStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashJumpStatus = (msg: string) => {
    setJumpStatus(msg);
    if (jumpStatusTimerRef.current) clearTimeout(jumpStatusTimerRef.current);
    jumpStatusTimerRef.current = setTimeout(() => setJumpStatus(null), 4000);
  };
  // Transient error shown when a duplicate local keyword is typed/added.
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const keywordErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashKeywordError = useCallback((msg: string) => {
    setKeywordError(msg);
    if (keywordErrorTimerRef.current) clearTimeout(keywordErrorTimerRef.current);
    keywordErrorTimerRef.current = setTimeout(() => setKeywordError(null), 4000);
  }, []);
  // Find-in-note state (shared by edit/preview modes).
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Latest mode, read from inside async/raf callbacks (not a hook dep).
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Pending block/line jump: request timestamp + resolved 1-based line.
  // Guards the jump effect so it executes exactly once per scrollRequest.
  const pendingJumpRef = useRef<{ ts: number; line: number } | null>(null);

  // Live local-keyword bookkeeping shared with the CodeMirror update listener:
  // latest AI keyword mentions (for auto-dismissal), the deny handler, and the
  // keyword set of the previous doc state (to detect newly typed keywords).
  const pendingMentionsRef = useRef<LinkMention[]>([]);
  pendingMentionsRef.current = pendingMentions;
  const denyLinkRef = useRef<typeof denyLink>(() => {});
  const prevKeywordsRef = useRef<Set<string>>(new Set());

  const noteTitles = useMemo(() => allNotes.map((n) => n.title), [allNotes]);

  // Splitting a multi-MB note per render (scroll events, preview frames) is
  // needless GC churn — the line array only changes with the content itself.
  const lines = useMemo(() => content.split('\n'), [content]);

  // Single funnel for programmatic content changes: keeps React state, refs,
  // and the CodeMirror doc in lockstep without triggering the autosave path
  // (the updateListener skips docs that already match contentRef).
  const updateContent = useCallback((next: string) => {
    contentRef.current = next;
    setContent(next);
    const view = viewRef.current;
    if (view) {
      const current = view.state.doc.toString();
      if (current !== next) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
      }
    }
  }, []);

  const forceSave = useCallback(() => {
    if (!dirtyRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    dirtyRef.current = false;
    setIsSaved(true);
    const path = noteRef.current?.path;
    if (path) saveRef.current(path, contentRef.current);
  }, []);

  const forceSaveRef = useRef(forceSave);
  forceSaveRef.current = forceSave;

  // Existing (already applied) outbound [[wikilinks]] in the note body.
  // The machine-generated footer is excluded since it holds target IDs, not links.
  const outboundLinks = useMemo<WikiLink[]>(() => {
    if (!content) return [];
    const footerIdx = content.indexOf('<!-- LINKER_START -->');
    const body = footerIdx >= 0 ? content.slice(0, footerIdx) : content;
    return extractWikiLinks(body).filter(
      (l) => l.targetTitle.toLowerCase() !== note?.title.toLowerCase()
    );
  }, [content, note?.title]);

  // Track preview scroll position for windowed rendering of large notes.
  // On (re)mount — i.e. when switching back to preview mode, the div is
  // recreated from scratch — restore the last scroll position so the viewport
  // doesn't reset to the start of the note.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || mode !== 'preview') return;
    el.scrollTop = previewScrollTopRef.current;
    const update = () => {
      previewScrollTopRef.current = el.scrollTop;
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
      .catch((e) => {
        console.error('Linker initialization failed:', e);
        appLogger.error('Linker initialization failed', e);
      });
  }, [vaultPath]);

  // Load persisted dismissals whenever the active note changes.
  useEffect(() => {
    let cancelled = false;
    setDeniedLoaded(false);
    if (!note) {
      setDeniedEntries([]);
      setDeniedLoaded(true);
      return;
    }
    linkerService
      .getDeniedLinks(note.path)
      .then((list) => {
        if (cancelled) return;
        setDeniedEntries(list);
        setDeniedLoaded(true);
      })
      .catch((e) => {
        console.error('Failed to load dismissed links:', e);
        appLogger.error(`Failed to load dismissed links for ${note.path}`, e);
        if (!cancelled) setDeniedLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.path]);

  // Stable keys (content-offset independent) so dismissals survive edits.
  const mentionKey = (m: LinkMention) => `keyword-${m.targetNoteId}-${m.matchedText}`;
  const semanticKey = (m: SemanticMatch) => `semantic-${m.note_id}`;
  const blockKey = (m: BlockMatch) => `block-${m.note_id}-${m.block_id}`;
  const deniedEntryKey = (d: DeniedLink) =>
    d.kind === 'semantic'
      ? `semantic-${d.target}`
      : d.kind === 'block'
        ? `block-${d.target}-${d.matched_text ?? ''}`
        : d.kind === 'outbound'
          ? `outbound-${d.target.toLowerCase()}`
          : d.kind === 'backlink'
            ? `backlink-${d.target.toLowerCase()}`
            : `keyword-${d.target}-${d.matched_text ?? ''}`;

  // Dismiss a suggestion (and mirror it in state so it vanishes immediately
  // without waiting for a re-scan). Keyword mentions are special: "unlink"
  // removes the mention *text* from the document itself (positions come from
  // the scan; the range is re-verified against the live doc before deleting,
  // so stale offsets never corrupt content). No persistent dismissal is
  // written for the delete path — the text is gone, and if the user retypes
  // the phrase later it should be suggestable again.
  const denyLink = useCallback(
    (kind: string, target: string, matchedText?: string | null, start?: number, end?: number) => {
      const path = note?.path;
      if (!path) return;
      const entry: DeniedLink = { kind, target, matched_text: matchedText ?? null };

      if (kind === 'keyword' && matchedText && typeof start === 'number' && typeof end === 'number') {
        const view = viewRef.current;
        if (view && view.state.doc.sliceString(start, end) === matchedText) {
          view.dispatch({ changes: { from: start, to: end, insert: '' } });
          return;
        }
      }

      setDeniedEntries((prev) => (prev.some((d) => deniedEntryKey(d) === deniedEntryKey(entry)) ? prev : [...prev, entry]));
      linkerService.addDeniedLink(path, kind, target, matchedText).catch((e) => {
        console.error('Failed to persist dismissal:', e);
      });
    },
    [note?.path]
  );
  denyLinkRef.current = denyLink;

  // Un-dismiss a link (single or all) so it can be suggested/approved again.
  const restoreDenied = useCallback(
    (entry?: DeniedLink) => {
      if (!note) return;
      if (entry) {
        setDeniedEntries((prev) => prev.filter((d) => deniedEntryKey(d) !== deniedEntryKey(entry)));
        linkerService
          .removeDeniedLink(note.path, entry.kind, entry.target, entry.matched_text)
          .catch((e) => console.error('Failed to restore link:', e));
      } else {
        setDeniedEntries([]);
        linkerService
          .removeDeniedLink(note.path)
          .catch((e) => console.error('Failed to restore links:', e));
      }
    },
    [note]
  );

  // Visible suggestion counts (denied entries excluded) drive the Review badge.
  const visibleSuggestions = useMemo(() => {
    const denied = new Set(deniedEntries.map(deniedEntryKey));
    const m = pendingMentions.filter((x) => !denied.has(mentionKey(x))).length;
    const r = relatedMatches.filter((x) => !denied.has(semanticKey(x))).length;
    const b = blockMatches.filter((x) => !denied.has(blockKey(x))).length;
    return { mentions: m, related: r, blocks: b, total: m + r + b };
  }, [deniedEntries, pendingMentions, relatedMatches, blockMatches]);

  // Unified scan: keyword mentions + backlinks + semantic related notes.
  // Oversized notes skip the keyword scan (no multi-MB IPC payload) and the
  // semantic queries (Rust refuses to embed them), but backlinks still work.
  // `forceSemantic` bypasses the throttle (note switch, backfill completion,
  // manual refresh); otherwise semantic queries run at most once per
  // SEMANTIC_SCAN_THROTTLE_MS so per-keystroke scans stay cheap.
  const runScan = async (overrideContent?: string, forceSemantic = false) => {
    if (!note) return;
    const targetContent = overrideContent ?? content;
    setIsScanning(true);
    setSemanticLoading(true);
    setLinkError(null);
    if (isLargeNote) {
      setPendingMentions([]);
      setRelatedMatches([]);
      setBlockMatches([]);
      // No blocking error: applied [[wikilinks]] (client-side regex) and
      // backlinks (SQLite) still show for oversized notes — only the heavy
      // keyword/semantic engines are skipped.
      setLinkError(null);
      // Backlinks are a pure SQLite query — still served for large notes.
      linkerService
        .getBacklinksForNote(note.path)
        .then((bl) => setIncomingBacklinks(bl))
        .catch((e) => {
          console.error('Backlink fetch failed:', e);
          appLogger.error(`Backlink fetch failed for ${note.path}`, e);
        })
        .finally(() => {
          setIsScanning(false);
          setSemanticLoading(false);
        });
      return;
    }
    const now = Date.now();
    const semanticDue = forceSemantic || now - lastSemanticScanRef.current >= SEMANTIC_SCAN_THROTTLE_MS;
    if (semanticDue) lastSemanticScanRef.current = now;
    // When throttled, resolve the semantic queries to null so their handlers
    // leave the currently displayed results untouched.
    const semanticQueries: [Promise<SemanticMatch[] | null>, Promise<BlockMatch[] | null>] =
      semanticDue
        ? [findSemanticRelatedNotes(note.path, 8), findSemanticBlockMatches(note.path, 8)]
        : [Promise.resolve(null), Promise.resolve(null)];
    try {
      const keywordPromise =
        dictionary.length > 0
          ? linkerService.scanUnlinkedMentions(targetContent, note.path, dictionary)
          : Promise.resolve<LinkMention[]>([]);

      const [mentionsRes, backlinksRes, relatedRes, blocksRes] = await Promise.allSettled([
        keywordPromise,
        linkerService.getBacklinksForNote(note.path),
        semanticQueries[0],
        semanticQueries[1],
      ]);

      if (mentionsRes.status === 'fulfilled') setPendingMentions(mentionsRes.value);
      else {
        console.error('Link scan failed:', mentionsRes.reason);
        appLogger.error(`Link scan failed for ${note.path}`, mentionsRes.reason);
      }

      if (backlinksRes.status === 'fulfilled') setIncomingBacklinks(backlinksRes.value);
      else {
        console.error('Backlink fetch failed:', backlinksRes.reason);
        appLogger.error(`Backlink fetch failed for ${note.path}`, backlinksRes.reason);
      }

      if (semanticDue && relatedRes.status === 'fulfilled' && relatedRes.value) {
        setRelatedMatches(relatedRes.value);
      } else if (semanticDue && relatedRes.status === 'rejected') {
        const reason =
          typeof relatedRes.reason === 'string' ? relatedRes.reason : String(relatedRes.reason);
        if (reason.includes('No embedding stored')) {
          // Note was never embedded: embed it on the spot, then retry once.
          try {
            await generateAndStoreEmbedding(note.path, targetContent);
            setRelatedMatches(await findSemanticRelatedNotes(note.path, 8));
          } catch (e2) {
            console.error('Semantic search failed after embedding:', e2);
            appLogger.error(`Semantic search failed after embedding for ${note.path}`, e2);
            setLinkError('Semantic index unavailable.');
          }
        } else {
          console.error('Semantic search failed:', relatedRes.reason);
          appLogger.error(`Semantic search failed for ${note.path}`, relatedRes.reason);
          setLinkError(reason);
        }
      }

      if (semanticDue && blocksRes.status === 'fulfilled' && blocksRes.value) {
        setBlockMatches(blocksRes.value);
      } else if (semanticDue && blocksRes.status === 'rejected') {
        const reason =
          typeof blocksRes.reason === 'string' ? blocksRes.reason : String(blocksRes.reason);
        if (reason.includes('No embedding stored')) {
          // Note has no whole-note embedding yet: embed + generate blocks, retry once.
          try {
            await generateAndStoreEmbedding(note.path, targetContent);
            setBlockMatches(await findSemanticBlockMatches(note.path, 8));
          } catch (e2) {
            console.error('Block search failed after embedding:', e2);
            appLogger.error(`Block search failed after embedding for ${note.path}`, e2);
          }
        } else {
          console.error('Block search failed:', blocksRes.reason);
          appLogger.error(`Block search failed for ${note.path}`, blocksRes.reason);
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
    setBlockMatches([]);
    setLinkError(null);
    runScan(note.content ?? '', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.path]);

  // Debounced re-scan while editing (skip the content jump from note switching).
  // Oversized notes are skipped: a per-keystroke scan would ship multi-MB
  // content over IPC — they're only scanned on open/save.
  useEffect(() => {
    if (!note) return;
    if (isLargeNote) return;
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
    const unlisten = listen('vault-changed', async (event) => {
      const payload = (event.payload ?? {}) as { path?: string; kind?: string };
      const changedPath = payload.path;

      // If the change is for the note we're viewing, reload just that file
      // from disk (no full-vault re-read) and rescan with the latest content.
      if (note && changedPath && changedPath === note.path) {
        try {
          const content = await tauriAPI.readFile(note.path);
          updateContent(content);
          runScanRef.current(content);
          return;
        } catch (e) {
          console.error('Failed to reload active note after vault change:', e);
          appLogger.error(`Failed to reload active note after vault change: ${note.path}`, e);
        }
      }
      // A different note changed: its backlink rows (mentions) pointing into
      // this note may have been added or purged — refresh this note's list so
      // stale entries vanish instead of lingering as ghosts.
      if (changedPath) {
        if (note) {
          linkerService
            .getBacklinksForNote(note.path)
            .then((bl) => setIncomingBacklinks(bl))
            .catch((e) => {
              console.error('Backlink refresh failed:', e);
              appLogger.error(`Backlink refresh failed for ${note.path}`, e);
            });
        }
        return;
      }
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
      runScanRef.current();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [note?.path, vaultPath]);

  // Re-scan once the once-per-session semantic backfill completes
  useEffect(() => {
    if (!note || semanticRefreshToken === 0) return;
    runScan(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticRefreshToken]);

  // Scroll the preview viewport so the given 1-based line is centered.
  // Deterministic approach: temporarily disables windowed rendering so the
  // target line's element is guaranteed to exist in the DOM, then centers it
  // via getBoundingClientRect and re-enables windowing ~2s later.
  const scrollPreviewToLine = useCallback((lineNo: number, onDone?: () => void) => {
    const el = previewRef.current;
    if (!el) {
      console.warn('[jump] preview container not mounted');
      onDone?.();
      return;
    }
    setFullRender(true);
    setFullRenderAnchor(lineNo);
    flashJumpStatus(`Scrolling to line ${lineNo}…`);
    // Snap the viewport to the target line (instant while the band is up).
    // Smooth scrolling over huge documents fights the band re-render: closing
    // the band swaps estimated spacer heights for real content heights, which
    // shifts the target's scroll coordinate mid-animation and lands the
    // viewport *past* the highlighted block. Instant + a final re-snap after
    // the band closes keeps the target in view.
    const snapToTarget = (): boolean => {
      const target = el.querySelector(`[data-line="${lineNo - 1}"]`) as HTMLElement | null;
      if (!target) return false;
      const targetTop = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const max = Math.max(el.scrollHeight - el.clientHeight, 0);
      const top = Math.max(0, Math.min(targetTop - el.clientHeight / 3, max));
      el.scrollTop = top;
      previewScrollTopRef.current = top;
      return true;
    };
    // One frame later the full render has committed and every line element is
    // mounted — the element query can no longer miss.
    requestAnimationFrame(() => {
      const found = snapToTarget();
      if (found) {
        console.log('[jump] preview snapped to line', lineNo);
        appLogger.info(`Block jump OK: preview scrolled to line ${lineNo}`);
        flashJumpStatus(`Scrolled to line ${lineNo}`);
      } else {
        console.warn('[jump] preview element NOT found for line', lineNo, '- using estimate');
        appLogger.warn(`Block jump: preview element NOT found for line ${lineNo} — estimate used`);
        const est = Math.max((lineNo - 1) * PREVIEW_LINE_HEIGHT - el.clientHeight / 3, 0);
        el.scrollTop = est;
        previewScrollTopRef.current = est;
        flashJumpStatus(`Element for line ${lineNo} not found — scrolled to estimate`);
      }
      onDone?.();
      setTimeout(() => {
        setFullRender(false);
        setFullRenderAnchor(null);
        // Re-snap now that the band is closed: the windowed spacers estimate
        // 28px/line, so the target's real coordinate has shifted.
        requestAnimationFrame(snapToTarget);
      }, 2000);
    });
  }, []);

  // Block-jump in preview mode: center the line, then flash-highlight it.
  const jumpPreview = useCallback(
    (lineNo: number) => {
      scrollPreviewToLine(lineNo, () => {
        setPreviewHighlight({
          line: lineNo,
          cls: `${Date.now() % 2 ? 'flash-b' : 'flash-a'}`,
        });
      });
    },
    [scrollPreviewToLine]
  );

  // Navigate to a linked block/heading or a specific source line: stays in the
  // current mode (preview or edit), scrolls the target line into view and
  // flash-highlights it. The target line is resolved against the *React*
  // `content` state (the source of truth for what the preview renders), so the
  // jump waits for the lazy-loaded note content to fully arrive — the effect
  // simply re-fires on the content change — and only then executes. The
  // pendingJumpRef guard makes the jump fire exactly once per scrollRequest,
  // so later keystrokes (content changes) never re-arm it. Block references
  // resolve explicit `^id` markers AND heading names via `findBlockLine`.
  useEffect(() => {
    if (!scrollRequest || !note) return;
    if (!scrollRequest.line && !scrollRequest.blockId) return;
    if (pendingJumpRef.current?.ts === scrollRequest.ts) return;

    const doc = content;
    console.log('[jump] effect fired', {
      blockId: scrollRequest.blockId,
      line: scrollRequest.line,
      ts: scrollRequest.ts,
      contentLen: content.length,
      mode: modeRef.current,
    });
    appLogger.info(
      `Block jump requested: ${note.title}${scrollRequest.blockId ? ` block "${scrollRequest.blockId}"` : ` line ${scrollRequest.line}`} (${modeRef.current} mode)`
    );
    let lineNo: number | null = null;
    if (scrollRequest.line && scrollRequest.line <= lines.length) {
      lineNo = scrollRequest.line;
    } else if (scrollRequest.blockId) {
      const idx = findBlockLine(doc, scrollRequest.blockId);
      if (idx !== null) lineNo = idx + 1;
    }
    // Content not loaded yet: wait for the lazy load to arrive (the `content`
    // dep re-fires this effect, possibly long after — no fixed timeout).
    if (lineNo === null) {
      console.warn('[jump] target not found yet (contentLen=' + content.length + '); waiting for content arrival');
      appLogger.warn(
        content.length === 0
          ? `Block jump queued — waiting for note content: ${note.title} (${scrollRequest.blockId ?? 'line ' + scrollRequest.line})`
          : `Block "${scrollRequest.blockId}" NOT found in note ${note.title}`
      );
      flashJumpStatus(
        content.length === 0
          ? `Jump queued — waiting for note content… (${scrollRequest.blockId ?? 'line ' + scrollRequest.line})`
          : `Block "${scrollRequest.blockId}" NOT found in this note`
      );
      return;
    }
    console.log('[jump] resolved line', lineNo, 'in mode', modeRef.current);
    appLogger.info(`Block jump resolved: ${note.title} -> line ${lineNo} (${modeRef.current} mode)`);
    flashJumpStatus(`Jumping to line ${lineNo} (${modeRef.current} mode)…`);

    // One frame later so any same-commit effects (e.g. the CodeMirror content
    // sync) have run, then perform the jump in the current mode. The guard is
    // committed inside the callback so a cancelled frame never loses the jump.
    const raf = requestAnimationFrame(() => {
      pendingJumpRef.current = { ts: scrollRequest.ts, line: lineNo };
      if (modeRef.current === 'preview') {
        // Preview mode: center the (already mounted) target line element and
        // flash-highlight it.
        jumpPreview(lineNo);
      } else {
        const view = viewRef.current;
        if (!view || lineNo > view.state.doc.lines) {
          console.warn('[jump] edit-mode view not ready', {
            hasView: !!view,
            docLines: view?.state.doc.lines,
            targetLine: lineNo,
          });
          appLogger.warn(`Block jump: edit-mode view not ready (line ${lineNo}) for ${note.title}`);
          return;
        }
        const pos = view.state.doc.line(lineNo).from;
        view.dispatch({
          effects: [
            EditorView.scrollIntoView(pos, { y: 'center' }),
            flashLineEffect.of({ line: lineNo, ts: Date.now() }),
          ],
        });
        view.focus();
        console.log('[jump] edit-mode jumped to line', lineNo);
        appLogger.info(`Block jump OK: edit mode scrolled to line ${lineNo}`);
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.ts, note?.path, content, jumpPreview]);

  // ---- Find-in-note ---------------------------------------------------------
  // Ctrl/Cmd+F opens the search overlay (and focuses the input); Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        requestAnimationFrame(() => {
          const inp = searchInputRef.current;
          if (inp) {
            inp.focus();
            inp.select();
          }
        });
      }
      if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSearchOpen]);

  // Recompute the shared match list whenever the content, query or case flag
  // changes (keeps the counter + preview highlights in sync with the doc).
  useEffect(() => {
    const ms = findMatches(content, isSearchOpen ? searchQuery : '', searchCaseSensitive);
    setMatches(ms);
    setActiveMatchIndex((i) => (ms.length ? Math.min(Math.max(i, 0), ms.length - 1) : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, searchQuery, searchCaseSensitive, isSearchOpen]);

  // Push the query + active index into the CodeMirror search decorations.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        setSearchQueryEffect.of({
          query: isSearchOpen ? searchQuery : '',
          caseSensitive: searchCaseSensitive,
        }),
        setSearchActiveEffect.of(activeMatchIndex),
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchCaseSensitive, activeMatchIndex, isSearchOpen]);

  // Navigate to the active match: scroll the editor or the preview viewport.
  // NOTE: no `view.focus()` here — while the search overlay is open the
  // CodeMirror view must NOT steal focus from the search input on every
  // keystroke (that's what made the input deselect after each character).
  useEffect(() => {
    if (!isSearchOpen) return;
    const m = matches[activeMatchIndex];
    if (!m) return;
    const view = viewRef.current;
    if (!view) return;
    if (modeRef.current === 'preview') {
      scrollPreviewToLine(m.line);
    } else {
      view.dispatch({ effects: [EditorView.scrollIntoView(m.from, { y: 'center' })] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatchIndex, matches, isSearchOpen]);

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      setActiveMatchIndex((i) => {
        if (matches.length === 0) return i;
        return (i + dir + matches.length) % matches.length;
      });
    },
    [matches.length]
  );

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchCaseSensitive(false);
    setMatches([]);
    setActiveMatchIndex(0);
  }, []);

  const titleByPath = useCallback(
    (path: string): string => {
      const found = allNotes.find((n) => n.path === path);
      return found ? found.title : path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? path;
    },
    [allNotes]
  );

  // Unlink an applied [[wikilink]]: strip the brackets, keeping the alias (or
  // the target title) as plain text. Used by the LinkHub "Unlink" button.
  const unlinkOutbound = (l: WikiLink) => {
    if (!note) return;
    const replacement = l.alias || l.targetTitle;
    const nextContent = content.replace(l.raw, replacement);
    if (nextContent === content) return;
    updateContent(nextContent);
    onSaveContent(note.path, nextContent);
  };

  // Approve a keyword suggestion: turn the matched text into a [[wiki link]].
  // Keyword suggestions carry the "@" prefix, so the alias keeps it.
  const approveMention = (mention: LinkMention) => {
    if (!note) return;
    const title =
      dictionary.find(([id]) => id === mention.targetNoteId)?.[1] ?? mention.targetNoteId;
    const replacement =
      mention.matchedText === title
        ? `[[${title}]]`
        : `[[${title}|@${mention.matchedText}]]`;
    const nextContent =
      content.slice(0, mention.start) + replacement + content.slice(mention.end);
    updateContent(nextContent);
    onSaveContent(note.path, nextContent);
    setPendingMentions((prev) => prev.filter((m) => m !== mention));
    restoreDenied({ kind: 'keyword', target: mention.targetNoteId, matched_text: mention.matchedText });
  };

  // Approve a semantic suggestion: append a [[wiki link]] to the target note
  const approveSemantic = (match: SemanticMatch) => {
    if (!note) return;
    const title = titleByPath(match.note_id);
    const nextContent = content.trimEnd() + `\n[[${title}]]`;
    updateContent(nextContent);
    onSaveContent(note.path, nextContent);
    setRelatedMatches((prev) => prev.filter((m) => m.note_id !== match.note_id));
    restoreDenied({ kind: 'semantic', target: match.note_id, matched_text: null });
  };

  // Locate the paragraph that produced a block suggestion in the target note
  // and ensure it carries the `^anchor`, so the created link can resolve.
  const ensureBlockAnchor = (targetContent: string, blockId: string, blockText: string): string => {
    if (targetContent.includes(`^${blockId}`)) return targetContent;
    const needle = blockText
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (needle) {
      const lines = targetContent.split('\n');
      const idx = lines.findIndex((l) => l.trim() === needle);
      if (idx >= 0) {
        lines[idx] = lines[idx].replace(/\s+\^[\w-]+\s*$/, '') + ` ^${blockId}`;
        return lines.join('\n');
      }
    }
    return targetContent.trimEnd() + `\n^${blockId}\n`;
  };

  // Approve a block suggestion: ensure the anchor exists in the target note,
  // then append a precise `[[Note#^block-id]]` link here. Target contents are
  // lazy-loaded (index_vault returns metadata only).
  const approveBlock = async (match: BlockMatch) => {
    if (!note) return;
    const target = allNotes.find((n) => n.path === match.note_id);
    const title = titleByPath(match.note_id);
    if (target) {
      let targetContent = target.content;
      if (!targetContent) {
        try {
          targetContent = await tauriAPI.readFile(target.path);
        } catch (e) {
          console.error('Failed to load target note content:', e);
          appLogger.error(`Failed to load target note content: ${target.path}`, e);
          return;
        }
      }
      const anchored = ensureBlockAnchor(targetContent, match.block_id, match.text);
      if (anchored !== targetContent) {
        onSaveContent(target.path, anchored);
      }
    }
    const nextContent = content.trimEnd() + `\n[[${title}#^${match.block_id}]]`;
    updateContent(nextContent);
    onSaveContent(note.path, nextContent);
    setBlockMatches((prev) =>
      prev.filter(
        (m) => !(m.note_id === match.note_id && m.block_id === match.block_id)
      )
    );
    restoreDenied({ kind: 'block', target: match.note_id, matched_text: match.block_id });
  };

  // Add a hidden local keyword via the LinkHub: append `---kw---` to the
  // note's first line and auto-dismiss any AI keyword suggestion for the same
  // term (the manual keyword wins).
  const addLocalKeyword = (raw: string) => {
    if (!note) return;
    const kw = normalizeKeyword(raw);
    if (!kw) return;
    if (localKeywords.some((k) => k.toLowerCase() === kw.toLowerCase())) {
      flashKeywordError(`Keyword "${kw}" already exists`);
      return;
    }
    for (const m of pendingMentions) {
      if (m.matchedText.replace(/^@/, '').toLowerCase() === kw.toLowerCase()) {
        denyLink('keyword', m.targetNoteId, m.matchedText);
      }
    }
    const lines = content.split('\n');
    const token = keywordToken(kw);
    if (lines.length === 0 || lines[0].trim() === '') {
      lines[0] = token;
    } else {
      lines[0] = `${lines[0].trimEnd()} ${token}`;
    }
    const next = lines.join('\n');
    updateContent(next);
    onSaveContent(note.path, next);
  };

  // Delete a hidden local keyword from the LinkHub: remove the `---kw---`
  // token from the note body entirely (nothing lingers as hidden text).
  const deleteLocalKeyword = (kw: string) => {
    if (!note) return;
    const targets = findKeywordRanges(content)
      .filter((r) => r.keyword.toLowerCase() === kw.toLowerCase())
      .sort((a, b) => b.start - a.start);
    if (targets.length === 0) return;
    let next = content;
    for (const r of targets) {
      if (next[r.start - 1] === ' ') {
        next = next.slice(0, r.start - 1) + next.slice(r.end);
      } else {
        next = next.slice(0, r.start) + next.slice(r.end);
      }
    }
    updateContent(next);
    onSaveContent(note.path, next);
  };

  // Insert a generated block anchor (^id) on the current paragraph and copy a
  // `[[Note#^id]]` link to the clipboard so it can be linked from elsewhere.
  const insertBlockAnchor = () => {
    if (!note) return;
    let lineIdx: number;
    const view = viewRef.current;
    if (mode === 'edit' && view) {
      const head = view.state.selection.main.head;
      lineIdx = view.state.doc.lineAt(head).number - 1;
    } else {
      lineIdx = Math.max(0, content.split('\n').length - 1);
    }
    const lines = content.split('\n');
    let start = lineIdx;
    while (start > 0 && lines[start - 1].trim() !== '') start--;
    if (lines[start].trim() === '') return;
    const id = `block-${Math.random().toString(36).slice(2, 8)}`;
    const stripped = lines[start].replace(/\s+\^[\w-]+\s*$/, '');
    lines[start] = `${stripped} ^${id}`;
    const nextContent = lines.join('\n');
    updateContent(nextContent);
    onSaveContent(note.path, nextContent);
    navigator.clipboard
      .writeText(`[[${note.title}#^${id}]]`)
      .catch(() => {
        console.error('Failed to copy link to clipboard');
        appLogger.error('Failed to copy block link to clipboard');
      });
  };

  // Format the note: normalize headings/spacing and keep H1 in sync with title.
  const handleFormat = () => {
    if (!note) return;
    const formatted = formatNote(content, note.title);
    if (formatted === content) return;
    setFormatSnapshot(content);
    updateContent(formatted);
    onSaveContent(note.path, formatted);
  };

  const handleUndoFormat = () => {
    if (!note || formatSnapshot === null) return;
    updateContent(formatSnapshot);
    onSaveContent(note.path, formatSnapshot);
    setFormatSnapshot(null);
  };

  // Sync content state when note changes. Deps are scoped to path + content:
  // runs on note switch and on lazy content arrival, but not on unrelated
  // metadata updates (updatedAt, refresh recreations with same content).
  const lastNotePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (note) {
      // Reset the preview viewport + jump highlight when the note itself
      // changes (not on every content refresh of the same note).
      if (lastNotePathRef.current !== note.path) {
        lastNotePathRef.current = note.path;
        setPreviewScrollTop(0);
        previewScrollTopRef.current = 0;
        setPreviewHighlight(null);
        const el = previewRef.current;
        if (el) el.scrollTop = 0;
      }
      // For oversized notes, skip the CodeMirror dispatch entirely: the CM
      // effect below re-creates the editor (plain-text, deps isLargeNote) with
      // the loaded content as its initial doc, so a 4MB full-doc replace into
      // a markdown editor (Lezer re-parse) never happens.
      if ((note.content ?? '').length > LARGE_NOTE_CHARS) {
        contentRef.current = note.content ?? '';
        setContent(note.content ?? '');
      } else {
        updateContent(note.content ?? '');
      }
      setIsSaved(true);
      setPendingMentions([]);
    } else {
      updateContent('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.path, note?.content]);

  // Clean up timers
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
      if (keywordErrorTimerRef.current) clearTimeout(keywordErrorTimerRef.current);
    };
  }, []);

// CodeMirror 6 editor: recreated per note. The updateListener feeds React
  // state + debounced autosave; programmatic syncs (updateContent) are skipped
  // because the doc already matches contentRef. Notes above LARGE_NOTE_CHARS
  // get a plain-text editor (no markdown()/highlighting): the Lezer parse +
  // decoration tree of a multi-MB doc spikes CPU/RAM, and syntax highlighting
  // is worthless on PDF-extracted textbooks.
  useEffect(() => {
    const container = cmContainerRef.current;
    if (!container || !note) return;
    const initial = note.content ?? '';
    contentRef.current = initial;
    prevKeywordsRef.current = new Set(extractKeywords(initial).map((k) => k.toLowerCase()));

    const sharedExtensions = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      oneDark,
      cmTheme,
      flashField,
      searchField,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (!u.docChanged) return;
        const doc = u.state.doc.toString();
        if (doc === contentRef.current) return; // programmatic sync, not typing
        contentRef.current = doc;
        setContent(doc);
        dirtyRef.current = true;
        setIsSaved(false);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          dirtyRef.current = false;
          setIsSaved(true);
          const path = noteRef.current?.path;
          if (path) saveRef.current(path, doc);
        }, SAVE_DEBOUNCE_MS);

        // Hidden local-keyword bookkeeping (skipped for oversized notes: a
        // per-keystroke full-doc regex is too costly on multi-MB files).
        if (!isLargeNote) {
          const ranges = findKeywordRanges(doc);
          const seen = new Map<string, number>();
          const dupes: { keyword: string; start: number; end: number }[] = [];
          for (const r of ranges) {
            const key = r.keyword.toLowerCase();
            if (seen.has(key)) {
              dupes.push(r);
            } else {
              seen.set(key, r.start);
            }
          }
          const kept = new Set(seen.keys());
          if (dupes.length > 0) {
            // Duplicate keyword typed: revert the user's keystrokes (keep the
            // first occurrence, delete the rest) and surface an error.
            dupes.sort((a, b) => b.start - a.start);
            u.view.dispatch({
              changes: dupes.map((d) => ({ from: d.start, to: d.end, insert: '' })),
            });
            flashKeywordError(`Keyword "${dupes[0].keyword}" already exists`);
          }
          // Newly written keywords: dismiss any matching AI keyword
          // suggestion so it never lingers as a duplicate suggestion.
          const prev = prevKeywordsRef.current;
          for (const kw of kept) {
            if (prev.has(kw)) continue;
            for (const m of pendingMentionsRef.current) {
              if (m.matchedText.replace(/^@/, '').toLowerCase() === kw) {
                denyLinkRef.current('keyword', m.targetNoteId, m.matchedText);
              }
            }
          }
          prevKeywordsRef.current = kept;
        }
      }),
      EditorView.domEventHandlers({
        click: (event, view) => {
          // Ctrl/Cmd+click on a wiki or standard markdown link navigates to
          // the target note (opening + scrolling to the block if linked).
          if (!event.ctrlKey && !event.metaKey) return;
          const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (at == null) return;
          const line = view.state.doc.lineAt(at);
          const link = findLinkAtOffset(line.text, at - line.from);
          if (link && !link.external) {
            event.preventDefault();
            onWikiLinkClickRef.current(link.targetTitle, link.blockId);
          }
        },
        blur: () => {
          forceSaveRef.current();
          runScanRef.current();
        },
      }),
    ];
    if (!isLargeNote) {
      sharedExtensions.push(markdown(), syntaxHighlighting(defaultHighlightStyle));
      sharedExtensions.push(topicTagField);
      sharedExtensions.push(localKeywordField);
    }

    const state = EditorState.create({
      doc: initial,
      extensions: sharedExtensions,
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.path, isLargeNote]);

  // All React hooks are declared above this point: `note` may be null for the
  // rest of the render, but no hook is allowed after a conditional return.
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

  // Splits a trailing block anchor (" ^block-abc123") off a preview line so
  // the raw id stays out of the rendered note — replaced by a subtle icon.
  // Edit mode keeps the full id in the source text; only preview hides it.
  const splitTrailingAnchor = (line: string): { text: string; anchor: string | null } => {
    const m = line.match(/^(.*?)\s+\^([\w-]+)\s*$/);
    return m ? { text: m[1], anchor: m[2] } : { text: line, anchor: null };
  };

  const BlockAnchorIcon: React.FC<{ id: string }> = ({ id }) => (
    <span
      className="inline-flex items-center gap-0.5 align-middle mx-1 text-slate-600 hover:text-orange-400/70 cursor-help transition-colors"
      title={`Block anchor: ^${id}`}
    >
      <Anchor className="w-2.5 h-2.5" />
    </span>
  );

  // Simple Markdown Parsing Renderer for preview mode (renders a window of lines)
  const renderMarkdown = (lines: string[], startIndex: number) => {
    return (
      <div className="space-y-3">
        {lines.map((line, i) => {
          const lineIdx = startIndex + i;
          // Hidden local keywords are stripped before anything else so they
          // never render in preview (the LinkHub is their only surface).
          const strippedLine = stripKeywordTokens(line);
          const { text: rawLine, anchor: lineAnchor } = splitTrailingAnchor(strippedLine);
          const trimmedLine = rawLine.trim();
          // 1-based line number: matches the block-jump highlight (lineNo).
          const flashCls =
            previewHighlight && previewHighlight.line === lineIdx + 1
              ? ` block-highlight ${previewHighlight.cls}`
              : '';
          const anchorNode = lineAnchor ? <BlockAnchorIcon id={lineAnchor} /> : null;

          // 1. Headers
          if (trimmedLine.startsWith('# ')) {
            return (
              <h1 key={lineIdx} data-line={lineIdx} className={`text-2xl font-bold text-slate-100 border-b border-slate-800/80 pb-1 mt-6 mb-2${flashCls}`}>
                {renderInlineElements(rawLine.substring(2), lineIdx + 1)}
                {anchorNode}
              </h1>
            );
          }
          if (trimmedLine.startsWith('## ')) {
            return (
              <h2 key={lineIdx} data-line={lineIdx} className={`text-xl font-bold text-slate-200 mt-5 mb-2${flashCls}`}>
                {renderInlineElements(rawLine.substring(3), lineIdx + 1)}
                {anchorNode}
              </h2>
            );
          }
          if (trimmedLine.startsWith('### ')) {
            return (
              <h3 key={lineIdx} data-line={lineIdx} className={`text-lg font-semibold text-slate-300 mt-4 mb-2${flashCls}`}>
                {renderInlineElements(rawLine.substring(4), lineIdx + 1)}
                {anchorNode}
              </h3>
            );
          }
          if (trimmedLine.startsWith('#### ')) {
            return (
              <h4 key={lineIdx} data-line={lineIdx} className={`text-base font-semibold text-slate-300 mt-3 mb-1.5${flashCls}`}>
                {renderInlineElements(rawLine.substring(5), lineIdx + 1)}
                {anchorNode}
              </h4>
            );
          }
          if (trimmedLine.startsWith('##### ')) {
            return (
              <h5 key={lineIdx} data-line={lineIdx} className={`text-sm font-semibold text-slate-400 mt-3 mb-1.5${flashCls}`}>
                {renderInlineElements(rawLine.substring(6), lineIdx + 1)}
                {anchorNode}
              </h5>
            );
          }
          if (trimmedLine.startsWith('###### ')) {
            return (
              <h6 key={lineIdx} data-line={lineIdx} className={`text-sm font-medium text-slate-500 mt-2 mb-1${flashCls}`}>
                {renderInlineElements(rawLine.substring(7), lineIdx + 1)}
                {anchorNode}
              </h6>
            );
          }

          // 2. Unordered List Items
          if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
            return (
              <ul key={lineIdx} data-line={lineIdx} className={`list-disc pl-6 text-sm text-slate-300${flashCls}`}>
                <li>
                  {renderInlineElements(rawLine.substring(2), lineIdx + 1)}
                  {anchorNode}
                </li>
              </ul>
            );
          }

          // 3. Blockquotes
          if (trimmedLine.startsWith('> ')) {
            return (
              <blockquote key={lineIdx} data-line={lineIdx} className={`border-l-4 border-orange-500/50 bg-slate-900/40 px-4 py-2 my-2 rounded-r-lg text-sm italic text-slate-300 font-sans${flashCls}`}>
                {renderInlineElements(rawLine.substring(2), lineIdx + 1)}
                {anchorNode}
              </blockquote>
            );
          }

          // 4. Code block markers (very simple parser)
          if (trimmedLine.startsWith('```')) {
            return <hr key={lineIdx} data-line={lineIdx} className={`border-slate-800 my-2${flashCls}`} />; // Render separator for code borders
          }

          // 5. Empty lines
          if (trimmedLine === '') {
            return <div key={lineIdx} data-line={lineIdx} className={`h-2${flashCls}`} />;
          }

          // 6. Regular paragraphs
          return (
            <p key={lineIdx} data-line={lineIdx} className={`text-sm text-slate-300 leading-relaxed font-sans${flashCls}`}>
              {renderInlineElements(rawLine, lineIdx + 1)}
              {anchorNode}
            </p>
          );
        })}
      </div>
    );
  };

  // Renders inline text and extracts Bold, Code tags, and Wiki links
  const renderInlineElements = (lineText: string, lineNo?: number) => {
    const segments = segmentContent(lineText, noteTitles);
    // Matches belonging to this rendered line (for the active note content).
    const lineMatches = lineNo !== undefined ? matches.filter((m) => m.line === lineNo) : [];
    const activeMatch = isSearchOpen ? matches[activeMatchIndex] : undefined;

    // Wraps "@Topic" keyword tokens in topic pills — visually distinct from
    // wiki links, because they are groupings, not notes (and the linker never
    // treats them as mentions). The lookbehind mirrors the backend tag
    // boundary rule: `text@topic` is not a tag, `text @topic` is.
    const renderTopicTags = (text: string): React.ReactNode => {
      if (!text) return text;
      const parts = text.split(/(?<![A-Za-z0-9_])@([A-Za-z][\w-]*)/g);
      if (parts.length === 1) return text;
      return parts.map((part, pIdx) =>
        pIdx % 2 === 1 ? (
          <span key={`t${pIdx}`} className="topic-tag">
            @{part}
          </span>
        ) : (
          part
        )
      );
    };

    // Wraps search matches inside a plain-text run with highlight classes.
    const wrapSearchText = (text: string, segStart: number): React.ReactNode => {
      if (lineMatches.length === 0) return renderTopicTags(text);
      if (!text) return text;
      const pieces: React.ReactNode[] = [];
      let i = 0;
      const relMatches = lineMatches.filter((m) => m.ch >= segStart && m.ch < segStart + text.length);
      for (const m of relMatches) {
        const relStart = m.ch - segStart;
        const relEnd = m.to - segStart;
        if (relStart > i) pieces.push(renderTopicTags(text.slice(i, relStart)));
        const isActive = activeMatch && m.from === activeMatch.from;
        pieces.push(
          <span
            key={`m${m.from}`}
            className={isActive ? 'search-match search-match-active' : 'search-match'}
          >
            {text.slice(relStart, relEnd)}
          </span>
        );
        i = relEnd;
      }
      if (i < text.length) pieces.push(renderTopicTags(text.slice(i)));
      return pieces.length ? pieces : text;
    };

    let charOffset = 0;

    return segments.map((seg, idx) => {
      // Standard markdown link to an external URL: styled but not navigable
      // inside the vault (no note to open).
      if (seg.type === 'wiki-link' && seg.external) {
        charOffset += seg.content.length;
        return (
          <span key={idx} className="wiki-link-external" title={seg.target}>
            {seg.alias || seg.target}
          </span>
        );
      }

      if (seg.type === 'wiki-link' && seg.target) {
        charOffset += seg.content.length;
        return (
          <span
            key={idx}
            onClick={() => onWikiLinkClick(seg.target!, seg.blockId)}
            className={`wiki-link ${!seg.exists ? 'wiki-link-uncreated' : ''}`}
            title={
              seg.exists
                ? `Navigate to ${seg.target}${seg.blockId ? ` (${seg.blockId})` : ''}`
                : `Create note "${seg.target}"`
            }
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
        let runOffset = charOffset;
        contentNode = parts.map((part, pIdx) => {
          const node: React.ReactNode =
            pIdx % 2 === 1 ? (
              <strong key={`p${pIdx}`} className="font-bold text-slate-100">{part}</strong>
            ) : (
              wrapSearchText(part, runOffset)
            );
          // Advance past this part + the `**` markers (2 chars) between parts.
          runOffset += part.length + (pIdx < parts.length - 1 ? 2 : 0);
          return node;
        });
      } else if (lineMatches.length > 0) {
        contentNode = wrapSearchText(seg.content, charOffset);
      } else {
        contentNode = renderTopicTags(seg.content);
      }

      charOffset += seg.content.length;
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
    <div className="editor-container relative flex-1 bg-slate-900/10 flex flex-col h-full overflow-hidden">
      
      {/* Find-in-note overlay */}
      {isSearchOpen && (
        <div className="absolute top-16 right-6 z-20 flex items-center gap-1.5 bg-slate-950/95 border border-slate-800 rounded-lg shadow-xl px-2 py-1.5">
          <Search className="w-3.5 h-3.5 text-orange-400 shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) goToMatch(-1);
                else goToMatch(1);
              }
              if (e.key === 'Escape') closeSearch();
            }}
            placeholder="Find in note…"
            className="w-52 bg-transparent text-xs text-slate-200 placeholder:text-slate-600 outline-none"
          />
          <button
            onClick={() => setSearchCaseSensitive((v) => !v)}
            title="Match case"
            className={`px-1.5 py-0.5 text-[10px] font-bold rounded border transition-all ${
              searchCaseSensitive
                ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            Aa
          </button>
          <span className="text-[10px] text-slate-500 whitespace-nowrap text-center min-w-12 tabular-nums">
            {searchQuery
              ? `${matches.length ? activeMatchIndex + 1 : 0}/${matches.length}`
              : ''}
          </span>
          <button
            onClick={() => goToMatch(-1)}
            title="Previous match (Shift+Enter)"
            className="p-0.5 text-slate-400 hover:text-orange-400 transition-colors"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => goToMatch(1)}
            title="Next match (Enter)"
            className="p-0.5 text-slate-400 hover:text-orange-400 transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={closeSearch}
            title="Close (Esc)"
            className="p-0.5 text-slate-500 hover:text-red-400 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Jump status badge (debug aid for block-link navigation) */}
      {jumpStatus && (
        <div className="absolute top-16 left-6 z-20 flex items-center gap-1.5 bg-slate-950/95 border border-orange-500/30 rounded-lg shadow-xl px-3 py-1.5 text-[11px] text-orange-300">
          {jumpStatus}
        </div>
      )}

      {/* Duplicate local-keyword error */}
      {keywordError && (
        <div className="absolute top-28 left-6 z-20 flex items-center gap-1.5 bg-red-950/95 border border-red-500/40 rounded-lg shadow-xl px-3 py-1.5 text-[11px] text-red-300">
          <X className="w-3 h-3" /> {keywordError}
        </div>
      )}

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
            pendingCount={visibleSuggestions.total}
            isScanning={isScanning}
            isReady={isLinkerReady && dictionary.length > 0}
            isPanelOpen={linkHubVisible}
            onScan={runScan}
            onToggleLinks={() => toggleLinkHub(!linkHubVisible)}
          />
          <button
            onClick={() => {
              setIsSearchOpen(true);
              requestAnimationFrame(() => {
                const inp = searchInputRef.current;
                if (inp) {
                  inp.focus();
                  inp.select();
                }
              });
            }}
            title="Find in note (Ctrl/Cmd+F)"
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-800 text-slate-400 hover:text-orange-400 hover:border-orange-500/40 transition-all"
          >
            <Search className="w-3.5 h-3.5" /> Find
          </button>
          <button
            onClick={insertBlockAnchor}
            title="Insert a block anchor (^id) on this paragraph and copy a [[Note#^id]] link"
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-800 text-slate-400 hover:text-orange-400 hover:border-orange-500/40 transition-all"
          >
            <Anchor className="w-3.5 h-3.5" /> Block
          </button>
          <button
            onClick={handleFormat}
            title="Format this note (normalize headings & spacing, sync H1 to filename)"
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-800 text-slate-400 hover:text-orange-400 hover:border-orange-500/40 transition-all"
          >
            <Wand2 className="w-3.5 h-3.5" /> Format
          </button>
          <button
            onClick={handleUndoFormat}
            disabled={formatSnapshot === null}
            title="Undo the last formatting action"
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-800 text-slate-400 hover:text-orange-400 hover:border-orange-500/40 transition-all disabled:opacity-40 disabled:hover:text-slate-400 disabled:hover:border-slate-800"
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </button>
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
        {/* CodeMirror editor: always mounted so scroll/highlight state survives
            mode switches; hidden (display:none) while in preview. */}
        <div
          ref={cmContainerRef}
          className={`flex-1 w-full overflow-hidden ${mode === 'edit' ? '' : 'hidden'}`}
        />
        {mode === 'preview' && (
          <div
            ref={previewRef}
            className="markdown-body flex-1 overflow-y-auto px-8 py-6 max-w-4xl mx-auto w-full select-text selection:bg-orange-500/30 selection:text-white"
          >
            {content.length === 0 ? (
              <div className="text-slate-600 italic text-xs">This note is empty. Click "Edit" to add content.</div>
            ) : (
              (() => {
                const totalLines = lines.length;
                const totalHeight = totalLines * PREVIEW_LINE_HEIGHT;
                const windowed = previewViewportHeight > 0 && !fullRender;
                let start: number;
                let end: number;
                if (windowed) {
                  start = Math.max(0, Math.floor(previewScrollTop / PREVIEW_LINE_HEIGHT) - PREVIEW_BUFFER);
                  end = Math.min(totalLines, Math.ceil((previewScrollTop + previewViewportHeight) / PREVIEW_LINE_HEIGHT) + PREVIEW_BUFFER);
                } else if (totalLines > MAX_FULL_RENDER_LINES && fullRenderAnchor != null) {
                  // Huge note during a jump: render a band around the target
                  // line instead of all ~100k lines. The target element is
                  // guaranteed inside the band.
                  const anchor = fullRenderAnchor - 1;
                  start = Math.max(0, anchor - FULL_RENDER_BAND);
                  end = Math.min(totalLines, anchor + FULL_RENDER_BAND + 1);
                } else {
                  start = 0;
                  end = totalLines;
                }
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
      {linkHubVisible ? (
        <div
          className="border-t border-slate-900/80 bg-slate-950/30 shrink-0 flex flex-col"
          style={{ height: linkHubHeight }}
        >
          <ResizeHandle
            direction="vertical"
            onResize={resizeLinkHub}
            className="self-stretch"
          />
          <div className="flex-1 min-h-0 overflow-hidden">
            <LinkHub
              mentions={pendingMentions}
              backlinks={incomingBacklinks}
              related={relatedMatches}
              blocks={blockMatches}
              outbound={outboundLinks}
              keywords={localKeywords}
              onAddKeyword={addLocalKeyword}
              onDeleteKeyword={deleteLocalKeyword}
              notePath={note.path}
              dictionary={dictionary}
              allNotes={allNotes}
              isLoading={isScanning || semanticLoading}
              error={linkError}
              deniedEntries={deniedEntries}
              deniedLoaded={deniedLoaded}
              onWikiLinkClick={onWikiLinkClick}
              onApproveMention={approveMention}
              onApproveSemantic={approveSemantic}
              onApproveBlock={approveBlock}
              onUnlinkLink={unlinkOutbound}
              onDeny={denyLink}
              onRestore={restoreDenied}
              onRefresh={() => runScan(undefined, true)}
              onCollapse={() => toggleLinkHub(false)}
            />
          </div>
        </div>
      ) : (
        <button
          onClick={() => toggleLinkHub(true)}
          className="shrink-0 w-full flex items-center justify-center gap-2 py-1.5 border-t border-slate-900/80 bg-slate-950/30 text-[10px] font-semibold text-slate-500 hover:text-orange-400 transition-colors"
          title="Show links panel"
        >
          <Link2 className="w-3.5 h-3.5" />
          Show Links
          <ChevronUp className="w-3 h-3" />
        </button>
      )}

    </div>
  );
};

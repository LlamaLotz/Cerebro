import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  TerminalSquare,
  X,
  Trash2,
  Minimize2,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';
import { useIngestion, LogEntry, IngestionProgress } from '../services/ingestionStore';

type FilterLevel = 'all' | LogEntry['level'];

// Default expanded-window size (matches the previous fixed drawer).
const PANEL_W = 640;
const PANEL_H = 500;

const LEVEL_STYLES: Record<LogEntry['level'], { dot: string; label: string }> = {
  info: { dot: 'bg-sky-400', label: 'text-sky-400' },
  success: { dot: 'bg-emerald-400', label: 'text-emerald-400' },
  warn: { dot: 'bg-amber-400', label: 'text-amber-400' },
  error: { dot: 'bg-rose-400', label: 'text-rose-400' },
};

const STATUS_META: Record<IngestionProgress['status'], { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-slate-500' },
  ingesting: { label: 'Ingesting', dot: 'bg-brand-400 animate-pulse' },
  paused: { label: 'Paused', dot: 'bg-amber-400' },
  completed: { label: 'Completed', dot: 'bg-emerald-400' },
  error: { label: 'Error', dot: 'bg-rose-400' },
};

const FILTERS: { value: FilterLevel; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'success', label: 'Success' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
];

export const IngestionLogPanel: React.FC = () => {
  const { logs, progress, isMinimized, setMinimized, isHidden, setHidden, clearLogs } = useIngestion();
  const [filter, setFilter] = useState<FilterLevel>('all');
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Floating-window behavior: the log window floats freely. Both the
  // collapsed badge and the expanded window share one position (persisted).
  const POS_KEY = 'prism_log_position';
  const loadPos = (): { x: number; y: number } | null => {
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (!saved) return null;
      const p = JSON.parse(saved);
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
    } catch {
      return null;
    }
  };
  const [pos, setPosState] = useState<{ x: number; y: number } | null>(loadPos);
  const setPos = (p: { x: number; y: number }) => {
    setPosState(p);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(p));
    } catch {
      // Storage unavailable — the in-memory position still applies.
    }
  };

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    moved: boolean;
    el: HTMLElement;
  } | null>(null);
  // Set after a real drag so the badge's click-to-expand doesn't fire on the
  // click that ends a drag; cleared immediately after that click processes.
  const justDraggedRef = useRef(false);

  // Free dragging: the element follows the pointer exactly (delta from the
  // grab point) and keeps the position on release, clamped so the window can
  // never be dragged fully off-screen. Move/up are tracked on window (not via
  // pointer capture on the element), so the drag can never be lost when the
  // pointer leaves the element.
  const makeDragHandlers = (getEl: () => HTMLElement | null) => {
    const winMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.el.isConnected) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
      // Clamp while dragging so the window can never go outside the app
      // window — not even temporarily mid-drag.
      const left = Math.max(0, Math.min(window.innerWidth - drag.el.offsetWidth, drag.startLeft + dx));
      const top = Math.max(0, Math.min(window.innerHeight - drag.el.offsetHeight, drag.startTop + dy));
      drag.el.style.left = `${left}px`;
      drag.el.style.top = `${top}px`;
    };
    const winEnd = (ev: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      window.removeEventListener('pointermove', winMove);
      window.removeEventListener('pointerup', winEnd);
      window.removeEventListener('pointercancel', winEnd);
      if (!drag || !drag.el.isConnected) return;
      if (drag.moved) {
        justDraggedRef.current = true;
        // The click that closes a drag dispatches right after this event.
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);
      }
      // Commit the final position, clamped to the viewport.
      const w = drag.el.offsetWidth;
      const h = drag.el.offsetHeight;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - w, drag.startLeft + (ev.clientX - drag.startX))),
        y: Math.max(0, Math.min(window.innerHeight - h, drag.startTop + (ev.clientY - drag.startY))),
      });
    };
    return {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const el = getEl();
        if (!el) return;
        const rect = el.getBoundingClientRect();
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startLeft: rect.left,
          startTop: rect.top,
          moved: false,
          el,
        };
        window.addEventListener('pointermove', winMove);
        window.addEventListener('pointerup', winEnd);
        window.addEventListener('pointercancel', winEnd);
      },
    };
  };

  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelHandlers = makeDragHandlers(() => panelRef.current);

  const badgeRef = useRef<HTMLButtonElement | null>(null);
  const [badgeSize, setBadgeSize] = useState<{ w: number; h: number } | null>(null);
  // Measure the badge so it sits flush in the corner regardless of its content
  // width (percent, file name, log count).
  useLayoutEffect(() => {
    if (!isMinimized || isHidden) return;
    const el = badgeRef.current;
    if (!el) return;
    const update = () => setBadgeSize({ w: el.offsetWidth, h: el.offsetHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMinimized, isHidden]);

  const filteredLogs = useMemo(
    () => (filter === 'all' ? logs : logs.filter((l) => l.level === filter)),
    [logs, filter]
  );

  // Auto-scroll to the newest entry unless the user has scrolled up
  useEffect(() => {
    if (stickToBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filteredLogs]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // Copy the currently visible log entries to the clipboard as plain text.
  const handleCopyLogs = async () => {
    const text = filteredLogs
      .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      console.error('Failed to copy logs:', e);
    }
  };

  const statusMeta = STATUS_META[progress.status];
  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : progress.status === 'ingesting'
        ? null
        : 0;
  const barColor =
    progress.status === 'completed'
      ? 'bg-emerald-400'
      : progress.status === 'error'
        ? 'bg-rose-400'
        : progress.status === 'ingesting'
          ? 'bg-brand-400'
          : 'bg-slate-500';

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // Hidden (X): nothing to render. The sidebar Logs button and the first
  // ingestion log both reveal the panel (setHidden(false)).
  if (isHidden) return null;

  // Minimized: floating status badge (free-draggable like the expanded
  // window), persistent across all views
  if (isMinimized) {
    const badgeHandlers = makeDragHandlers(() => badgeRef.current);
    const bw = badgeSize?.w ?? 0;
    const bh = badgeSize?.h ?? 0;
    return (
      <button
        ref={badgeRef}
        onPointerDown={badgeHandlers.onPointerDown}
        onClick={() => {
          if (justDraggedRef.current) return;
          setMinimized(false);
        }}
        className="fixed z-50 flex items-center gap-2.5 pl-3 pr-3.5 py-2 rounded-xl bg-slate-950/95 border border-slate-800 shadow-2xl shadow-black/50 backdrop-blur hover:border-brand-500/40 transition-colors group cursor-grab active:cursor-grabbing touch-none select-none"
        style={{
          left: pos ? Math.min(pos.x, window.innerWidth - bw) : window.innerWidth - bw - 16,
          top: pos ? Math.min(pos.y, window.innerHeight - bh) : window.innerHeight - bh - 16,
        }}
        title="Open ingestion log (drag to move)"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusMeta.dot}`} />
        <span className="text-[11px] font-bold text-slate-200 uppercase tracking-wider">
          {statusMeta.label}
        </span>
        {percent !== null && (
          <span className="text-[11px] font-mono text-brand-400">{percent}%</span>
        )}
        {progress.currentFileName && (
          <span className="text-[10px] text-slate-500 max-w-[140px] truncate">
            {truncate(progress.currentFileName, 28)}
          </span>
        )}
        <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 group-hover:text-brand-400 transition-colors">
          <TerminalSquare className="w-3.5 h-3.5" /> Logs ({logs.length})
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            setHidden(true);
          }}
          className="p-0.5 rounded-md text-slate-600 hover:text-red-400 hover:bg-slate-800 transition-colors"
          title="Close (hide window)"
        >
          <X className="w-3 h-3" />
        </span>
      </button>
    );
  }

  // Expanded: free-draggable floating window
  return (
    <div
      ref={panelRef}
      className="ingestion-drawer fixed z-50 flex flex-col rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur shadow-2xl shadow-black/60 overflow-hidden"
      style={{
        width: PANEL_W,
        maxWidth: 'calc(100vw - 1rem)',
        height: PANEL_H,
        maxHeight: 'calc(100vh - 1rem)',
        left: pos ? Math.min(pos.x, window.innerWidth - PANEL_W) : window.innerWidth - PANEL_W - 16,
        top: pos ? Math.min(pos.y, window.innerHeight - PANEL_H) : window.innerHeight - PANEL_H - 16,
      }}
    >
      {/* Header: drag handle + window controls */}
      <div
        className="shrink-0 px-4 py-3 border-b border-slate-900 bg-slate-950/80 flex items-center justify-between cursor-grab active:cursor-grabbing touch-none select-none"
        onPointerDown={panelHandlers.onPointerDown}
        title="Drag to move"
      >
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-brand-500/10 border border-brand-500/20 text-brand-400">
            <TerminalSquare className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-100 flex items-center gap-2">
              Ingestion Log
              <span className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400">
                <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
                {statusMeta.label}
              </span>
            </h3>
            <p className="text-[10px] text-slate-500">
              {progress.currentFileName
                ? truncate(progress.currentFileName, 60)
                : 'Background extractor output'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            onClick={handleCopyLogs}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
            title={copied ? 'Copied!' : 'Copy logs'}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={clearLogs}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
            title="Clear logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setMinimized(true)}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
            title="Minimize / collapse"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setHidden(true)}
            className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-900 transition-colors"
            title="Close (hide window)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="shrink-0 px-4 py-2 border-b border-slate-900/60 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                filter === f.value
                  ? 'bg-slate-800 text-brand-400'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-slate-500 font-mono">
          {filteredLogs.length} / {logs.length} entries
        </span>
      </div>

      {/* Log entries */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600 italic text-xs">
            No matching log entries.
          </div>
        ) : (
          filteredLogs.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-2.5 px-4 py-1.5 border-b border-slate-900/40 hover:bg-slate-900/30 transition-colors"
            >
              <span
                className={`mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_STYLES[entry.level].dot}`}
              />
              <span className="text-slate-500 shrink-0 leading-4">{entry.timestamp}</span>
              <span className={`shrink-0 font-bold leading-4 ${LEVEL_STYLES[entry.level].label}`}>
                {entry.level.toUpperCase().padEnd(7, ' ')}
              </span>
              <span className="text-slate-200 leading-4 break-words min-w-0 whitespace-pre-wrap">
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Progress footer */}
      <div className="shrink-0 px-4 py-2.5 border-t border-slate-900/60 bg-slate-950/80">
        <div className="flex items-center justify-between text-[10px] text-slate-500 font-medium mb-1.5">
          <span className="flex items-center gap-1.5">
            {progress.status === 'ingesting' ? (
              <Loader2 className="w-3 h-3 animate-spin text-brand-400" />
            ) : (
              <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
            )}
            {statusMeta.label}
          </span>
          {progress.total > 0 && (
            <span className="font-mono">
              {progress.current} / {progress.total}
            </span>
          )}
        </div>
        <div className="h-1.5 bg-slate-900 rounded-none overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${barColor}`}
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
      </div>
    </div>
  );
};

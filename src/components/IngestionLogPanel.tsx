import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TerminalSquare,
  X,
  Trash2,
  Minimize2,
  Loader2,
} from 'lucide-react';
import { useIngestion, LogEntry, IngestionProgress } from '../services/ingestionStore';

type FilterLevel = 'all' | LogEntry['level'];

const LEVEL_STYLES: Record<LogEntry['level'], { dot: string; label: string }> = {
  info: { dot: 'bg-sky-400', label: 'text-sky-400' },
  success: { dot: 'bg-emerald-400', label: 'text-emerald-400' },
  warn: { dot: 'bg-amber-400', label: 'text-amber-400' },
  error: { dot: 'bg-rose-400', label: 'text-rose-400' },
};

const STATUS_META: Record<IngestionProgress['status'], { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-slate-500' },
  ingesting: { label: 'Ingesting', dot: 'bg-orange-400 animate-pulse' },
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
  const { logs, progress, isMinimized, setMinimized, clearLogs } = useIngestion();
  const [filter, setFilter] = useState<FilterLevel>('all');
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const hasActivity = logs.length > 0 || progress.status !== 'idle';

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
          ? 'bg-orange-400'
          : 'bg-slate-500';

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  if (!hasActivity) return null;

  // Minimized: floating status badge, persistent across all views
  if (isMinimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 pl-3 pr-3.5 py-2 rounded-xl bg-slate-950/95 border border-slate-800 shadow-2xl shadow-black/50 backdrop-blur hover:border-orange-500/40 transition-colors group"
        title="Open ingestion log"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusMeta.dot}`} />
        <span className="text-[11px] font-bold text-slate-200 uppercase tracking-wider">
          {statusMeta.label}
        </span>
        {percent !== null && (
          <span className="text-[11px] font-mono text-orange-400">{percent}%</span>
        )}
        {progress.currentFileName && (
          <span className="text-[10px] text-slate-500 max-w-[140px] truncate">
            {truncate(progress.currentFileName, 28)}
          </span>
        )}
        <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 group-hover:text-orange-400 transition-colors">
          <TerminalSquare className="w-3.5 h-3.5" /> Logs ({logs.length})
        </span>
      </button>
    );
  }

  // Expanded: fixed-size slide-over drawer
  return (
    <div className="ingestion-drawer fixed bottom-4 right-4 z-50 flex flex-col w-[640px] max-w-[calc(100vw-2rem)] h-[500px] max-h-[calc(100vh-2rem)] rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur shadow-2xl shadow-black/60 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-900 bg-slate-950/80 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-orange-500/10 border border-orange-500/20 text-orange-400">
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
        <div className="flex items-center gap-1">
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
            title="Minimize"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setMinimized(true)}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
            title="Close"
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
                  ? 'bg-slate-800 text-orange-400'
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
        className="flex-1 overflow-y-auto font-mono text-[11px]"
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
              <Loader2 className="w-3 h-3 animate-spin text-orange-400" />
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
        <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${barColor}`}
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
      </div>
    </div>
  );
};

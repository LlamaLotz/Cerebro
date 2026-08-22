import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { tauriAPI } from '../types';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface IngestionProgress {
  current: number;
  total: number;
  currentFileName: string;
  status: 'idle' | 'ingesting' | 'paused' | 'completed' | 'error';
}

interface IngestionContextValue {
  logs: LogEntry[];
  progress: IngestionProgress;
  isMinimized: boolean;
  isHidden: boolean;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;
  updateProgress: (patch: Partial<IngestionProgress>) => void;
  setMinimized: (minimized: boolean) => void;
  setHidden: (hidden: boolean) => void;
}

const IngestionContext = createContext<IngestionContextValue | null>(null);

let logIdCounter = 0;
const makeId = () => `log-${Date.now()}-${logIdCounter++}`;

const formatTimestamp = () => {
  const d = new Date();
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
};

// Heuristic level detection for freeform extractor output lines
const detectLevel = (message: string): LogEntry['level'] => {
  const lower = message.toLowerCase();
  if (lower.includes('error') || lower.includes('fail')) return 'error';
  if (lower.includes('warn')) return 'warn';
  if (
    message.includes('✓') ||
    lower.includes('done') ||
    lower.includes('success') ||
    lower.includes('complete') ||
    message.includes('✔')
  ) {
    return 'success';
  }
  return 'info';
};

const PROGRESS_RE = /(\d+)\s*\/\s*(\d+)/;
const FILE_EXT_RE = /([^/\\]+\.(?:md|markdown|pdf|docx|pptx|xlsx|mp3|wav|m4a|mp4|png|jpg|jpeg|html|txt|json))/i;

export const IngestionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<IngestionProgress>({
    current: 0,
    total: 0,
    currentFileName: '',
    status: 'idle',
  });
  const [isMinimized, setIsMinimized] = useState(true);
  // Completely hidden (closed) — distinct from minimized, which still shows
  // the compact floating status badge. Toggled by the sidebar "Logs" button.
  const [isHidden, setIsHidden] = useState(true);
  const hasLogsRef = useRef(false);

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    const full: LogEntry = {
      ...entry,
      id: makeId(),
      timestamp: formatTimestamp(),
    };
    // First activity of a run: surface the panel (collapsed to the badge) so
    // the user notices extraction is underway, even if it was closed.
    if (!hasLogsRef.current) {
      hasLogsRef.current = true;
      setIsHidden(false);
      setIsMinimized(true);
    }
    setLogs((prev) => [...prev, full]);
    // Persist warnings/errors to disk for troubleshooting (~/.prism/ingestion.log)
    if (entry.level === 'error' || entry.level === 'warn') {
      tauriAPI.appendIngestionLog(entry.level, entry.message).catch(() => {});
    }
  }, []);

  const clearLogs = useCallback(() => {
    hasLogsRef.current = false;
    setLogs([]);
    setProgress({ current: 0, total: 0, currentFileName: '', status: 'idle' });
  }, []);

  const updateProgress = useCallback((patch: Partial<IngestionProgress>) => {
    setProgress((prev) => ({ ...prev, ...patch }));
  }, []);

  // Interpret a freeform progress line from the extractor's stdout
  const handleProgressLine = useCallback(
    (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;

      setProgress((prev) => {
        const next = { ...prev, status: 'ingesting' as const };
        const ratio = line.match(PROGRESS_RE);
        if (ratio) {
          next.current = parseInt(ratio[1], 10);
          next.total = parseInt(ratio[2], 10);
        }
        const fileMatch = line.match(FILE_EXT_RE);
        if (fileMatch && fileMatch[1].length < 120) {
          next.currentFileName = fileMatch[1];
        }
        return next;
      });

      addLog({ level: detectLevel(line), message: line });
    },
    [addLog]
  );

  // Background listeners: collect extraction output even while the UI is minimized.
  // Keep async registration cancellation-safe: React StrictMode mounts effects,
  // cleans them up, then mounts them again in development. Without this guard,
  // a listener that resolves after cleanup survives and every line is displayed
  // twice on the next ingestion run.
  useEffect(() => {
    let disposed = false;
    let disposeProgress: (() => void) | undefined;
    let disposeError: (() => void) | undefined;

    const registerListeners = async () => {
      const progressUnlisten = await listen<string>('ingestion-progress', (event) => {
        handleProgressLine(String(event.payload));
      });
      if (disposed) progressUnlisten();
      else disposeProgress = progressUnlisten;

      const errorUnlisten = await listen<string>('ingestion-error', (event) => {
        addLog({ level: 'error', message: String(event.payload) });
      });
      if (disposed) errorUnlisten();
      else disposeError = errorUnlisten;
    };

    registerListeners().catch((error) => {
      if (!disposed) console.error('Failed to register ingestion listeners:', error);
    });

    return () => {
      disposed = true;
      disposeProgress?.();
      disposeError?.();
    };
  }, [addLog, handleProgressLine]);

  const value = useMemo<IngestionContextValue>(
    () => ({
      logs,
      progress,
      isMinimized,
      isHidden,
      addLog,
      clearLogs,
      updateProgress,
      setMinimized: setIsMinimized,
      setHidden: setIsHidden,
    }),
    [logs, progress, isMinimized, isHidden, addLog, clearLogs, updateProgress]
  );

  return createElement(IngestionContext.Provider, { value }, children);
};

export function useIngestion(): IngestionContextValue {
  const ctx = useContext(IngestionContext);
  if (!ctx) {
    throw new Error('useIngestion must be used within an IngestionProvider');
  }
  return ctx;
}

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;
  updateProgress: (patch: Partial<IngestionProgress>) => void;
  setMinimized: (minimized: boolean) => void;
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

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    const full: LogEntry = {
      ...entry,
      id: makeId(),
      timestamp: formatTimestamp(),
    };
    setLogs((prev) => [...prev, full]);
    // Persist warnings/errors to disk for troubleshooting (~/.cerebro/ingestion.log)
    if (entry.level === 'error' || entry.level === 'warn') {
      tauriAPI.appendIngestionLog(entry.level, entry.message).catch(() => {});
    }
  }, []);

  const clearLogs = useCallback(() => {
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

  // Background listeners: collect extraction output even while the UI is minimized
  useEffect(() => {
    let disposeProgress: (() => void) | undefined;
    let disposeError: (() => void) | undefined;

    (async () => {
      disposeProgress = await listen<string>('ingestion-progress', (event) => {
        handleProgressLine(String(event.payload));
      });
      disposeError = await listen<string>('ingestion-error', (event) => {
        addLog({ level: 'error', message: String(event.payload) });
      });
    })();

    return () => {
      disposeProgress?.();
      disposeError?.();
    };
  }, [addLog, handleProgressLine]);

  const value = useMemo<IngestionContextValue>(
    () => ({
      logs,
      progress,
      isMinimized,
      addLog,
      clearLogs,
      updateProgress,
      setMinimized: setIsMinimized,
    }),
    [logs, progress, isMinimized, addLog, clearLogs, updateProgress]
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

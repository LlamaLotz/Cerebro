import { invoke } from '@tauri-apps/api/core';

// Fire-and-forget app logging. Entries are batched and flushed every
// FLUSH_INTERVAL_MS so high-frequency actions (autosaves, jumps) don't
// hammer the IPC bridge. Rust writes them to:
//   ~/.cerebro/appLogs/YYYY-MM-DD/actions.log  (info)
//   ~/.cerebro/appLogs/YYYY-MM-DD/errors.log   (warn/error)
type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const FLUSH_INTERVAL_MS = 500;
const MAX_QUEUE = 200;

let queue: { level: LogLevel; message: string }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (queue.length === 0) {
    timer = null;
    return;
  }
  const batch = queue;
  queue = [];
  for (const entry of batch) {
    invoke('append_app_log', { level: entry.level, message: entry.message }).catch(
      () => {
        // Logging must never break app flow; swallow silently.
      },
    );
  }
}

function push(level: LogLevel, message: string) {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
  }
  queue.push({ level, message });
  if (timer === null) {
    timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

export const appLogger = {
  info(message: string) {
    push('INFO', message);
  },
  warn(message: string) {
    push('WARN', message);
  },
  error(message: string, err?: unknown) {
    const detail = err instanceof Error ? ` ${err.message}` : '';
    push('ERROR', `${message}${detail}`);
  },
};
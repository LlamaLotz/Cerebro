import React, { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getAppIcon } from '../services/appIcon';

/**
 * Custom frameless-window titlebar. The OS decorations are disabled
 * (`decorations: false` in tauri.conf.json), so this bar provides the drag
 * region plus minimize / maximize-restore / close controls.
 *
 * The drag region is scoped to the logo + title area only; the button cluster
 * is a sibling (NOT inside `data-tauri-drag-region`) so clicks always land on
 * the buttons instead of initiating a window drag.
 */
export const TitleBar: React.FC<{ appIcon?: string }> = ({ appIcon = '' }) => {
  const [maximized, setMaximized] = useState(false);
  // Memoize so the effect below doesn't re-subscribe `onResized` on every render.
  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    appWindow
      .isMaximized()
      .then((m) => {
        if (!disposed) setMaximized(m);
      })
      .catch(() => {});

    // `onResized` fires on maximize / unmaximize / manual resize — the only
    // reliable way to keep the restore/maximize icon in sync across platforms.
    appWindow
      .onResized(async () => {
        try {
          const m = await appWindow.isMaximized();
          if (!disposed) setMaximized(m);
        } catch {
          // window may have closed mid-resize
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  return (
    <div className="relative flex items-center h-9 bg-base border-b border-border shrink-0 select-none z-40 rounded-none">
      {/* Drag region: logo + product name */}
      <div
        data-tauri-drag-region
        className="flex-1 h-full flex items-center gap-2 pl-3 cursor-default"
      >
        <img
          src={getAppIcon(appIcon)}
          alt="Prism"
          className="w-4 h-4 shrink-0 pointer-events-none object-contain"
        />
        <span className="text-[11px] font-display font-semibold tracking-[0.2em] text-offwhite pointer-events-none">
          PRISM
        </span>
      </div>

      {/* Window controls (excluded from the drag region) */}
      <div className="flex items-center h-full shrink-0">
        <button
          onClick={() => appWindow.minimize()}
          title="Minimize"
          className="w-11 h-full flex items-center justify-center rounded-none text-text-muted hover:text-offwhite hover:bg-surface-hover transition-colors"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          title={maximized ? 'Restore' : 'Maximize'}
          className="w-11 h-full flex items-center justify-center rounded-none text-text-muted hover:text-offwhite hover:bg-surface-hover transition-colors"
        >
          {maximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
        </button>
        <button
          onClick={() => appWindow.close()}
          title="Close"
          className="w-11 h-full flex items-center justify-center rounded-none text-text-muted hover:text-white hover:bg-[#E81123] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

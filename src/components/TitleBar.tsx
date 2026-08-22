import React, { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X, FileText, SplitSquareVertical, Network, Tags, Sparkles } from 'lucide-react';
import { getAppIcon } from '../services/appIcon';

type Layout = 'editor' | 'graph' | 'split' | 'topics';

interface TitleBarProps {
  /** Custom app icon id from the rainbow logo registry. */
  appIcon?: string;
  /** Current workspace layout mode. */
  layout: Layout;
  /** Called when the user clicks a view-tab button. */
  onLayoutChange: (layout: Layout) => void;
  /** Whether the AI Co-Pilot sidebar is open. */
  showAI: boolean;
  /** Toggle the AI Co-Pilot sidebar. */
  onToggleAI: () => void;
}

/**
 * Custom frameless-window titlebar for Windows. The OS decorations are
 * disabled (`decorations: false` in tauri.conf.json), so this bar provides
 * the drag region, workspace view tabs, AI toggle, and window controls —
 * all in a single 36 px strip to maximise vertical content space.
 *
 * Layout mirrors VS Code / native Windows 11 apps:
 *   [icon] [PRISM] ··· [Editor][Split][Graph][Topics] ··· [AI ✦] [—][□][×]
 */
export const TitleBar: React.FC<TitleBarProps> = ({
  appIcon = '',
  layout,
  onLayoutChange,
  showAI,
  onToggleAI,
}) => {
  const [maximized, setMaximized] = useState(false);
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

  const tabButton = (
    id: Layout,
    Icon: React.FC<{ className?: string }>,
    label: string,
  ) => (
    <button
      onClick={() => onLayoutChange(id)}
      title={label}
      className={`p-1.5 rounded transition-colors ${
        layout === id
          ? 'bg-surface text-brand-400'
          : 'text-text-muted hover:text-offwhite hover:bg-surface-hover'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );

  return (
    <div className="relative flex items-center h-9 bg-base border-b border-border shrink-0 select-none z-40 rounded-none">
      {/* Drag region: logo + product name */}
      <div
        data-tauri-drag-region
        className="flex items-center h-full gap-2 pl-3 cursor-default"
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

      {/* Separator dot */}
      <div className="mx-2 w-px h-4 bg-border pointer-events-none" />

      {/* View tabs (center-left, outside drag region) */}
      <div className="flex items-center gap-0.5">
        {tabButton('editor', FileText, 'Note Editor')}
        {tabButton('split', SplitSquareVertical, 'Split View')}
        {tabButton('graph', Network, 'Graph Network')}
        {tabButton('topics', Tags, 'Topic Groups')}
      </div>

      {/* Spacer — pushes right-side controls to the edge */}
      <div className="flex-1" data-tauri-drag-region />

      {/* AI Co-Pilot toggle */}
      <button
        onClick={onToggleAI}
        title="OmniRoute AI Co-Pilot"
        className={`mr-1 p-1.5 rounded transition-colors ${
          showAI
            ? 'text-brand-400 bg-brand-600/10'
            : 'text-text-muted hover:text-offwhite hover:bg-surface-hover'
        }`}
      >
        <Sparkles className="w-3.5 h-3.5" />
      </button>

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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X, FileText, SplitSquareVertical, Network, Tags, Sparkles } from 'lucide-react';
import { getAppIcon } from '../services/appIcon';

const isMacOS = navigator.userAgent.includes('Mac');

type Layout = 'editor' | 'graph' | 'split' | 'topics';

interface TitleBarProps {
  appIcon?: string;
  layout: Layout;
  onLayoutChange: (layout: Layout) => void;
  showAI: boolean;
  onToggleAI: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onOpenPrism: () => void;
  onSettings: () => void;
  onReload: () => void;
  onToggleIngestionLogs: () => void;
  onToggleSidebar: () => void;
  sidebarVisible: boolean;
}

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  divider?: boolean;
  disabled?: boolean;
}

/**
 * Single-row title bar: menu labels → view tabs → spacer → AI toggle → window controls.
 * Clicking a menu label opens its dropdown; hovering another label while open
 * switches directly (macOS-style).
 */
export const TitleBar: React.FC<TitleBarProps> = ({
  appIcon = '',
  layout,
  onLayoutChange,
  showAI,
  onToggleAI,
  onNewNote,
  onNewFolder,
  onOpenPrism,
  onSettings,
  onReload,
  onToggleIngestionLogs,
  onToggleSidebar,
  sidebarVisible,
}) => {
  const [maximized, setMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    appWindow.isMaximized().then((m: boolean) => { if (!disposed) setMaximized(m); }).catch(() => {});
    appWindow.onResized(async () => {
      try { const m = await appWindow.isMaximized(); if (!disposed) setMaximized(m); } catch {}
    }).then((fn: () => void) => { unlisten = fn; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [appWindow]);

  const closeMenu = useCallback(() => setOpenMenu(null), []);

  // Close on outside click
  useEffect(() => {
    if (!openMenu) return;
    const h = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener('mousedown', h, true);
    return () => window.removeEventListener('mousedown', h, true);
  }, [openMenu, closeMenu]);

  // Global keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === ',' && !e.shiftKey) { e.preventDefault(); onSettings(); }
      if (k === 'n' && !e.shiftKey) { e.preventDefault(); onNewNote(); }
      if (k === 'n' && e.shiftKey) { e.preventDefault(); onNewFolder(); }
      if (k === 'o' && !e.shiftKey) { e.preventDefault(); onOpenPrism(); }
      if (k === '1') { e.preventDefault(); onLayoutChange('editor'); }
      if (k === '2') { e.preventDefault(); onLayoutChange('graph'); }
      if (k === '3') { e.preventDefault(); onLayoutChange('topics'); }
      if (k === '4') { e.preventDefault(); onLayoutChange('split'); }
      if (k === 'a' && e.shiftKey) { e.preventDefault(); onToggleAI(); }
      if (k === 's' && e.shiftKey) { e.preventDefault(); onToggleSidebar(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onSettings, onNewNote, onNewFolder, onOpenPrism, onLayoutChange, onToggleAI, onToggleSidebar]);

  const menus: Record<string, { label: string; items: MenuItem[] }> = {
    prism: {
      label: 'Prism',
      items: [
        { label: 'Settings…', shortcut: 'Ctrl+,', action: () => { onSettings(); closeMenu(); } },
        { label: 'Reload App', shortcut: 'Ctrl+Shift+R', action: () => { onReload(); closeMenu(); } },
      ],
    },
    file: {
      label: 'File',
      items: [
        { label: 'New Note', shortcut: 'Ctrl+N', action: () => { onNewNote(); closeMenu(); } },
        { label: 'New Folder', shortcut: 'Ctrl+Shift+N', action: () => { onNewFolder(); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Open a Prism…', shortcut: 'Ctrl+O', action: () => { onOpenPrism(); closeMenu(); } },
      ],
    },
    edit: {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: () => { document.execCommand('undo'); closeMenu(); } },
        { label: 'Redo', shortcut: 'Ctrl+Shift+Z', action: () => { document.execCommand('redo'); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => { document.execCommand('cut'); closeMenu(); } },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => { document.execCommand('copy'); closeMenu(); } },
        { label: 'Paste', shortcut: 'Ctrl+V', action: () => { document.execCommand('paste'); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Select All', shortcut: 'Ctrl+A', action: () => { document.execCommand('selectAll'); closeMenu(); } },
        { label: 'Find…', shortcut: 'Ctrl+F', action: () => { closeMenu(); } },
      ],
    },
    view: {
      label: 'View',
      items: [
        { label: 'Note Editor', shortcut: 'Ctrl+1', action: () => { onLayoutChange('editor'); closeMenu(); }, disabled: layout === 'editor' },
        { label: 'Graph', shortcut: 'Ctrl+2', action: () => { onLayoutChange('graph'); closeMenu(); }, disabled: layout === 'graph' },
        { label: 'Tags', shortcut: 'Ctrl+3', action: () => { onLayoutChange('topics'); closeMenu(); }, disabled: layout === 'topics' },
        { label: 'Split View', shortcut: 'Ctrl+4', action: () => { onLayoutChange('split'); closeMenu(); }, disabled: layout === 'split' },
        { divider: true, label: '' },
        { label: 'Ingestion Logs', action: () => { onToggleIngestionLogs(); closeMenu(); } },
        { divider: true, label: '' },
        { label: `${showAI ? 'Hide' : 'Show'} AI Sidebar`, shortcut: 'Ctrl+Shift+A', action: () => { onToggleAI(); closeMenu(); } },
        { label: `${sidebarVisible ? 'Hide' : 'Show'} Sidebar`, shortcut: 'Ctrl+Shift+S', action: () => { onToggleSidebar(); closeMenu(); } },
      ],
    },
  };

  const tabBtn = (id: Layout, Icon: React.FC<{ className?: string }>, label: string) => (
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
    <div ref={barRef} className="relative flex items-center h-9 bg-base shrink-0 select-none z-40 rounded-none">
      {/* ── Icon + app name ── */}
      <div
        data-tauri-drag-region
        className="flex items-center h-full gap-1.5 pl-3 cursor-default"
      >
        <img src={getAppIcon(appIcon)} alt="" className="w-6 h-6 shrink-0 pointer-events-none object-contain" />
        {!isMacOS && <span className="text-[11px] font-display font-semibold tracking-[0.2em] text-offwhite pointer-events-none">PRISM</span>}
      </div>

      {/* ── Windows/Linux: menu bar ── */}
      {!isMacOS && (
        <>
          <div className="mx-1 w-px h-4 bg-border pointer-events-none" />

          {/* Prism dropdown */}
          <div className="relative">
            <button
              onMouseDown={(e) => { e.preventDefault(); setOpenMenu(openMenu === 'prism' ? null : 'prism'); }}
              onMouseEnter={() => { if (openMenu) setOpenMenu('prism'); }}
              className={`h-9 px-2 flex items-center text-[12px] transition-colors border-none outline-none bg-transparent titlebar-menu ${
                openMenu === 'prism'
                  ? 'text-offwhite'
                  : 'text-text-muted hover:text-offwhite'
              }`}
            >
              Prism
            </button>
            {openMenu === 'prism' && (
              <div className="absolute top-full left-0 min-w-[220px] bg-panel border border-border rounded-md shadow-xl py-1 z-50">
                {menus.prism.items.map((item, i) =>
                  item.divider ? (
                    <div key={i} className="my-1 border-t border-border" />
                  ) : (
                    <button
                      key={i}
                      onClick={item.action}
                      disabled={item.disabled}
                      className={`w-full px-3 py-1 flex items-center justify-between gap-6 text-left text-[12px] transition-colors ${
                        item.disabled ? 'text-text-muted/50 cursor-default' : 'text-slate-300 hover:bg-brand-500/20 hover:text-offwhite'
                      }`}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <span className="text-[11px] text-text-muted ml-4 whitespace-nowrap">{item.shortcut}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>

          <div className="mx-1 w-px h-4 bg-border pointer-events-none" />

          {/* File / Edit / View dropdowns */}
          {Object.entries(menus).filter(([k]) => k !== 'prism').map(([key, { label, items }]) => (
            <div key={key} className="relative">
              <button
                onMouseDown={(e) => { e.preventDefault(); setOpenMenu(openMenu === key ? null : key); }}
                onMouseEnter={() => { if (openMenu) setOpenMenu(key); }}
                className={`px-2 h-9 flex items-center text-[12px] transition-colors border-none outline-none bg-transparent titlebar-menu ${
                  openMenu === key
                    ? 'text-offwhite'
                    : 'text-text-muted hover:text-offwhite'
                }`}
              >
                {label}
              </button>
              {openMenu === key && (
                <div className="absolute top-full left-0 min-w-[220px] bg-panel border border-border rounded-md shadow-xl py-1 z-50">
                  {items.map((item, i) =>
                    item.divider ? (
                      <div key={i} className="my-1 border-t border-border" />
                    ) : (
                      <button
                        key={i}
                        onClick={item.action}
                        disabled={item.disabled}
                        className={`w-full px-3 py-1 flex items-center justify-between gap-6 text-left text-[12px] transition-colors ${
                          item.disabled ? 'text-text-muted/50 cursor-default' : 'text-slate-300 hover:bg-brand-500/20 hover:text-offwhite'
                        }`}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <span className="text-[11px] text-text-muted ml-4 whitespace-nowrap">{item.shortcut}</span>}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}

          <div className="mx-1 w-px h-4 bg-border pointer-events-none" />
        </>
      )}

      {/* ── Separator ── */}
      {!isMacOS && <div className="mx-1 w-px h-4 bg-border pointer-events-none" />}

      {/* ── View tabs (icons) ── */}
      <div className="flex items-center gap-0.5">
        {tabBtn('editor', FileText, 'Note Editor')}
        {tabBtn('split', SplitSquareVertical, 'Split View')}
        {tabBtn('graph', Network, 'Graph Network')}
        {tabBtn('topics', Tags, 'Topic Groups')}
      </div>

      {/* ── Spacer (drag region) ── */}
      <div className="flex-1" data-tauri-drag-region />

      {/* ── AI toggle (star icon) ── */}
      <button
        onClick={onToggleAI}
        title="OmniRoute AI Co-Pilot"
        className={`mr-1 p-1.5 rounded transition-colors ${
          showAI ? 'text-brand-400 bg-brand-600/10' : 'text-text-muted hover:text-offwhite hover:bg-surface-hover'
        }`}
      >
        <Sparkles className="w-3.5 h-3.5" />
      </button>

      {/* ── Window controls ── */}
      <div className="flex items-center h-full shrink-0">
        <button onClick={() => appWindow.minimize()} title="Minimize" className="w-11 h-full flex items-center justify-center text-text-muted hover:text-offwhite hover:bg-surface-hover transition-colors">
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} title={maximized ? 'Restore' : 'Maximize'} className="w-11 h-full flex items-center justify-center text-text-muted hover:text-offwhite hover:bg-surface-hover transition-colors">
          {maximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
        </button>
        <button onClick={() => appWindow.close()} title="Close" className="w-11 h-full flex items-center justify-center text-text-muted hover:text-white hover:bg-[#E81123] transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

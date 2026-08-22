import React, { useLayoutEffect, useRef, useState } from 'react';
import { Copy, Scissors, ClipboardPaste, Maximize2, FolderPlus, FolderMinus, FilePlus, Edit3, Trash2, Pencil } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  /**
   * What actions the menu shows:
   *  - 'sidebar': vault actions (new note / new folder) — no delete folder,
   *    since there's no specific folder targeted
   *  - 'note': right-clicked a specific note (rename / delete note)
   *  - 'folder': right-clicked a specific folder (rename / delete folder)
   *  - 'editor': text-edit actions
   */
  variant: 'sidebar' | 'note' | 'folder' | 'editor';
  onNewFolder?: () => void;
  onNewNote?: () => void;
  /** Delete a folder — no args = generic sidebar background (prompts for a
   *  path); the 'folder' variant receives the hovered folder's path. */
  onDeleteFolder?: (folderPath?: string) => void;
  onRenameFolder?: () => void;
  onRenameNote?: () => void;
  onDeleteNote?: () => void;
}

const EDGE_MARGIN = 8;

const isEditable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return (el as HTMLElement).isContentEditable;
};

// Custom dark-mode replacement for the default WebView2/Edge right-click menu.
// Right-clicking a note/folder row in the sidebar targets that item with
// rename/delete actions; everywhere else it's the text actions, which operate
// on the current selection / focused editable element.
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onClose,
  variant,
  onNewFolder,
  onNewNote,
  onDeleteFolder,
  onRenameFolder,
  onRenameNote,
  onDeleteNote,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp inside the window. Runs before paint, so the menu never flashes
  // off-screen when opened near an edge.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const left = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - el.offsetWidth - EDGE_MARGIN));
    const top = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - el.offsetHeight - EDGE_MARGIN));
    setPos({ left, top });
  }, [x, y]);

  const runAction = async (action: 'copy' | 'cut' | 'paste' | 'selectall') => {
    onClose();
    const selection = window.getSelection()?.toString() ?? '';
    const focused = document.activeElement as HTMLElement | null;

    if (action === 'selectall') {
      try {
        if (isEditable(focused)) {
          if (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') {
            focused.select();
          } else {
            const range = document.createRange();
            range.selectNodeContents(focused);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        } else {
          document.execCommand('selectAll');
        }
      } catch {
        // Selection APIs unavailable — nothing else to try.
      }
      return;
    }

    if (action === 'copy' || action === 'cut') {
      // execCommand('copy') first: it uses the browser's native copy path,
      // which works with editor implementations like CodeMirror that keep
      // their selection in a hidden element. Fall back to the clipboard API
      // for plain DOM selections.
      try {
        if (!document.execCommand('copy')) throw new Error('copy rejected');
      } catch {
        if (selection) {
          try {
            await navigator.clipboard.writeText(selection);
          } catch {
            return;
          }
        }
      }
      if (action === 'cut' && isEditable(focused)) {
        try {
          document.execCommand('delete');
        } catch {
          // Selection may have been lost — non-fatal.
        }
      }
      return;
    }

    // paste
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    if (isEditable(focused)) {
      try {
        document.execCommand('insertText', false, text);
      } catch {
        // Some editors reject execCommand; the user can still Ctrl+V.
      }
    }
  };

  const Item: React.FC<{ icon: React.ElementType; label: string; onClick: () => void; danger?: boolean }> = ({
    icon: Icon,
    label,
    onClick,
    danger,
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium transition-colors ${
        danger
          ? 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200'
          : 'text-slate-200 hover:bg-brand-500/10 hover:text-brand-300'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${danger ? 'text-rose-400/80' : 'text-slate-500'}`} />
      {label}
    </button>
  );

  return (
    <div
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-[100] w-44 py-1 rounded-lg border border-neutral-800 bg-neutral-950/95 backdrop-blur-sm shadow-2xl shadow-black/60"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {variant === 'sidebar' && (
        <>
          <Item
            icon={FilePlus}
            label="New Note"
            onClick={() => {
              onClose();
              onNewNote?.();
            }}
          />
          <Item
            icon={FolderPlus}
            label="New Folder"
            onClick={() => {
              onClose();
              onNewFolder?.();
            }}
          />
        </>
      )}

      {variant === 'folder' && (
        <>
          <Item
            icon={FolderPlus}
            label="New Folder"
            onClick={() => {
              onClose();
              onNewFolder?.();
            }}
          />
          <div className="mx-2 my-1 border-t border-neutral-800" />
          <Item
            icon={Pencil}
            label="Rename Folder"
            onClick={() => {
              onClose();
              onRenameFolder?.();
            }}
          />
          <div className="mx-2 my-1 border-t border-neutral-800" />
          <Item
            icon={FolderMinus}
            label="Delete Folder…"
            danger
            onClick={() => {
              onClose();
              onDeleteFolder?.('__current__');
            }}
          />
        </>
      )}

      {variant === 'note' && (
        <>
          <Item
            icon={FolderPlus}
            label="New Folder"
            onClick={() => {
              onClose();
              onNewFolder?.();
            }}
          />
          <div className="mx-2 my-1 border-t border-neutral-800" />
          <Item
            icon={Edit3}
            label="Rename Note"
            onClick={() => {
              onClose();
              onRenameNote?.();
            }}
          />
          <div className="mx-2 my-1 border-t border-neutral-800" />
          <Item
            icon={Trash2}
            label="Delete Note"
            danger
            onClick={() => {
              onClose();
              onDeleteNote?.();
            }}
          />
        </>
      )}

      {variant === 'editor' && (
        <>
          <Item icon={Copy} label="Copy" onClick={() => runAction('copy')} />
          <Item icon={Scissors} label="Cut" onClick={() => runAction('cut')} />
          <Item icon={ClipboardPaste} label="Paste" onClick={() => runAction('paste')} />
          <div className="mx-2 my-1 border-t border-neutral-800" />
          <Item icon={Maximize2} label="Select All" onClick={() => runAction('selectall')} />
        </>
      )}
    </div>
  );
};

import React from 'react';
import { Link2, ScanSearch, FileSearch, X } from 'lucide-react';

interface LinkerToolbarProps {
  pendingCount: number;
  isScanning: boolean;
  isReady: boolean;
  isPanelOpen: boolean;
  onScan: () => void;
  onToggleLinks: () => void;
}

export const LinkerToolbar: React.FC<LinkerToolbarProps> = ({
  pendingCount,
  isScanning,
  isReady,
  isPanelOpen,
  onScan,
  onToggleLinks,
}) => {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onScan}
        disabled={isScanning || !isReady}
        title={isReady ? 'Scan this note for unlinked mentions' : 'Select a vault first'}
        className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all border ${
          !isReady
            ? 'bg-slate-950 border-slate-800 text-slate-600 cursor-not-allowed'
            : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-brand-400 hover:border-brand-500/40'
        }`}
      >
        <ScanSearch className="w-3.5 h-3.5" />
        {isScanning ? 'Scanning...' : 'Scan'}
      </button>

      {/* Review button doubles as the links-panel toggle. It only shows while
          there is something to review — once every suggestion is approved or
          dismissed it disappears. */}
      {pendingCount > 0 && (
        <button
          onClick={onToggleLinks}
          title={
            isPanelOpen
              ? `Close the links panel (${pendingCount} suggestion${pendingCount === 1 ? '' : 's'})`
              : `Open the links panel (${pendingCount} suggestion${pendingCount === 1 ? '' : 's'})`
          }
          className={`relative flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all border ${
            isPanelOpen
              ? 'bg-brand-500/20 border-brand-500/60 text-brand-300'
              : 'bg-brand-500/10 border-brand-500/40 text-brand-400 hover:bg-brand-500/20'
          }`}
        >
          {isPanelOpen ? <X className="w-3.5 h-3.5" /> : <FileSearch className="w-3.5 h-3.5" />}
          {isPanelOpen ? 'Close Links' : 'Review'}
          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 bg-rose-500 text-white text-[10px] font-bold rounded-none flex items-center justify-center">
            {pendingCount}
          </span>
        </button>
      )}

      <Link2 className="w-3.5 h-3.5 text-slate-600" />
    </div>
  );
};
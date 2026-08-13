import React from 'react';
import { Link2, ScanSearch, FileSearch } from 'lucide-react';

interface LinkerToolbarProps {
  pendingCount: number;
  isScanning: boolean;
  isReady: boolean;
  onScan: () => void;
  onOpenReview: () => void;
}

export const LinkerToolbar: React.FC<LinkerToolbarProps> = ({
  pendingCount,
  isScanning,
  isReady,
  onScan,
  onOpenReview,
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
            : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-orange-400 hover:border-orange-500/40'
        }`}
      >
        <ScanSearch className="w-3.5 h-3.5" />
        {isScanning ? 'Scanning...' : 'Scan'}
      </button>

      <button
        onClick={onOpenReview}
        disabled={pendingCount === 0}
        title={pendingCount > 0 ? `Review ${pendingCount} suggested links` : 'No suggestions yet'}
        className={`relative flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all border ${
          pendingCount > 0
            ? 'bg-orange-500/10 border-orange-500/40 text-orange-400 hover:bg-orange-500/20'
            : 'bg-slate-950 border-slate-800 text-slate-600 cursor-not-allowed'
        }`}
      >
        <FileSearch className="w-3.5 h-3.5" />
        Review
        {pendingCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {pendingCount}
          </span>
        )}
      </button>

      <Link2 className="w-3.5 h-3.5 text-slate-600" />
    </div>
  );
};

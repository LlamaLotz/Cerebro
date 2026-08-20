import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, XCircle, Check, ArrowRight, FileText } from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { linkerService, LinkMention } from '../services/linkerService';

const REVIEW_STORAGE_KEY = 'prism_review_state';

interface ReviewState {
  filePath: string;
  noteTitle: string;
  content: string;
  mentions: LinkMention[];
}

const getContextSnippet = (content: string, start: number, end: number, radius = 60) => {
  const from = Math.max(0, start - radius);
  const to = Math.min(content.length, end + radius);
  return {
    prefix: from > 0 ? '…' : '',
    middle: content.slice(start, end),
    suffix: to < content.length ? '…' : '',
    before: content.slice(from, start).replace(/\n+/g, ' '),
    after: content.slice(end, to).replace(/\n+/g, ' '),
  };
};

export const ReviewWindow: React.FC = () => {
  const [state, setState] = useState<ReviewState | null>(null);
  const [approved, setApproved] = useState<Record<number, boolean>>({});
  const [isApplying, setIsApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    if (!raw) {
      setError('No pending link suggestions found. Run a scan in the editor first.');
      return;
    }
    try {
      const parsed: ReviewState = JSON.parse(raw);
      setState(parsed);
      setApproved(Object.fromEntries(parsed.mentions.map((_, i) => [i, true])));
    } catch {
      setError('Failed to load pending suggestions.');
    }
  }, []);

  if (error) {
    return (
      <div className="h-screen bg-neutral-950 text-neutral-300 flex flex-col items-center justify-center gap-4 p-8">
        <XCircle className="w-10 h-10 text-rose-500" />
        <p className="text-sm">{error}</p>
        <button
          onClick={() => getCurrentWebviewWindow().close()}
          className="px-4 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold rounded-lg transition-colors"
        >
          Close
        </button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="h-screen bg-neutral-950 text-neutral-500 flex items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  const pendingCount = state.mentions.filter((_, i) => approved[i]).length;

  const applyApproved = async () => {
    setIsApplying(true);
    setMessage(null);
    setError(null);
    try {
      const selected = state.mentions.filter((_, i) => approved[i]);
      await linkerService.applyApprovedLinks(state.filePath, selected);
      localStorage.removeItem(REVIEW_STORAGE_KEY);
      setMessage(`Applied ${selected.length} link${selected.length === 1 ? '' : 's'} successfully.`);
      setTimeout(() => getCurrentWebviewWindow().close(), 1200);
    } catch (e) {
      setError(String(e));
      setIsApplying(false);
    }
  };

  return (
    <div className="h-screen bg-neutral-950 text-neutral-200 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-neutral-900 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-brand-500/10 border border-brand-500/20 rounded-md text-brand-400">
            <FileText className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">Review Suggested Links</h2>
            <p className="text-[10px] text-neutral-500 truncate max-w-md">
              {state.filePath}
            </p>
          </div>
        </div>
        <span className="text-[11px] font-medium text-neutral-400 bg-neutral-900 border border-neutral-800 px-2 py-1 rounded-lg">
          {pendingCount} / {state.mentions.length} selected
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2.5">
        {state.mentions.map((mention, i) => {
          const ctx = getContextSnippet(state.content, mention.start, mention.end);
          const isApproved = approved[i];
          return (
            <div
              key={i}
              className={`border rounded-lg p-3.5 transition-all ${
                isApproved
                  ? 'border-neutral-800 bg-neutral-900/40'
                  : 'border-neutral-900 bg-neutral-950/60 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400 bg-brand-500/10 border border-brand-500/20 px-1.5 py-0.5 rounded">
                      {mention.targetNoteId}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-400 leading-relaxed select-text">
                    {ctx.prefix}
                    <span className="text-neutral-200">{ctx.before}</span>
                    <mark className="bg-amber-500/20 text-amber-200 rounded px-0.5">
                      {ctx.middle}
                    </mark>
                    <span className="text-neutral-200">{ctx.after}</span>
                    {ctx.suffix}
                  </p>
                </div>
                <button
                  onClick={() => setApproved((prev) => ({ ...prev, [i]: !prev[i] }))}
                  className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all ${
                    isApproved
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-500 hover:text-neutral-300'
                  }`}
                  title={isApproved ? 'Click to deny' : 'Click to approve'}
                >
                  {isApproved ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approved
                    </>
                  ) : (
                    <>
                      <Circle className="w-3.5 h-3.5" /> Denied
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-6 py-3 border-t border-neutral-900 bg-neutral-950/60 flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          {message && <p className="text-xs text-emerald-400">{message}</p>}
          {error && <p className="text-xs text-rose-400 truncate">{error}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => getCurrentWebviewWindow().close()}
            className="px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 text-xs font-medium rounded-lg border border-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={applyApproved}
            disabled={isApplying || pendingCount === 0}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold rounded-lg transition-all ${
              pendingCount === 0
                ? 'bg-neutral-900 text-neutral-600 cursor-not-allowed'
                : 'bg-brand-500 hover:bg-brand-400 text-neutral-950'
            }`}
          >
            {isApplying ? 'Applying…' : `Apply ${pendingCount} Link${pendingCount === 1 ? '' : 's'}`}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

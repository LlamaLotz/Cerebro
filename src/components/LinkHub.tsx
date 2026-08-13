import React, { useState } from 'react';
import { Sparkles, Zap, Link2, RefreshCw, Info, Check, X } from 'lucide-react';
import { NoteFile } from '../types';
import { LinkMention, BacklinkInfo } from '../services/linkerService';
import { SemanticMatch } from '../services/semantic';

interface LinkHubProps {
  mentions: LinkMention[];
  backlinks: BacklinkInfo[];
  related: SemanticMatch[];
  dictionary: [string, string][];
  allNotes: NoteFile[];
  isLoading: boolean;
  error: string | null;
  onWikiLinkClick: (targetTitle: string) => void;
  onApproveMention: (mention: LinkMention) => void;
  onApproveSemantic: (match: SemanticMatch) => void;
  onRefresh: () => void;
}

type LinkKind = 'keyword' | 'semantic' | 'backlink';

const TAG_STYLES: Record<LinkKind, { label: string; cls: string; icon: React.ReactNode }> = {
  keyword: {
    label: 'Keyword',
    cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    icon: <Zap className="w-2.5 h-2.5" />,
  },
  semantic: {
    label: 'Semantic',
    cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    icon: <Sparkles className="w-2.5 h-2.5" />,
  },
  backlink: {
    label: 'Backlink',
    cls: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    icon: <Link2 className="w-2.5 h-2.5" />,
  },
};

const CARD_CLS =
  'flex items-center gap-2.5 bg-slate-950/60 border border-slate-850/80 hover:border-orange-500/30 hover:bg-slate-900/40 p-2 rounded-lg cursor-pointer transition-all';

const APPROVE_CLS =
  'flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20';

const DENY_CLS =
  'flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-400';

/** One unified section for every kind of connection to the current note,
 *  differentiated by tag pills and driven by Approve / Deny / Refresh actions. */
export const LinkHub: React.FC<LinkHubProps> = ({
  mentions,
  backlinks,
  related,
  dictionary,
  allNotes,
  isLoading,
  error,
  onWikiLinkClick,
  onApproveMention,
  onApproveSemantic,
  onRefresh,
}) => {
  // Session-scoped dismissals; Refresh clears them and re-scans everything.
  const [denied, setDenied] = useState<Set<string>>(new Set());

  const mentionKey = (m: LinkMention) => `k-${m.start}-${m.end}-${m.targetNoteId}`;
  const semanticKey = (m: SemanticMatch) => `s-${m.note_id}`;

  const visibleMentions = mentions.filter((m) => !denied.has(mentionKey(m)));
  const visibleRelated = related.filter((m) => !denied.has(semanticKey(m)));
  const total = visibleMentions.length + visibleRelated.length + backlinks.length;
  const deniedCount = mentions.length + related.length - visibleMentions.length - visibleRelated.length;

  const titleForId = (id: string) =>
    dictionary.find(([noteId]) => noteId === id)?.[1] ?? id;
  const titleByPath = (path: string) =>
    allNotes.find((n) => n.path === path)?.title ??
    path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ??
    path;

  const handleRefresh = () => {
    setDenied(new Set());
    onRefresh();
  };

  const TagPill: React.FC<{ kind: LinkKind }> = ({ kind }) => {
    const t = TAG_STYLES[kind];
    return (
      <span
        className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-bold uppercase tracking-wide ${t.cls}`}
      >
        {t.icon}
        {t.label}
      </span>
    );
  };

  const ActionButtons: React.FC<{ onApprove?: () => void; onDeny: () => void }> = ({
    onApprove,
    onDeny,
  }) => (
    <div className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {onApprove && (
        <button
          onClick={onApprove}
          title="Approve: create the link"
          className={APPROVE_CLS}
        >
          <Check className="w-3 h-3" /> Approve
        </button>
      )}
      <button
        onClick={onDeny}
        title="Deny: dismiss this suggestion"
        className={DENY_CLS}
      >
        <X className="w-3 h-3" /> Deny
      </button>
    </div>
  );

  return (
    <div>
      <div className="px-6 py-2 border-b border-slate-900/40 flex items-center justify-between">
        <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5 text-orange-400" /> Links ({total})
        </h3>
        <div className="flex items-center gap-2">
          <span className="hidden lg:flex items-center gap-1.5">
            {(Object.keys(TAG_STYLES) as LinkKind[]).map((kind) => (
              <span
                key={kind}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[8px] font-bold uppercase tracking-wide ${TAG_STYLES[kind].cls}`}
              >
                {TAG_STYLES[kind].icon}
                {TAG_STYLES[kind].label}
              </span>
            ))}
          </span>
          {isLoading && <span className="text-[10px] text-slate-500 italic">Scanning…</span>}
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            title="Refresh all link types"
            className="text-[10px] text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-3 max-h-40 overflow-y-auto">
        {error ? (
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
            <Info className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        ) : total === 0 ? (
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
            <Link2 className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <span>
              {deniedCount > 0
                ? 'All suggestions dismissed. Click Refresh to re-scan.'
                : isLoading
                  ? 'Scanning for keyword, semantic and backlink connections…'
                  : 'No links found. Run a scan or edit the note to discover connections.'}
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleMentions.map((m) => {
              const title = titleForId(m.targetNoteId);
              return (
                <div key={mentionKey(m)} className={CARD_CLS} onClick={() => onWikiLinkClick(title)}>
                  <TagPill kind="keyword" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-200 truncate">
                      &ldquo;{m.matchedText}&rdquo;
                    </div>
                    <div className="text-[10px] text-slate-500 truncate">→ {title}</div>
                  </div>
                  <ActionButtons
                    onApprove={() => onApproveMention(m)}
                    onDeny={() => setDenied((prev) => new Set(prev).add(mentionKey(m)))}
                  />
                </div>
              );
            })}

            {visibleRelated.map((m) => {
              const title = titleByPath(m.note_id);
              return (
                <div key={semanticKey(m)} className={CARD_CLS} onClick={() => onWikiLinkClick(title)}>
                  <TagPill kind="semantic" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-200 truncate">{title}</div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {Math.round(m.score * 100)}% similar
                    </div>
                  </div>
                  <ActionButtons
                    onApprove={() => onApproveSemantic(m)}
                    onDeny={() => setDenied((prev) => new Set(prev).add(semanticKey(m)))}
                  />
                </div>
              );
            })}

            {backlinks.map((b) => (
              <div key={b.source_id} className={CARD_CLS} onClick={() => onWikiLinkClick(b.source_title)}>
                <TagPill kind="backlink" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-200 truncate">{b.source_title}</div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {b.matched_text ? `Links via \u201c${b.matched_text}\u201d` : 'Links to this note'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

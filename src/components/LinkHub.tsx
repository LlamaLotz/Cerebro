import React, { useMemo, useState } from 'react';
import { Sparkles, Zap, Link2, RefreshCw, Info, Check, X, ExternalLink, EyeOff, Eye, ChevronDown, Anchor, Unlink, Tag } from 'lucide-react';
import { NoteFile, WikiLink } from '../types';
import { LinkMention, BacklinkInfo, DeniedLink } from '../services/linkerService';
import { SemanticMatch, BlockMatch } from '../services/semantic';

interface LinkHubProps {
  mentions: LinkMention[];
  backlinks: BacklinkInfo[];
  related: SemanticMatch[];
  blocks: BlockMatch[];
  outbound: WikiLink[];
  /** Hidden local keywords (`---kw---`) declared in the note body. */
  keywords: string[];
  onAddKeyword: (keyword: string) => void;
  onDeleteKeyword: (keyword: string) => void;
  notePath: string;
  dictionary: [string, string][];
  allNotes: NoteFile[];
  isLoading: boolean;
  error: string | null;
  /** Persisted dismissals (denied suggestions) for the active note — owned by
   *  the Editor so the toolbar badge, approve flows and this panel agree. */
  deniedEntries: DeniedLink[];
  deniedLoaded: boolean;
  onWikiLinkClick: (targetTitle: string, blockId?: string, line?: number) => void;
  onApproveMention: (mention: LinkMention) => void;
  onApproveSemantic: (match: SemanticMatch) => void;
  onApproveBlock: (match: BlockMatch) => void;
  onUnlinkLink: (link: WikiLink) => void;
  onDeny: (kind: string, target: string, matchedText?: string | null, start?: number, end?: number) => void;
  onRestore: (entry?: DeniedLink) => void;
  onRefresh: () => void;
  onCollapse: () => void;
}

type LinkKind = 'keyword' | 'semantic' | 'block' | 'backlink' | 'outbound';

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
  block: {
    label: 'Block',
    cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
    icon: <Anchor className="w-2.5 h-2.5" />,
  },
  backlink: {
    label: 'Backlink',
    cls: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    icon: <Link2 className="w-2.5 h-2.5" />,
  },
  outbound: {
    label: 'Applied',
    cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    icon: <ExternalLink className="w-2.5 h-2.5" />,
  },
};

const CARD_CLS =
  'flex items-center gap-2.5 bg-slate-950/60 border border-slate-850/80 hover:border-orange-500/30 hover:bg-slate-900/40 p-2 rounded-lg cursor-pointer transition-all';

const APPROVE_CLS =
  'flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20';

const DENY_CLS =
  'flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-400';

/** One unified section for every kind of connection to the current note,
 *  differentiated by tag pills and driven by Approve / Deny / Refresh actions.
 *  Denied entries live in the Editor (props) so dismissing every suggestion
 *  also hides the toolbar's Review button. */
export const LinkHub: React.FC<LinkHubProps> = ({
  mentions,
  backlinks,
  related,
  blocks,
  outbound,
  keywords,
  onAddKeyword,
  onDeleteKeyword,
  notePath,
  dictionary,
  allNotes,
  isLoading,
  error,
  deniedEntries,
  deniedLoaded,
  onWikiLinkClick,
  onApproveMention,
  onApproveSemantic,
  onApproveBlock,
  onUnlinkLink,
  onDeny,
  onRestore,
  onRefresh,
  onCollapse,
}) => {
  // Three-tab navigation: active suggestions/links vs denied suggestions
  // (keyword/semantic/block) vs hidden applied links (outbound/backlink).
  const [activeTab, setActiveTab] = useState<'active' | 'denied' | 'hidden'>('active');
  // Manual local-keyword entry (hidden from the note, managed here).
  const [keywordInput, setKeywordInput] = useState('');

  const submitKeyword = () => {
    const kw = keywordInput.trim();
    if (!kw) return;
    onAddKeyword(kw);
    setKeywordInput('');
  };

  // Stable keys (content-offset independent) so dismissals survive edits/refresh.
  const mentionKey = (m: LinkMention) => `keyword-${m.targetNoteId}-${m.matchedText}`;
  const semanticKey = (m: SemanticMatch) => `semantic-${m.note_id}`;
  const blockKey = (m: BlockMatch) => `block-${m.note_id}-${m.block_id}`;
  const outboundKey = (l: WikiLink) => `outbound-${l.targetTitle.toLowerCase()}`;
  const backlinkKey = (b: BacklinkInfo) => `backlink-${b.source_path.toLowerCase()}`;
  const deniedKey = (d: DeniedLink) =>
    d.kind === 'semantic'
      ? `semantic-${d.target}`
      : d.kind === 'block'
        ? `block-${d.target}-${d.matched_text ?? ''}`
        : d.kind === 'outbound'
          ? `outbound-${d.target.toLowerCase()}`
          : d.kind === 'backlink'
            ? `backlink-${d.target.toLowerCase()}`
            : `keyword-${d.target}-${d.matched_text ?? ''}`;

  const denied = useMemo(() => new Set(deniedEntries.map(deniedKey)), [deniedEntries]);

  // Denied tab = dismissed *suggestions*; Hidden tab = hidden *applied links*.
  const deniedSuggestions = deniedEntries.filter(
    (d) => d.kind === 'keyword' || d.kind === 'semantic' || d.kind === 'block'
  );
  const hiddenLinks = deniedEntries.filter(
    (d) => d.kind === 'outbound' || d.kind === 'backlink'
  );

  const titleForId = (id: string) =>
    dictionary.find(([noteId]) => noteId === id)?.[1] ?? id;
  const titleByPath = (path: string) =>
    allNotes.find((n) => n.path === path)?.title ??
    path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ??
    path;
  const labelForEntry = (d: DeniedLink) =>
    d.kind === 'keyword' ? d.matched_text ?? d.target : titleByPath(d.target) ?? d.target;

  // If an applied link is manually removed from the note body, clear its
  // dismissal so the plain-text mention can be suggested again.
  React.useEffect(() => {
    if (!notePath || deniedEntries.length === 0) return;
    const present = new Set(outbound.map((l) => l.targetTitle.toLowerCase()));
    for (const d of deniedEntries) {
      if (d.kind === 'outbound' && !present.has(d.target.toLowerCase())) {
        onRestore(d);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbound, deniedEntries]);

  const visibleOutbound = outbound.filter((l) => !denied.has(outboundKey(l)));

  const visibleMentions = mentions.filter((m) => !denied.has(mentionKey(m)));
  const visibleRelated = related.filter((m) => !denied.has(semanticKey(m)));
  const visibleBlocks = blocks.filter((m) => !denied.has(blockKey(m)));
  const visibleBacklinks = backlinks.filter((b) => !denied.has(backlinkKey(b)));
  const total =
    keywords.length +
    visibleMentions.length +
    visibleRelated.length +
    visibleBlocks.length +
    visibleBacklinks.length +
    visibleOutbound.length;

  const handleRefresh = () => {
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
    <div className="relative h-full flex flex-col overflow-hidden">
      <div className="px-6 py-2 border-b border-slate-900/40 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 shrink-0">
            <Link2 className="w-3.5 h-3.5 text-orange-400" /> Links
          </h3>
          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab('active')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold rounded-md transition-all ${
                activeTab === 'active'
                  ? 'bg-slate-800 text-orange-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Active
              <span
                className={`rounded-md px-1 text-[9px] font-bold ${
                  activeTab === 'active'
                    ? 'bg-orange-500/20 text-orange-300'
                    : 'bg-slate-800 text-slate-500'
                }`}
              >
                {total}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('denied')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold rounded-md transition-all ${
                activeTab === 'denied'
                  ? 'bg-slate-800 text-violet-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Denied
              <span
                className={`rounded-md px-1 text-[9px] font-bold ${
                  deniedSuggestions.length > 0
                    ? 'bg-violet-500/20 text-violet-300'
                    : 'bg-slate-800 text-slate-500'
                }`}
              >
                {deniedSuggestions.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('hidden')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold rounded-md transition-all ${
                activeTab === 'hidden'
                  ? 'bg-slate-800 text-sky-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Hidden
              <span
                className={`rounded-md px-1 text-[9px] font-bold ${
                  hiddenLinks.length > 0
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'bg-slate-800 text-slate-500'
                }`}
              >
                {hiddenLinks.length}
              </span>
            </button>
          </div>
        </div>
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
            onClick={onCollapse}
            title="Collapse links panel"
            className="text-[10px] text-slate-600 hover:text-orange-400 transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
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

      {/* Denied tab: dismissed suggestions (keyword/semantic/block), restore */}
      {activeTab === 'denied' && (
        <div className="px-6 py-3 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-2 gap-2">
            <p className="text-[11px] text-slate-500">
              Dismissed suggestions for this note. Restore to bring them back.
            </p>
            {deniedSuggestions.length > 0 && (
              <button
                onClick={() => deniedSuggestions.forEach((d) => onRestore(d))}
                className="text-[10px] text-violet-400 hover:text-violet-300 font-semibold shrink-0"
              >
                Restore all
              </button>
            )}
          </div>
          {deniedSuggestions.length === 0 ? (
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
              <EyeOff className="w-3.5 h-3.5 text-slate-600 shrink-0" />
              <span>
                {!deniedLoaded ? 'Loading denied links…' : 'No denied suggestions for this note.'}
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {deniedSuggestions.map((d) => {
                const kind = d.kind as LinkKind;
                const pillKind: LinkKind = kind === 'block' || kind === 'semantic' ? kind : 'keyword';
                return (
                  <div
                    key={deniedKey(d)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800"
                  >
                    <TagPill kind={pillKind} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-slate-300 truncate">{labelForEntry(d)}</span>
                      <span className="block text-[9px] text-slate-600 uppercase tracking-wide mt-0.5">
                        {kind}
                      </span>
                    </span>
                    <button
                      onClick={() => onRestore(d)}
                      title="Restore this suggestion"
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20"
                    >
                      <Eye className="w-3 h-3" /> Restore
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Hidden tab: hidden applied links (outbound/backlink), restore */}
      {activeTab === 'hidden' && (
        <div className="px-6 py-3 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-2 gap-2">
            <p className="text-[11px] text-slate-500">
              Applied links hidden from this list. Restore to show them again.
            </p>
            {hiddenLinks.length > 0 && (
              <button
                onClick={() => hiddenLinks.forEach((d) => onRestore(d))}
                className="text-[10px] text-sky-400 hover:text-sky-300 font-semibold shrink-0"
              >
                Restore all
              </button>
            )}
          </div>
          {hiddenLinks.length === 0 ? (
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
              <EyeOff className="w-3.5 h-3.5 text-slate-600 shrink-0" />
              <span>
                {!deniedLoaded ? 'Loading hidden links…' : 'No hidden links for this note.'}
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {hiddenLinks.map((d) => {
                const kind = d.kind as LinkKind;
                const pillKind: LinkKind = kind === 'outbound' || kind === 'backlink' ? kind : 'keyword';
                return (
                  <div
                    key={deniedKey(d)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800"
                  >
                    <TagPill kind={pillKind} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-slate-300 truncate">{labelForEntry(d)}</span>
                      <span className="block text-[9px] text-slate-600 uppercase tracking-wide mt-0.5">
                        {kind}
                      </span>
                    </span>
                    <button
                      onClick={() => onRestore(d)}
                      title="Restore this link"
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20"
                    >
                      <Eye className="w-3 h-3" /> Restore
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Topics tab removed — topic groups moved to the main Topics view (toolbar) */}

      {activeTab === 'active' && (
        <div className="px-6 py-3 flex-1 overflow-y-auto">
        {/* Hidden local keywords: declared as `---keyword---` in the note body,
            hidden from the rendered note, and managed exclusively here. */}
        <div className="mb-4 pb-3 border-b border-slate-900/60">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <Tag className="w-3 h-3 text-amber-400" /> Keywords
            </span>
            <span className="text-[9px] text-slate-600 italic">hidden from the note</span>
          </div>
          {keywords.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((kw) => (
                <span
                  key={kw.toLowerCase()}
                  className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/30 text-amber-300 text-[10px] font-semibold"
                >
                  {kw}
                  <button
                    onClick={() => onDeleteKeyword(kw)}
                    title={`Delete keyword "${kw}" from the note`}
                    className="p-0.5 rounded-full text-amber-400/60 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-slate-600">
              No keywords yet. Add one below to tag this note locally.
            </p>
          )}
          <div className="flex items-center gap-1.5 mt-2">
            <input
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitKeyword();
              }}
              placeholder="Add keyword… (e.g. productivity)"
              className="flex-1 min-w-0 bg-slate-950/70 border border-slate-800 rounded-md px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-amber-500/40 transition-colors"
            />
            <button
              onClick={submitKeyword}
              title="Add a hidden local keyword to this note"
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold rounded-md border transition-all bg-amber-500/10 border-amber-500/40 text-amber-400 hover:bg-amber-500/20"
            >
              <Check className="w-3 h-3" /> Add
            </button>
          </div>
        </div>

        {error ? (
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
            <Info className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        ) : total === 0 ? (
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 py-1">
            <Link2 className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <span>
              {deniedEntries.length > 0
                ? 'All suggestions dismissed for this note.'
                : !deniedLoaded
                  ? 'Loading denied links…'
                  : isLoading
                    ? 'Scanning for keyword, semantic and backlink connections…'
                    : 'No links found. Run a scan or edit the note to discover connections.'}
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleOutbound.map((l) => (
              <div
                key={outboundKey(l)}
                className={CARD_CLS}
                onClick={() => onWikiLinkClick(l.targetTitle, l.blockId)}
              >
                <TagPill kind="outbound" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-200 truncate">
                    {l.targetTitle}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {l.alias
                      ? `Linked via \u201c${l.alias}\u201d`
                      : l.blockId
                        ? `Links to ${l.blockId}`
                        : 'Existing wiki link'}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnlinkLink(l);
                  }}
                  title="Unlink: remove the [[wikilink]] syntax, keep the text"
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border transition-all bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-amber-500/10 hover:border-amber-500/40 hover:text-amber-400"
                >
                  <Unlink className="w-3 h-3" /> Unlink
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeny('outbound', l.targetTitle);
                  }}
                  title="Hide this applied link"
                  className={DENY_CLS}
                >
                  <X className="w-3 h-3" /> Hide
                </button>
              </div>
            ))}

            {visibleMentions.map((m) => {
              const title = titleForId(m.targetNoteId);
              return (
                <div key={mentionKey(m)} className={CARD_CLS} onClick={() => onWikiLinkClick(title)}>
                  <TagPill kind="keyword" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-200 truncate">
                      &ldquo;@{m.matchedText}&rdquo;
                    </div>
                    <div className="text-[10px] text-slate-500 truncate">→ {title}</div>
                  </div>
                  <ActionButtons
                    onApprove={() => onApproveMention(m)}
                    onDeny={() => onDeny('keyword', m.targetNoteId, m.matchedText, m.start, m.end)}
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
                    {m.matched_text && (
                      <div
                        className="mt-1 text-[10px] text-orange-300/80 line-clamp-2 whitespace-normal border-l-2 border-orange-500/40 pl-2 cursor-pointer"
                        title={
                          m.matched_block_id
                            ? 'Jump to the passage in this note that matched'
                            : 'The passage in this note that best matched'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onWikiLinkClick(title, m.matched_block_id ? `^${m.matched_block_id}` : undefined);
                        }}
                      >
                        &ldquo;{m.matched_text.split('\n').join(' ').slice(0, 220)}
                        {m.matched_text.length > 220 ? '…' : ''}&rdquo;
                      </div>
                    )}
                  </div>
                  <ActionButtons
                    onApprove={() => onApproveSemantic(m)}
                    onDeny={() => onDeny('semantic', m.note_id)}
                  />
                </div>
              );
            })}

            {visibleBlocks.map((m) => {
              const title = titleByPath(m.note_id);
              return (
                <div
                  key={blockKey(m)}
                  className={CARD_CLS}
                  onClick={() => onWikiLinkClick(title, `^${m.block_id}`)}
                >
                  <TagPill kind="block" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-200 truncate">{title}</div>
                    <div className="text-[10px] text-slate-500 line-clamp-2 whitespace-normal">
                      {m.text.split('\n').join(' ')}
                    </div>
                    <div className="text-[9px] text-indigo-400/70 truncate">
                      {Math.round(m.score * 100)}% · #{m.block_id}
                    </div>
                  </div>
                  <ActionButtons
                    onApprove={() => onApproveBlock(m)}
                    onDeny={() => onDeny('block', m.note_id, m.block_id)}
                  />
                </div>
              );
            })}

            {visibleBacklinks.map((b) => (
              <div
                key={backlinkKey(b)}
                className={CARD_CLS}
                onClick={() => onWikiLinkClick(b.source_title, undefined, b.start_line)}
              >
                <TagPill kind="backlink" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-200 truncate">{b.source_title}</div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {b.matched_text
                      ? `Mentioned via \u201c${b.matched_text}\u201d \u2014 not linked`
                      : 'Links to this note'}
                    {b.start_line > 0 && ` · line ${b.start_line}${b.end_line > b.start_line ? `–${b.end_line}` : ''}`}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeny('backlink', b.source_path);
                  }}
                  title="Delete/hide this backlink"
                  className={DENY_CLS}
                >
                  <X className="w-3 h-3" /> Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
};
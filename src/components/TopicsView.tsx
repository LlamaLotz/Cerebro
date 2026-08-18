import React, { useCallback, useEffect, useState } from 'react';
import { Tags, Link2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { linkerService } from '../services/linkerService';

interface TopicGroup {
  tag: string;
  notes: { note_id: string; title: string }[];
}

interface TopicsViewProps {
  onWikiLinkClick: (targetTitle: string, blockId?: string, line?: number) => void;
}

/** Vault-wide @topic groups: any note mentioning `@tag` (not glued to a
 *  preceding word char) joins that topic. Sorted by tag, expandable. */
export const TopicsView: React.FC<TopicsViewProps> = ({ onWikiLinkClick }) => {
  const [topicGroups, setTopicGroups] = useState<TopicGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());

  const loadTopics = useCallback(() => {
    setLoading(true);
    linkerService
      .getTopicGroups()
      .then((groups) =>
        setTopicGroups(
          groups.map(([tag, notes]) => ({
            tag,
            notes: notes.map(([note_id, title]) => ({ note_id, title })),
          }))
        )
      )
      .catch((e) => {
        console.error('Failed to load topic groups:', e);
        setTopicGroups([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  // Re-fetch topic groups when the vault changes (external edits, renames,
  // imports) so a tag added to any note shows up without a manual Refresh.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('vault-changed', () => loadTopics())
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e) => console.error('Failed to listen for vault changes:', e));
    return () => {
      unlisten?.();
    };
  }, [loadTopics]);

  const toggleTag = (tag: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const totalNotes = topicGroups.reduce((sum, g) => sum + g.notes.length, 0);

  return (
    <div
      data-region="topics"
      className="flex-1 h-full flex flex-col overflow-hidden"
    >
      <div className="px-6 py-2.5 border-b border-neutral-900 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5 shrink-0">
            <Tags className="w-3.5 h-3.5 text-teal-400" /> Topics
          </h3>
          <span className="text-[10px] text-neutral-500">
            {loading ? 'Loading…' : `${topicGroups.length} topics · ${totalNotes} notes`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {topicGroups.length > 0 && (
            <button
              onClick={() =>
                setExpandedTags(
                  expandedTags.size === topicGroups.length
                    ? new Set()
                    : new Set(topicGroups.map((g) => g.tag))
                )
              }
              className="text-[10px] text-teal-400 hover:text-teal-300 font-semibold"
            >
              {expandedTags.size === topicGroups.length ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <button
            onClick={loadTopics}
            disabled={loading}
            title="Refresh topic groups"
            className="text-[10px] text-neutral-500 hover:text-teal-400 transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && topicGroups.length === 0 ? (
          <div className="text-[11px] text-neutral-500 italic">Loading topics…</div>
        ) : topicGroups.length === 0 ? (
          <div className="text-[11px] text-neutral-500 flex items-center gap-1.5 py-1">
            <Tags className="w-3.5 h-3.5 text-neutral-600 shrink-0" />
            <span>
              No @topic tags in the vault yet. Write <span className="text-teal-400">@topic</span>{' '}
              anywhere in a note to group it.
            </span>
          </div>
        ) : (
          <div className="max-w-3xl space-y-1.5">
            {topicGroups.map((g) => {
              const open = expandedTags.has(g.tag);
              return (
                <div
                  key={g.tag}
                  className="rounded-lg bg-neutral-950/60 border border-neutral-900 overflow-hidden"
                >
                  <button
                    onClick={() => toggleTag(g.tag)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-neutral-900 transition-colors text-left"
                  >
                    {open ? (
                      <ChevronDown className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                    )}
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-teal-500/30 bg-teal-500/10 text-teal-400 text-[11px] font-bold">
                      @{g.tag}
                    </span>
                    <span className="text-[10px] text-neutral-500 ml-auto">{g.notes.length}</span>
                  </button>
                  {open && (
                    <div className="px-4 pb-2.5 pt-1 space-y-1">
                      {g.notes.map((n) => (
                        <button
                          key={n.note_id}
                          onClick={() => onWikiLinkClick(n.title)}
                          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left hover:bg-neutral-900/80 transition-colors"
                        >
                          <Link2 className="w-3 h-3 text-neutral-600 shrink-0" />
                          <span className="text-xs text-neutral-300 truncate">{n.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
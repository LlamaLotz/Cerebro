import { invoke } from '@tauri-apps/api/core';

export interface LinkMention {
  targetNoteId: string;
  matchedText: string;
  start: number;
  end: number;
}

export interface BacklinkInfo {
  source_path: string;
  source_title: string;
  start_line: number;
  end_line: number;
  matched_text: string | null;
}

export interface DeniedLink {
  kind: string;
  target: string;
  matched_text: string | null;
}

export const linkerService = {
  async initLinker(patterns: string[]): Promise<void> {
    await invoke('init_linker', { patterns });
  },

  async startWatchingVault(vaultPath: string): Promise<void> {
    await invoke('start_watching_vault', { vaultPath });
  },

  async getVaultDictionary(): Promise<[string, string][]> {
    return await invoke('get_vault_dictionary');
  },

  // @keyword topic groups: [tag, [[note_id, title], ...]][]
  async getTopicGroups(): Promise<[string, [string, string][]][]> {
    return await invoke('get_topic_groups');
  },

  async indexNote(
    id: string,
    title: string,
    path: string,
    aliases: string[]
  ): Promise<void> {
    await invoke('index_note', { id, title, path, aliases });
  },

  async getIncomingBacklinks(targetId: string): Promise<BacklinkInfo[]> {
    return await invoke('get_incoming_backlinks', { targetId });
  },

  // Lightweight, active-note-only backlink fetch (with source line ranges).
  async getBacklinksForNote(notePath: string): Promise<BacklinkInfo[]> {
    return await invoke('get_backlinks_for_note', { notePath });
  },

  async scanUnlinkedMentions(
    content: string,
    currentNoteId: string,
    dictionary: [string, string][]
  ): Promise<LinkMention[]> {
    const mentions: any[] = await invoke('scan_unlinked_mentions', {
      content,
      currentNoteId,
      dictionary,
    });

    return mentions.map((m) => ({
      targetNoteId: m.target_note_id,
      matchedText: m.matched_text,
      start: m.start,
      end: m.end,
    }));
  },

  async applyApprovedLinks(filePath: string, approvedLinks: LinkMention[]): Promise<void> {
    const rustLinks = approvedLinks.map((l) => ({
      target_note_id: l.targetNoteId,
      matched_text: l.matchedText,
      start: l.start,
      end: l.end,
    }));
    await invoke('apply_approved_links', { filePath, approvedLinks: rustLinks });
  },

  async addDeniedLink(
    notePath: string,
    kind: string,
    target: string,
    matchedText?: string | null
  ): Promise<void> {
    await invoke('add_denied_link', {
      notePath,
      kind,
      target,
      matchedText: matchedText ?? null,
    });
  },

  async getDeniedLinks(notePath: string): Promise<DeniedLink[]> {
    return await invoke('get_denied_links', { notePath });
  },

  async removeDeniedLink(
    notePath: string,
    kind?: string,
    target?: string,
    matchedText?: string | null
  ): Promise<void> {
    await invoke('remove_denied_link', {
      notePath,
      kind: kind ?? null,
      target: target ?? null,
      matchedText: matchedText ?? null,
    });
  },
};

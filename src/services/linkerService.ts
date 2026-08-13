import { invoke } from '@tauri-apps/api/core';

export interface LinkMention {
  targetNoteId: string;
  matchedText: string;
  start: number;
  end: number;
}

export interface BacklinkInfo {
  source_id: string;
  source_title: string;
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
};

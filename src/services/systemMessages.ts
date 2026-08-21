import systemMessages from './systemMessages.json';

export interface SystemMessages {
  chatSystemPrompt: string;
  noteContextTemplate: string;
  noNoteContext: string;
  summarizeSystemPrompt: string;
  linkSuggestSystemPrompt: string;
  metadataSystemPrompt: string;
}

/** The raw, user-editable system messages (see systemMessages.json). */
export const getSystemMessages = (): SystemMessages => systemMessages;

/**
 * Builds the chat system prompt for the Co-Pilot sidebar, injecting the
 * active note's context into the `{note_context}` placeholder.
 */
export function buildChatSystemPrompt(note: { title: string; content?: string } | null): string {
  const { chatSystemPrompt, noteContextTemplate, noNoteContext } = systemMessages;
  const context = note
    ? noteContextTemplate
        .replace('{note_title}', note.title)
        .replace('{note_content}', note.content ?? '')
    : noNoteContext;
  return chatSystemPrompt.replace('{note_context}', context);
}

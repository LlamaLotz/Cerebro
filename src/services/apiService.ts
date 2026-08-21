import OpenAI from 'openai';
import { OmniRouteConfig } from '../types';
import { getSystemMessages } from './systemMessages';

/**
 * Gets an OpenAI instance configured for OmniRoute
 */
export function getAIClient(config: OmniRouteConfig): OpenAI | null {
  if (!config.apiKey || !config.baseUrl) {
    return null;
  }
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    dangerouslyAllowBrowser: true, // Required in Electron/Vite renderer context
  });
}

/**
 * Sends a generic chat request to the AI using OmniRoute.
 *
 * Honors the runtime config: the chat `temperature` is sent with every
 * request, and when `injectUserProfile` is enabled (with a non-empty
 * `userProfile`), the profile is prepended as an extra system message so the
 * model knows who it's helping — for the free-form chat AND every quick action
 * (they all funnel through this function).
 */
export async function sendChatMessage(
  config: OmniRouteConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Promise<string> {
  const client = getAIClient(config);
  if (!client) {
    throw new Error('AI is not configured. Please enter your OmniRoute API Key and Base URL in settings.');
  }

  const fullMessages = [...messages];
  if (config.injectUserProfile && config.userProfile?.trim()) {
    fullMessages.unshift({
      role: 'system',
      content: `User profile (who you are helping):\n${config.userProfile.trim()}`,
    });
  }

  try {
    const response = await client.chat.completions.create({
      model: config.model || 'gpt-4o',
      messages: fullMessages,
      temperature: config.temperature ?? 0.7,
    });

    return response.choices[0]?.message?.content || 'No response from AI.';
  } catch (error: any) {
    console.error('OmniRoute chat error:', error);
    throw new Error(error.message || 'An error occurred while calling OmniRoute AI.');
  }
}

/**
 * Summarizes the active note
 */
export async function summarizeNote(
  config: OmniRouteConfig,
  noteTitle: string,
  noteContent: string
): Promise<string> {
  const systemPrompt = getSystemMessages().summarizeSystemPrompt;

  const userPrompt = `Please summarize my note titled "${noteTitle}". Here is the content:\n\n${noteContent}`;

  return sendChatMessage(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

/**
 * Proposes relevant connections/links with other existing notes
 */
export async function suggestConnections(
  config: OmniRouteConfig,
  noteTitle: string,
  noteContent: string,
  allNotes: Array<{ title: string; content: string }>
): Promise<string> {
  const existingNotesList = allNotes.map((n) => n.title).join(', ');

  const systemPrompt = getSystemMessages().linkSuggestSystemPrompt;

  const userPrompt = `Active Note Title: "${noteTitle}"
Active Note Content:
"""
${noteContent}
"""

Other Notes in Vault: [ ${existingNotesList} ]

Please suggest 2 to 5 highly relevant connections from the vault and briefly explain why.`;

  return sendChatMessage(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

/**
 * Suggests tags and key metadata for the active note
 */
export async function suggestMetadata(
  config: OmniRouteConfig,
  noteTitle: string,
  noteContent: string
): Promise<string> {
  const systemPrompt = getSystemMessages().metadataSystemPrompt;

  const userPrompt = `Note Title: "${noteTitle}"
Note Content:
"""
${noteContent}
"""

Please suggest frontmatter and tags in clean markdown format.`;

  return sendChatMessage(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

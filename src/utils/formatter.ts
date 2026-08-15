/**
 * Formatting utilities for keeping notes neat and consistent.
 * The H1 title is always kept in sync with the note's filename.
 */

import { extractKeywordTokens, stripKeywordTokens } from './keywords';

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fm) return { frontmatter: '', body: content };
  return { frontmatter: fm[0], body: content.slice(fm[0].length) };
}

function normalizeHeadingPrefix(line: string): string {
  const m = line.match(/^(#{1,6})(\S.*)$/);
  return m ? `${m[1]} ${m[2]}` : line;
}

/**
 * Formats a note:
 *  - ensures a single H1 at the top matching `title`
 *  - demotes any other H1 to H2
 *  - normalizes heading prefixes (`#foo` -> `# foo`)
 *  - normalizes spacing (one blank line around headings, no trailing spaces)
 * Code blocks (``` fences) are preserved verbatim.
 */
export function formatNote(content: string, title: string): string {
  const { frontmatter, body } = splitFrontmatter(content);

  // Hidden local keywords (`---kw---`) always stay on the first line: pull
  // every token out of the body before formatting, then re-attach them to the
  // formatted first line so the H1 sync never strips or scatters them.
  const keywordTokens = extractKeywordTokens(body);

  let lines = body
    .split('\n')
    .map(stripKeywordTokens)
    .map(normalizeHeadingPrefix)
    .map((l) => l.trimEnd());

  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const titleLower = title.trim().toLowerCase();
  const out: string[] = [];

  // Title H1 always first
  if (title.trim()) out.push(`# ${title.trim()}`);

  let titleSeen = false;
  let inFence = false;

  const push = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) inFence = !inFence;
    if (inFence) {
      out.push(line);
      return;
    }
    // Blank line before any heading (but not at the very start)
    if (/^#{1,6}\s/.test(line) && out.length > 0 && out[out.length - 1].trim() !== '') {
      out.push('');
    }
    if (line.trim() === '') {
      // keep at most one blank line
      if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    } else {
      out.push(line);
    }
  };

  for (const line of lines) {
    if (inFence) {
      push(line);
      continue;
    }
    if (/^#\s/.test(line)) {
      const text = line.replace(/^#\s+/, '').trim();
      if (!titleSeen && text.toLowerCase() === titleLower) {
        titleSeen = true;
        continue; // title already placed at the top
      }
      push(`## ${text}`);
      continue;
    }
    push(line);
  }

  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();

  // Re-attach the hidden keyword tokens to the first line.
  if (keywordTokens.length > 0) {
    if (out.length > 0 && out[0].trim() !== '') {
      out[0] = `${out[0].trimEnd()} ${keywordTokens.join(' ')}`;
    } else {
      out.unshift(keywordTokens.join(' '));
    }
  }

  return frontmatter + out.join('\n') + '\n';
}

/** True when the first heading in the note is `title` (case-insensitive).
 *  Hidden `---keyword---` tokens are ignored so they don't mask the H1. */
export function noteTitleMatches(content: string, title: string): boolean {
  const scrubbed = content.split('\n').map(stripKeywordTokens).join('\n');
  const m = scrubbed.match(/^#{1,6}\s+(.+?)\s*$/m);
  return !!m && m[1].trim().toLowerCase() === title.trim().toLowerCase();
}

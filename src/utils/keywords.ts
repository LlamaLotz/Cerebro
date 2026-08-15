/**
 * Manual local keywords: `---keyword---` tokens written into a note (typically
 * on the first line) that are hidden from the rendered note and managed from
 * the LinkHub. They are local to the note — they never link to another note.
 *
 * A bare `---` (markdown horizontal rule) never matches: the token needs a
 * word character right after the opening fence. Single hyphens are allowed
 * inside the keyword, but a `---` run always ends the token (tempered
 * lookahead) so `---foo--- ---bar---` parses as two keywords, never one.
 */

const TOKEN_SOURCE = String.raw`---([A-Za-z0-9](?:(?!---)[A-Za-z0-9 _-])*)---`;
export const LOCAL_KEYWORD_TOKEN_RE = new RegExp(TOKEN_SOURCE, 'g');
export const LOCAL_KEYWORD_TOKEN_STRIP_RE = new RegExp(TOKEN_SOURCE, 'g');

export interface KeywordRange {
  keyword: string;
  start: number;
  end: number;
}

/** Every `---keyword---` token in `content` with its absolute offsets. */
export function findKeywordRanges(content: string): KeywordRange[] {
  const ranges: KeywordRange[] = [];
  LOCAL_KEYWORD_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_KEYWORD_TOKEN_RE.exec(content)) !== null) {
    ranges.push({ keyword: m[1], start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/** Deduplicated keyword list in document order (case-insensitive dedup). */
export function extractKeywords(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of findKeywordRanges(content)) {
    const key = r.keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r.keyword);
    }
  }
  return out;
}

/** Every raw token (`---kw---`) in document order, duplicates included. */
export function extractKeywordTokens(content: string): string[] {
  return findKeywordRanges(content).map((r) => content.slice(r.start, r.end));
}

/** Removes every `---keyword---` token from a single line (preview rendering). */
export function stripKeywordTokens(line: string): string {
  LOCAL_KEYWORD_TOKEN_STRIP_RE.lastIndex = 0;
  return line.replace(LOCAL_KEYWORD_TOKEN_STRIP_RE, '');
}

/**
 * Normalizes raw user input into a valid keyword: trims surrounding
 * whitespace, unwraps `---...---` if the user pasted the full token, and
 * rejects empty/invalid values. Returns '' when nothing usable was typed.
 */
export function normalizeKeyword(raw: string): string {
  let kw = raw.trim();
  if (!kw) return '';
  if (kw.startsWith('---') && kw.endsWith('---') && kw.length > 6) {
    kw = kw.slice(3, -3).trim();
  }
  if (!/^[A-Za-z0-9]/.test(kw) || !/[A-Za-z0-9]$/.test(kw)) return '';
  return kw;
}

/** Serializes a keyword back into its hidden token form. */
export function keywordToken(keyword: string): string {
  return `---${keyword}---`;
}
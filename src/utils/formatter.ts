/**
 * Formatting utilities for keeping notes neat and consistent.
 * The H1 title is always kept in sync with the note's filename.
 */

import { extractKeywordTokens, stripKeywordTokens } from './keywords';

/**
 * Clean formatting utility function:
 * 1. Heading Normalization:
 *    - Standardizes headings to `# Heading 1`, `## Heading 2`, etc.
 *    - Strips duplicate `#` symbols (e.g. `## # Title` -> `## Title`).
 *    - Ensures exactly one space exists between `#` hashes and heading text.
 * 2. Character & OCR Cleanup:
 *    - Removes unprintable ASCII control characters, replacement characters
 *      (\uFFFD), zero-width spaces (\u200B) and BOM (\uFEFF).
 *    - Fixes broken quote marks and normalizes tab characters to 2 spaces.
 * 3. Junk Line Removal:
 *    - Drops InDesign/publication margin headers (`.indd` identifiers,
 *      standalone page numbers, dates) and garbled diacritic-symbol rows.
 * 4. Smart Line Joining (PDF/OCR repair):
 *    - Adjacent plain-text lines that don't end with sentence punctuation
 *      (. ! ? : ;) and whose next line starts with lowercase (and isn't a
 *      markdown element) are joined with a single space.
 * 5. Whitespace Normalization:
 *    - Trims trailing spaces from line ends.
 *    - Collapses 3 or more consecutive blank lines down to a clean double newline (\n\n).
 */

/** True when a line is publication layout junk that repeats on every page of
 *  an InDesign/PDF export (page numbers, dates, .indd ids, diacritic rows). */
function isJunkLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.includes('.indd') || t.includes('InDesign')) return true;
  if (/^(?:p(?:age|g)?\.?\s*|[-–—]\s*)?\d{1,4}(?:\s*[-–—])?(?:\s+of\s+\d{1,4})?$/i.test(t)) return true;
  if (
    /^(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4})$/i.test(t)
  ) {
    return true;
  }
  const hasAscii = /[A-Za-z0-9]/.test(t);
  if (!hasAscii && /[^\x00-\x7F]/.test(t)) return true;
  return false;
}

/** True when a line starts a markdown element that must never be joined into
 *  the previous paragraph (headings, lists, quotes, tables, rules, code). */
function isMarkdownLine(line: string): boolean {
  const t = line.trimStart();
  return (
    t.startsWith('#') ||
    t.startsWith('```') ||
    t.startsWith('`') ||
    t.startsWith('- ') ||
    t.startsWith('* ') ||
    t.startsWith('+ ') ||
    t.startsWith('>') ||
    t.startsWith('|') ||
    t.startsWith('---') ||
    t.startsWith('***') ||
    t.startsWith('___') ||
    /^\d/.test(t) ||
    t.startsWith('![')
  );
}

/** Capitalizes the first letter of every word (`the dark forest` -> `The Dark Forest`). */
function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Detects plain-text lines that are really chapter/section titles (from PDF,
 * OCR or Word exports where headings weren't written as markdown) and returns
 * them as `## Heading` lines. Runs BEFORE junk removal and smart line-joining,
 * so detected headings are protected from being merged into the paragraph
 * below. Never fires inside code fences.
 *
 * Signals, all must agree:
 *  - explicit markers: `Chapter 3`, `CHAPTER ONE: Title`, `Part II`, `Section 3.2`
 *  - numbered sections: `1. Introduction`, `3.2 Results` (number stripped) —
 *    unless the next line is numbered too, which means it's a list, not a title
 *  - ALL-CAPS title lines (`THE BEGINNING`, `PART ONE`) with >= 3 words
 *  - short Title-Case lines isolated by blank lines on both sides
 * Vetoes: ends with sentence punctuation, markdown/list starts, > 100 chars,
 * and marker lines whose trailing text starts lowercase ("Chapter 1 covers…"
 * is a sentence, not a heading).
 */
function detectSectionHeadings(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    const prevEmpty = i === 0 || lines[i - 1].trim() === '';
    const prevLine = i > 0 ? lines[i - 1].trim() : '';
    const next = (lines[i + 1] ?? '').trim();
    const nextEmpty = next === '';
    const nextListLike = /^[-*+>|]|^\d+[.)]/.test(next);
    const prevListLike = /^[-*+>|]|^\d+[.)]/.test(prevLine);
    let heading: string | null = null;

    if (trimmed && trimmed.length <= 100 && !/[.!?]$/.test(trimmed)) {
      // (a) Explicit chapter/section markers
      const marker = trimmed.match(
        /^(chapter|ch\.?|section|sec\.?|part|lesson|module|unit|appendix)\s+(\d+(?:\.\d+)*|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b(?:\s*[:.\-–—]\s*|\s+)?(.*)$/i
      );
      if (marker) {
        const rest = marker[3].trim();
        // Sentence veto: "Chapter 1 covers the basics" is prose, not a title.
        if (rest === '' || /^[A-Z0-9"“]/.test(rest)) {
          const clean = trimmed.replace(/[\s.:\-–—]+$/, '');
          // Normalize marker + number case: `CHAPTER TWO` -> `Chapter Two`,
          // but keep roman numerals (`Part II`) and mixed case intact.
          const words = clean.split(/\s+/);
          const [w1 = '', w2 = '', ...restWords] = words;
          const capWord = (w: string) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);
          const isRoman = (w: string) => !!w && /^[ivxlcdm]+$/i.test(w);
          const w2Capped =
            w2 && /[A-Za-z]/.test(w2) && w2 === w2.toUpperCase() && !isRoman(w2)
              ? capWord(w2)
              : w2;
          heading = `## ${[capWord(w1), w2Capped, ...restWords].join(' ')}`;
        }
      } else if (!nextListLike && !prevListLike && !/^[-*+>|]/.test(trimmed)) {
        // (b) Numbered sections: "1. Introduction", "3.2 Results"
        const numbered = trimmed.match(/^(\d+(?:\.\d+)*)[.)]?\s+([A-Z0-9"“][^.!?]{1,80})$/);
        if (numbered) {
          heading = `## ${numbered[2].trim()}`;
        } else if (/^[A-Z0-9][A-Z0-9 &'’\-–—,/:()]{3,58}$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
          // (c) ALL-CAPS title lines (classic book/PDF chapter titles)
          if (trimmed.split(/\s+/).length >= 3) {
            heading = `## ${titleCase(trimmed)}`;
          }
        } else if (
          prevEmpty &&
          nextEmpty &&
          trimmed.length <= 60 &&
          /^[A-Z][A-Za-z0-9'’\- ]{2,59}$/.test(trimmed) &&
          trimmed.split(/\s+/).length >= 2
        ) {
          // (d) Short Title-Case line isolated by blank lines (section title)
          heading = `## ${trimmed}`;
        }
      }
    }
    out.push(heading ?? line);
  }
  return out;
}

export function formatNoteContent(rawText: string): string {
  if (!rawText) return '';

  // 1. Character & OCR Cleanup
  let cleaned = rawText.replace(/\t/g, '  ');

  // Remove unprintable ASCII control characters [\x00-\x08\x0B\x0C\x0E-\x1F],
  // replacement characters \uFFFD, zero-width spaces \u200B and BOM \uFEFF
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFD\u200B\uFEFF]/g, '');

  // Fix broken quote marks
  cleaned = cleaned
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'");

  // Mojibake repair: undo double-encoded UTF-8/CP1252 sequences (common in
  // PDF/Word exports). Specific sequences first, stray markers last — order
  // matters (e.g. `Ã©` -> `é` must run before stray `Ã` is stripped).
  cleaned = cleaned
    .replace(/\u00e2\u20ac\u2122/g, "'") // â€™ -> ' (U+2019)
    .replace(/\u00e2\u20ac\u02dc/g, "'") // â€˜ -> ' (U+2018)
    .replace(/\u00e2\u20ac\u0153/g, '"') // â€œ -> " (U+201C)
    .replace(/\u00e2\u20ac\u009d/g, '"') // â€<0x9D> -> " (U+201D)
    .replace(/\u00e2\u20ac\u0161/g, "'") // â€š -> ' (U+201A)
    .replace(/\u00e2\u20ac\u2013/g, '\u2013') // â€“ -> – (U+2013)
    .replace(/\u00e2\u20ac\u2014/g, '\u2014') // â€” -> — (U+2014)
    .replace(/\u00e2\u20ac\u2026/g, '\u2026') // â€¦ -> … (U+2026)
    .replace(/\u00e2\u20ac\u00a2/g, '\u2022') // â€¢ -> • (U+2022)
    .replace(/\u00c3\u00a9/g, '\u00e9') // Ã© -> é
    .replace(/\u00c3\u00a8/g, '\u00e8') // Ã¨ -> è
    .replace(/\u00c3\u00aa/g, '\u00ea') // Ãª -> ê
    .replace(/\u00c3\u00ab/g, '\u00eb') // Ã« -> ë
    .replace(/\u00c3\u00a2/g, '\u00e2') // Ã¢ -> â
    .replace(/\u00c3\u00a4/g, '\u00e4') // Ã¤ -> ä
    .replace(/\u00c3\u00a3/g, '\u00e3') // Ã£ -> ã
    .replace(/\u00c3\u00a5/g, '\u00e5') // Ã¥ -> å
    .replace(/\u00c3\u00a7/g, '\u00e7') // Ã§ -> ç
    .replace(/\u00c3\u00ae/g, '\u00ee') // Ã® -> î
    .replace(/\u00c3\u00af/g, '\u00ef') // Ã¯ -> ï
    .replace(/\u00c3\u00b4/g, '\u00f4') // Ã´ -> ô
    .replace(/\u00c3\u00b6/g, '\u00f6') // Ã¶ -> ö
    .replace(/\u00c3\u00b5/g, '\u00f5') // Ãµ -> õ
    .replace(/\u00c3\u00b9/g, '\u00f9') // Ã¹ -> ù
    .replace(/\u00c3\u00bc/g, '\u00fc') // Ã¼ -> ü
    .replace(/\u00c3\u00bb/g, '\u00fb') // Ã» -> û
    .replace(/\u00c3\u00b1/g, '\u00f1') // Ã± -> ñ
    .replace(/\u00c3\u0089/g, '\u00c9') // Ã‰ -> É
    .replace(/\u00c3\u009c/g, '\u00dc') // Ãœ -> Ü
    .replace(/\u00c3\u009f/g, '\u00df') // ÃŸ -> ß
    .replace(/\u00c3\u00a6/g, '\u00e6') // Ã¦ -> æ
    .replace(/\u00c3\u00b8/g, '\u00f8') // Ã¸ -> ø
    .replace(/\u00c3\u00b0/g, '\u00f0') // Ã° -> ð
    .replace(/\u00c3\u00be/g, '\u00fe') // Ã¾ -> þ
    .replace(/\u00c2\u00a3/g, '\u00a3') // Â£ -> £
    .replace(/\u00c2(?![\u00a0-\u00ff])/g, '') // stray Â: kept only before a Latin-1 char
    .replace(/\u00c3(?![\u00a0-\u00ff])/g, ''); // stray Ã: kept only before a Latin-1 char

  // Final garbage pass: drop remaining C1 control chars, private-use chars and
  // stray zero-width/BOM marks (mirrors the Rust formatter — ZWJ/emoji kept).
  cleaned = cleaned.replace(/[\u0080-\u009f\uE000-\uF8FF\u200B\uFEFF]/g, '');

  // 2. Heading Normalization (preserving code fences)
  const lines = cleaned.split('\n');
  const processedLines: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmedEnd = line.trimEnd();

    if (trimmedEnd.trimStart().startsWith('```')) {
      inCodeFence = !inCodeFence;
      processedLines.push(trimmedEnd);
      continue;
    }

    if (inCodeFence) {
      processedLines.push(trimmedEnd);
      continue;
    }

    const trimmedStart = trimmedEnd.trimStart();
    const leadingSpacesCount = trimmedEnd.length - trimmedStart.length;

    if (trimmedStart.startsWith('#') && leadingSpacesCount < 4) {
      const match = trimmedStart.match(/^(#{1,6})(?:\s*#+(?=\s|$))*\s*(.*)$/);
      if (match) {
        const hashes = match[1];
        const text = match[2].trim();
          processedLines.push(text ? `${hashes} ${text}` : hashes);
      } else {
        processedLines.push(trimmedEnd);
      }
    } else {
      processedLines.push(trimmedEnd);
    }
  }

  // 2.5 Chapter/section title detection: plain-text lines that read as
  //     headings become `## Heading` (protected from smart-joining below).
  const detectedLines = detectSectionHeadings(processedLines);

  // 3. Junk line removal: page numbers, dates, .indd ids, diacritic rows
  const junkFiltered = detectedLines.filter((l) => !isJunkLine(l));

  // 4. Smart Line Joining (PDF/OCR repair)
  const joined: string[] = [];
  let inFence = false;
  for (const line of junkFiltered) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      joined.push(line);
      continue;
    }
    if (inFence) {
      joined.push(line);
      continue;
    }
    const prev = joined[joined.length - 1];
    const prevText = prev?.trimEnd() ?? '';
    const nextText = line.trimStart();
    // A trailing ASCII hyphen usually splits a word across lines ("pro-\ncess");
    // reattach without the hyphen. Real dashes (em/en, or a space before the
    // hyphen) stay put.
    const hyphenSplit =
      /-$/.test(prevText) &&
      prevText.length > 2 &&
      !/ -$/.test(prevText) &&
      /^[a-z]/.test(nextText);
    const canJoin =
      prev !== undefined &&
      prev !== '' &&
      !isMarkdownLine(prev) &&
      !isMarkdownLine(line) &&
      // `:`/`;` are not sentence-enders — a line ending in them usually continues.
      !/[.!?]$/.test(prevText) &&
      (/^[a-z]/.test(nextText) || hyphenSplit);
    if (canJoin) {
      joined[joined.length - 1] = hyphenSplit
        ? `${prevText.slice(0, -1)}${nextText}`
        : `${prevText} ${nextText}`;
    } else {
      joined.push(line);
    }
  }

  // 5. Whitespace Normalization
  const finalLines: string[] = [];
  let i = 0;
  while (i < joined.length) {
    if (joined[i] === '') {
      let j = i;
      while (j < joined.length && joined[j] === '') {
        j++;
      }
      const count = j - i;
      if (count >= 3) {
        finalLines.push('');
      } else {
        for (let k = 0; k < count; k++) {
          finalLines.push('');
        }
      }
      i = j;
    } else {
      finalLines.push(joined[i]);
      i++;
    }
  }

  let result = finalLines.join('\n');
  if (result.length > 0 && rawText.endsWith('\n')) {
    result += '\n';
  }
  return result;
}

export const format_note_content = formatNoteContent;

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fm) return { frontmatter: '', body: content };
  return { frontmatter: fm[0], body: content.slice(fm[0].length) };
}

function normalizeHeadingPrefix(line: string): string {
  // Safety net: `#foo` -> `# foo`. The (?<!#) lookbehind stops the hash run
  // from backtracking, so correctly-spaced headings like `### Header` (whose
  // content starts with `#`) are never mangled into `## # Header`.
  const m = line.match(/^(#{1,6})(?<!#)(\S.*)$/);
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

  // Run the full cleaner first (junk line removal, smart joining, invisible
  // character stripping) so the one-click Format repairs PDF/OCR noise too.
  const cleanedBody = formatNoteContent(body);

  let lines = cleanedBody
    .split('\n')
    .map(stripKeywordTokens)
    .map(normalizeHeadingPrefix)
    .map((l) => l.trimEnd());

  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const titleLower = title.trim().toLowerCase();
  const out: string[] = [];

  // Title H1 always first (`# Title` — space after the final #)
  if (title.trim()) out.push(`# ${title.trim()}`);

  let inFence = false;

  const push = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) inFence = !inFence;
    if (inFence) {
      out.push(line);
      return;
    }
    // Blank line before any heading (but not at the very start)
    if (/^#{1,6}/.test(line) && out.length > 0 && out[out.length - 1].trim() !== '') {
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
    if (/^#/.test(line)) {
      const hashRun = line.match(/^#{1,6}/)![0].length;
      if (hashRun === 1) {
        // H1: the note title is already placed at the top, so skip ANY H1
        // whose text matches it (a second `# Title` mid-body is just a
        // duplicate of the title, not a section to keep or demote). Other
        // H1s are demoted to `## Text` (space after the final #).
        const text = line.replace(/^#/, '').trim();
        if (text.toLowerCase() === titleLower) {
          continue;
        }
        push(text ? `## ${text}` : '##');
      } else {
        // H2+ headings pass through untouched (already `## Text` form).
        push(line);
      }
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
  const m = scrubbed.match(/^#{1,6}\s*(.+?)\s*$/m);
  return !!m && m[1].trim().toLowerCase() === title.trim().toLowerCase();
}

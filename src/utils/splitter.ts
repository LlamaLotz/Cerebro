/**
 * Splitting utility: turns one large note into one note per `##` section.
 *
 * The parent note keeps its frontmatter + intro text and becomes an index of
 * `[[Section]]` links; each section becomes a new note (same folder) with an
 * H1 (the section title) and a `[[Parent]]` back-link so the graph connects
 * both ways.
 */

export interface SectionPlan {
  /** Human title of the section (also the H1 inside the new note). */
  title: string;
  /** Slugified, de-duplicated filename WITHOUT the `.md` extension. */
  fileName: string;
  /** Full content of the new note file. */
  content: string;
}

export interface SplitPlan {
  /** New content for the original (parent) note — an index of links. */
  parentContent: string;
  sections: SectionPlan[];
}

/** Splits YAML frontmatter off — mirrors the copy in formatter.ts. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fm) return { frontmatter: '', body: content };
  return { frontmatter: fm[0], body: content.slice(fm[0].length) };
}

/** Sanitizes a folder name for use on disk: strips Windows-forbidden chars,
 *  trailing dots/spaces, and caps the length. Keeps the readable title.
 *  Falls back to `sections` when nothing usable remains. */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || 'sections';
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'section';
}

/**
 * Filesystem-safe note name derived from the H2 heading itself: keeps the
 * heading's readable text (spaces, case, punctuation that's filename-safe)
 * instead of lowercasing it into a slug. The resulting file is named exactly
 * after the section heading, e.g. `## My Great Section` → `My Great Section.md`.
 * Strips Windows-forbidden characters and trailing dots/spaces. Long
 * headings are preserved in full, trimmed at a word boundary only past the
 * 200-char filesystem safety net.
 */
function headingFileName(title: string): string {
  let cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  // 200 chars is a filesystem safety net only (255-char component limit);
  // otherwise the full heading is preserved. Trim at a word boundary so the
  // name is never cut mid-word.
  if (cleaned.length > 200) {
    cleaned = cleaned.slice(0, 200);
    const lastSpace = cleaned.lastIndexOf(' ');
    if (lastSpace > 0) cleaned = cleaned.slice(0, lastSpace);
    cleaned = cleaned.replace(/[. ]+$/g, '').trim();
  }
  return cleaned || slugify(title) || 'section';
}

/** Counts `##` headings (code-fence aware) — used to enable the Split button. */
export function countH2Headings(content: string): number {
  if (!content) return 0;
  let count = 0;
  let inFence = false;
  for (const line of content.split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+\S/.test(t)) count++;
  }
  return count;
}

/**
 * Plans splitting `content` by its `##` sections. Returns null when the note
 * has fewer than 2 `##` headings (nothing to split). `existingPaths` (full
 * absolute paths) is used to de-duplicate new filenames against the vault.
 */
export function planNoteSplit(
  content: string,
  parentTitle: string,
  existingPaths: string[]
): SplitPlan | null {
  const { frontmatter, body } = splitFrontmatter(content);
  const lines = body.split('\n');

  // Collect H2 heading line indexes (code-fence aware).
  const h2Indexes: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+\S/.test(t)) h2Indexes.push(i);
  }
  if (h2Indexes.length < 2) return null;

  // Existing note file names (basenames, lowercased) — new section files must
  // not shadow a note the vault already has.
  const existingNames = new Set(
    existingPaths.map((p) => (p.split(/[\\/]/).pop() ?? '').toLowerCase())
  );
  const usedNames = new Set<string>();
  const sections: SectionPlan[] = [];

  for (let s = 0; s < h2Indexes.length; s++) {
    const start = h2Indexes[s];
    const end = s + 1 < h2Indexes.length ? h2Indexes[s + 1] : lines.length;
    const headingText = lines[start]
      .trim()
      .replace(/^##\s+/, '')
      .replace(/\s*#+\s*$/, '')
      .trim();
    const title = headingText || `Section ${s + 1}`;

    // Unique filename: named after the H2 heading itself (readable, not
    // slugified), then de-duped against existing vault notes and earlier
    // sections in this split.
    let fileName = headingFileName(title);
    let candidate = fileName;
    let n = 2;
    while (
      usedNames.has(candidate.toLowerCase()) ||
      existingNames.has(`${candidate}.md`)
    ) {
      candidate = `${fileName}-${n++}`;
    }
    fileName = candidate;
    usedNames.add(fileName.toLowerCase());

    // Section body: everything after the heading until the next H2. Nested
    // H3+ content belongs to this section. The new note gets an H1 (the
    // section title) and a [[Parent]] back-link.
    const rest = lines.slice(start + 1, end).join('\n').trim();
    const sectionContent = `# ${title}\n\n[[${parentTitle}]]\n\n${rest}\n`.replace(/\n{3,}/g, '\n\n');
    sections.push({ title, fileName, content: sectionContent });
  }

  // Parent: frontmatter + intro (before the first H2) + a ## Sections index.
  const intro = lines.slice(0, h2Indexes[0]).join('\n').trim();
  const indexLinks = sections.map((s) => `- [[${s.title}]]`).join('\n');
  const parentBody = [intro, `## Sections`, indexLinks].filter(Boolean).join('\n\n');
  const parentContent = `${frontmatter}${parentBody}\n`;

  return { parentContent, sections };
}

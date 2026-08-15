import { NoteFile, WikiLink, GraphNode, GraphLink } from '../types';

/**
 * Parses the inner text of a wiki link (`[[...]]`) into its parts:
 * target note title, optional alias (after `|`), and optional block reference
 * (after `#`). A block reference can be a heading name (`#Heading`) or an
 * explicit block id (`#^my-id`).
 */
export function parseWikiLinkTarget(rawLinkContent: string): {
  targetTitle: string;
  alias?: string;
  blockId?: string;
} {
  const cleaned = rawLinkContent.trim();
  if (!cleaned) return { targetTitle: '' };

  const [withoutAlias, ...rest] = cleaned.split('|');
  const alias = rest.length > 0 ? rest.join('|').trim() : undefined;

  const hashIndex = withoutAlias.indexOf('#');
  const targetTitle = (hashIndex >= 0 ? withoutAlias.slice(0, hashIndex) : withoutAlias).trim();
  const blockId = hashIndex >= 0 ? withoutAlias.slice(hashIndex + 1).trim() : undefined;

  return { targetTitle, alias, blockId: blockId || undefined };
}

/**
 * Extracts all wiki links from a markdown string.
 * Example: [[My Note]], [[My Note|Custom Display Name]], [[My Note#^block-id]]
 */
export function extractWikiLinks(content: string): WikiLink[] {
  if (!content) return [];
  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const links: WikiLink[] = [];
  let match;

  while ((match = wikiLinkRegex.exec(content)) !== null) {
    const rawLinkContent = match[1];
    if (!rawLinkContent || !rawLinkContent.trim()) continue;

    const { targetTitle, alias, blockId } = parseWikiLinkTarget(rawLinkContent);
    if (!targetTitle) continue;

    links.push({
      targetTitle,
      alias,
      blockId,
      raw: match[0],
    });
  }

  return links;
}

/**
 * Splits markdown content into inline elements, separating text and wiki links.
 * Useful for rendering interactive markdown text in React without bringing in a heavy parser,
 * or for adding custom renderers on top of standard rendering.
 */
export interface ContentSegment {
  type: 'text' | 'wiki-link';
  content: string;
  target?: string;
  alias?: string;
  blockId?: string;
  exists?: boolean;
  /** Standard Markdown link pointing at an external URL (not a vault note). */
  external?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the 0-based line index of a block reference (`^id` marker or
 * heading name) inside a note's content, or null if it can't be found.
 * The machine-generated footer is ignored, and `^id` anchors that only appear
 * inside `[[...]]` link syntax (a reference, not the anchor itself) don't
 * count — otherwise jumping to a link could land on the link's own line.
 */
export function findBlockLine(content: string, blockId: string): number | null {
  if (!content) return null;
  const footerIdx = content.indexOf('<!-- LINKER_START -->');
  const body = footerIdx >= 0 ? content.slice(0, footerIdx) : content;
  const lines = body.split('\n');

  if (blockId.startsWith('^')) {
    const id = blockId.slice(1).toLowerCase();
    const re = new RegExp(`\\^\\s*${escapeRegExp(id)}\\b`, 'i');
    for (let i = 0; i < lines.length; i++) {
      const withoutLinks = lines[i].replace(/\[\[.*?\]\]/g, '');
      if (re.test(withoutLinks)) return i;
    }
    return null;
  }

  const target = blockId.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m && m[2].trim().toLowerCase() === target) return i;
  }
  return null;
}

/**
 * Parses the destination of a standard Markdown link (`[label](target)`):
 * resolves the note title (stripping a `.md` extension), extracts an optional
 * block/heading reference (after `#`), and flags external URLs.
 */
export function parseMarkdownLinkTarget(target: string): {
  targetTitle: string;
  blockId?: string;
  external?: boolean;
} {
  const cleaned = target.trim();
  if (!cleaned) return { targetTitle: '', external: true };

  if (/^(https?:\/\/|www\.|mailto:|ftp:)/i.test(cleaned)) {
    return { targetTitle: cleaned, external: true };
  }

  const hashIndex = cleaned.indexOf('#');
  const rawTitle = (hashIndex >= 0 ? cleaned.slice(0, hashIndex) : cleaned)
    .replace(/\.md$/i, '')
    .trim();
  const blockId = hashIndex >= 0 ? cleaned.slice(hashIndex + 1).trim() : undefined;

  return { targetTitle: rawTitle, blockId: blockId || undefined };
}

/**
 * Finds a wiki or standard Markdown link whose character range (0-based
 * offsets into `text`) contains `offset`. Used by the CodeMirror click
 * handler to resolve what link was clicked in the editor.
 */
export function findLinkAtOffset(
  text: string,
  offset: number
): { targetTitle: string; blockId?: string; external?: boolean } | null {
  const linkRegex = /\[\[(.*?)\]\]|\[([^\]]+)\]\(([^)]*)\)/g;
  let m;
  while ((m = linkRegex.exec(text)) !== null) {
    if (offset >= m.index && offset < m.index + m[0].length) {
      if (m[1] !== undefined) {
        const { targetTitle, blockId } = parseWikiLinkTarget(m[1]);
        return { targetTitle, blockId };
      }
      const { targetTitle, blockId, external } = parseMarkdownLinkTarget(m[3] ?? '');
      return { targetTitle, blockId, external };
    }
  }
  return null;
}

export function segmentContent(content: string, existingTitles: string[]): ContentSegment[] {
  if (!content) return [];

  // Matches [[wiki links]] as well as standard [markdown links](targets).
  const linkRegex = /\[\[(.*?)\]\]|\[([^\]]+)\]\(([^)]*)\)/g;
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  let match;

  const existingTitlesLower = existingTitles.map((t) => t.toLowerCase());

  while ((match = linkRegex.exec(content)) !== null) {
    const matchIndex = match.index;

    // Add preceding text segment if any
    if (matchIndex > lastIndex) {
      segments.push({
        type: 'text',
        content: content.substring(lastIndex, matchIndex),
      });
    }

    if (match[1] !== undefined) {
      const { targetTitle, alias, blockId } = parseWikiLinkTarget(match[1]);
      const exists = existingTitlesLower.includes(targetTitle.toLowerCase());

      segments.push({
        type: 'wiki-link',
        content: match[0],
        target: targetTitle,
        alias: alias,
        blockId,
        exists: exists,
      });
    } else {
      // Standard Markdown link: [label](target)
      const label = match[2];
      const { targetTitle, blockId, external } = parseMarkdownLinkTarget(match[3] ?? '');
      const exists = !external && existingTitlesLower.includes(targetTitle.toLowerCase());

      segments.push({
        type: 'wiki-link',
        content: match[0],
        target: targetTitle,
        alias: label,
        blockId,
        exists: exists,
        external: external,
      });
    }

    lastIndex = linkRegex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.substring(lastIndex),
    });
  }

  return segments;
}

/**
 * Builds nodes and links for the D3 force-directed graph.
 * Discovers existing files and linked files (even if they don't exist yet).
 */
export function buildGraphData(notes: NoteFile[]): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodeMap = new Map<string, { id: string; title: string; exists: boolean; linksCount: number }>();
  const linkSet = new Set<string>();
  const links: GraphLink[] = [];

  // 1. Initialize all existing notes
  for (const note of notes) {
    nodeMap.set(note.title.toLowerCase(), {
      id: note.title,
      title: note.title,
      exists: true,
      linksCount: 0,
    });
  }

  // 2. Discover links and missing nodes
  for (const note of notes) {
    const noteTitleLower = note.title.toLowerCase();
    const wikiLinks = extractWikiLinks(note.content ?? '');

    for (const link of wikiLinks) {
      const targetTitleLower = link.targetTitle.toLowerCase();
      
      // Self-links can be skipped or shown
      if (targetTitleLower === noteTitleLower) continue;

      // Add missing target note to nodeMap as uncreated
      if (!nodeMap.has(targetTitleLower)) {
        nodeMap.set(targetTitleLower, {
          id: link.targetTitle, // preserve original casing
          title: link.targetTitle,
          exists: false,
          linksCount: 0,
        });
      }

      const sourceNode = nodeMap.get(noteTitleLower);
      const targetNode = nodeMap.get(targetTitleLower);

      if (sourceNode && targetNode) {
        // Prevent duplicate undirected links or identical directed links
        const linkKey = `${sourceNode.id} -> ${targetNode.id}`;
        const reverseLinkKey = `${targetNode.id} -> ${sourceNode.id}`;

        if (!linkSet.has(linkKey) && !linkSet.has(reverseLinkKey)) {
          linkSet.add(linkKey);
          links.push({
            source: sourceNode.id,
            target: targetNode.id,
          });

          // Increment links count for weighting size
          sourceNode.linksCount += 1;
          targetNode.linksCount += 1;
        }
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    links,
  };
}

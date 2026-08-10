import { NoteFile, WikiLink, GraphNode, GraphLink } from '../types';

/**
 * Extracts all wiki links from a markdown string.
 * Example: [[My Note]] or [[My Note|Custom Display Name]]
 */
export function extractWikiLinks(content: string): WikiLink[] {
  if (!content) return [];
  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const links: WikiLink[] = [];
  let match;

  while ((match = wikiLinkRegex.exec(content)) !== null) {
    const rawLinkContent = match[1];
    if (!rawLinkContent || !rawLinkContent.trim()) continue;

    const parts = rawLinkContent.split('|');
    const targetTitle = parts[0].trim();
    const alias = parts.length > 1 ? parts[1].trim() : undefined;

    // Avoid duplicates within the same extraction context or handle cleanly
    links.push({
      targetTitle,
      alias,
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
  exists?: boolean;
}

export function segmentContent(content: string, existingTitles: string[]): ContentSegment[] {
  if (!content) return [];

  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  let match;

  const existingTitlesLower = existingTitles.map((t) => t.toLowerCase());

  while ((match = wikiLinkRegex.exec(content)) !== null) {
    const matchIndex = match.index;

    // Add preceding text segment if any
    if (matchIndex > lastIndex) {
      segments.push({
        type: 'text',
        content: content.substring(lastIndex, matchIndex),
      });
    }

    const rawLinkContent = match[1];
    const parts = rawLinkContent.split('|');
    const targetTitle = parts[0].trim();
    const alias = parts.length > 1 ? parts[1].trim() : undefined;
    const exists = existingTitlesLower.includes(targetTitle.toLowerCase());

    segments.push({
      type: 'wiki-link',
      content: match[0],
      target: targetTitle,
      alias: alias,
      exists: exists,
    });

    lastIndex = wikiLinkRegex.lastIndex;
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
    const wikiLinks = extractWikiLinks(note.content);

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

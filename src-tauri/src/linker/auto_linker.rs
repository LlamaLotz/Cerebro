use aho_corasick::{AhoCorasick, MatchKind};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkMention {
    pub target_note_id: String,
    pub matched_text: String,
    pub start: usize,
    pub end: usize,
}

/// Common English words that would match incidentally inside nearly every note
/// ("The", "In", "Part") and are almost never meant as link targets. Titles
/// made of these (or single characters) are dropped from the mention
/// dictionary so the Linker suggests real subjects, not noise.
const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do",
    "does", "for", "from", "had", "has", "have", "he", "her", "his", "how", "i",
    "if", "in", "is", "it", "its", "may", "me", "might", "must", "my", "no", "not",
    "of", "on", "one", "or", "our", "out", "over", "she", "so", "some", "that",
    "the", "their", "them", "then", "there", "these", "they", "this", "those", "to",
    "too", "under", "up", "us", "was", "we", "were", "what", "when", "where",
    "which", "who", "why", "will", "with", "would", "you", "your",
];

/// True when a title/alias is worth matching as a link target: not empty, not a
/// single character, and not a common English stop word.
fn is_linkworthy(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() <= 1 {
        return false;
    }
    let lower = t.to_lowercase();
    !STOP_WORDS.contains(&lower.as_str())
}

/// Hard cap on the number of mentions returned per note. A multi-MB imported
/// note can mention hundreds of dictionary titles thousands of times; nobody
/// reviews more than a few hundred suggestions, and every extra mention burns
/// IPC payload, backlink rows and UI. The first matches are the most relevant.
pub const MAX_MENTIONS_PER_NOTE: usize = 500;

pub struct NoteLinker {
    ac: AhoCorasick,
    dictionary: Vec<(String, String)>, // (id, text)
}

impl NoteLinker {
    pub fn new(dictionary: Vec<(String, String)>) -> Self {
        // Drop low-information titles/aliases BEFORE building the automaton so
        // the pattern list and dictionary stay index-aligned.
        let dictionary: Vec<(String, String)> = dictionary
            .into_iter()
            .filter(|(_, text)| is_linkworthy(text))
            .collect();
        let patterns: Vec<String> = dictionary.iter().map(|(_, text)| text.clone()).collect();
        let ac = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(patterns)
            .expect("Failed to build Aho-Corasick automaton");

        Self { ac, dictionary }
    }

    pub fn find_mentions(&self, content: &str, current_note_id: Option<&str>) -> Vec<LinkMention> {
        let ignored_ranges = merge_ranges(extract_ignored_ranges(content));
        let mut mentions = Vec::new();

        for mat in self.ac.find_iter(content) {
            if mentions.len() >= MAX_MENTIONS_PER_NOTE {
                break;
            }
            let start = mat.start();
            let end = mat.end();
            let matched_text = &content[start..end];
            let target_note_id = &self.dictionary[mat.pattern()].0;

            // 0. "@Topic" keywords are topic groups (e.g. @Astrology, @Math),
            //    never unlinked mentions — skip any match preceded by '@'.
            if start > 0 && content.as_bytes()[start - 1] == b'@' {
                continue;
            }

            // 1. Skip self-referential links
            if let Some(curr_id) = current_note_id {
                if target_note_id == curr_id {
                    continue;
                }
            }

            // 2. Skip matches overlapping an ignored range (headings, URLs,
            //    code, existing links…). Binary search over the merged,
            //    non-overlapping ranges — O(log R) per match, not O(R).
            if overlaps_ignored(&ignored_ranges, start, end) {
                continue;
            }

            // 3. Word Boundary guard
            if !is_word_boundary(content, start, end) {
                continue;
            }

            mentions.push(LinkMention {
                target_note_id: target_note_id.clone(),
                matched_text: matched_text.to_string(),
                start,
                end,
            });
        }

        mentions
    }
}

/// Sorts ranges by start and merges overlaps, so overlap tests can binary
/// search instead of scanning every range per match (big notes have hundreds
/// of headings/links/code spans).
fn merge_ranges(mut ranges: Vec<TextRange>) -> Vec<TextRange> {
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<TextRange> = Vec::with_capacity(ranges.len());
    for r in ranges {
        if let Some(last) = merged.last_mut() {
            if r.start <= last.end {
                if r.end > last.end {
                    last.end = r.end;
                }
                continue;
            }
        }
        merged.push(r);
    }
    merged
}

/// True when [start, end) overlaps any merged ignored range. With non-overlapping
/// sorted ranges, only the range before and after `start` can overlap the match.
fn overlaps_ignored(ranges: &[TextRange], start: usize, end: usize) -> bool {
    let idx = ranges.partition_point(|r| r.start <= start);
    for &r in [idx.checked_sub(1), Some(idx)].iter().flatten() {
        if let Some(range) = ranges.get(r) {
            if start < range.end && end > range.start {
                return true;
            }
        }
    }
    false
}

pub fn extract_ignored_ranges(content: &str) -> Vec<TextRange> {
    let mut ranges = Vec::new();
    
    // YAML frontmatter
    let re_yaml = Regex::new(r"(?m)^---[\s\S]*?---").unwrap();
    for mat in re_yaml.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Fenced code blocks
    let re_code_block = Regex::new(r"(?m)^```[\s\S]*?```").unwrap();
    for mat in re_code_block.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Inline code
    let re_inline_code = Regex::new(r"`[^`\n]+`").unwrap();
    for mat in re_inline_code.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Existing wikilinks [[...]]
    let re_wikilinks = Regex::new(r"\[\[[^\]]*\]\]").unwrap();
    for mat in re_wikilinks.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Machine-generated linker footer (approved links written by atomic_write)
    let re_linker_footer = Regex::new(r"<!--\s*LINKER_START\s*-->[\s\S]*?(?:<!--\s*LINKER_END\s*-->|$)").unwrap();
    for mat in re_linker_footer.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Markdown headings (a title matching inside a heading is already
    // navigational context, not an unlinked mention worth suggesting)
    let re_headings = Regex::new(r"(?m)^#{1,6}\s.*$").unwrap();
    for mat in re_headings.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Markdown links [text](url) — external links, never link targets
    let re_md_links = Regex::new(r"\[[^\]]*\]\([^)]*\)").unwrap();
    for mat in re_md_links.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // Bare URLs
    let re_urls = Regex::new(r"https?://[^\s)\]<>]+").unwrap();
    for mat in re_urls.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    // HTML comments
    let re_html_comments = Regex::new(r"<!--[\s\S]*?-->").unwrap();
    for mat in re_html_comments.find_iter(content) {
        ranges.push(TextRange { start: mat.start(), end: mat.end() });
    }

    ranges
}

fn is_word_boundary(content: &str, start: usize, end: usize) -> bool {
    let bytes = content.as_bytes();
    // `_` counts as a word character: `my_note` must NOT match the title `note`.
    let is_word_char = |b: u8| b.is_ascii_alphanumeric() || b == b'_';

    // Check preceding character
    if start > 0 {
        if is_word_char(bytes[start - 1]) {
            return false;
        }
    }

    // Check succeeding character
    if end < bytes.len() {
        if is_word_char(bytes[end]) {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mentions(content: &str, dict: Vec<(&str, &str)>) -> Vec<String> {
        let dictionary: Vec<(String, String)> = dict
            .into_iter()
            .map(|(id, text)| (id.to_string(), text.to_string()))
            .collect();
        let linker = NoteLinker::new(dictionary);
        linker
            .find_mentions(content, None)
            .into_iter()
            .map(|m| m.matched_text)
            .collect()
    }

    #[test]
    fn stop_words_are_not_matched() {
        // "The" is a stop word — only "Astrology" should match.
        let found = mentions("The stars and Astrology", vec![("1", "The"), ("2", "Astrology")]);
        assert_eq!(found, vec!["Astrology"]);
    }

    #[test]
    fn underscore_is_a_word_char() {
        // `my_note` must not match the title `note`; the standalone one does.
        let found = mentions("my_note and note", vec![("1", "note")]);
        assert_eq!(found, vec!["note"]);
    }

    #[test]
    fn headings_urls_and_md_links_are_ignored() {
        let content = "# Astrology\nSee Astrology here and https://x.com/Astrology plus [Astrology](https://x.com).";
        let found = mentions(content, vec![("1", "Astrology")]);
        // Only the plain-text occurrence matches (heading, URL and link are ignored).
        assert_eq!(found, vec!["Astrology"]);
    }

    #[test]
    fn big_note_scan_bounded() {
        // Rough proxy for a multi-MB imported note: many paragraphs mentioning
        // a handful of dictionary titles. Guards against accidental quadratic
        // blowups in the mention scan.
        let mut text = String::with_capacity(4 * 1024 * 1024);
        for i in 0..40_000 {
            text.push_str("Astrology and Mathematics are linked by the ancient Greeks. ");
            text.push_str(&format!("Paragraph {} ends here.\n", i));
        }
        let dictionary: Vec<(String, String)> = vec![
            ("1".to_string(), "Astrology".to_string()),
            ("2".to_string(), "Mathematics".to_string()),
            ("3".to_string(), "Ancient Greeks".to_string()),
        ];
        let linker = NoteLinker::new(dictionary);
        let start = std::time::Instant::now();
        let found = linker.find_mentions(&text, None);
        let elapsed = start.elapsed();
        println!("big-note: {} MB, {} mentions, {:.2}s", text.len() / 1048576, found.len(), elapsed.as_secs_f64());
        assert!(elapsed.as_secs_f64() < 10.0, "scan took {elapsed:?}");
        // The hard cap bounds giant notes instead of returning 80k+ mentions.
        assert_eq!(found.len(), MAX_MENTIONS_PER_NOTE);
    }

    #[test]
    fn self_links_are_excluded() {
        let dictionary: Vec<(String, String)> = vec![
            ("self".to_string(), "Astrology".to_string()),
            ("other".to_string(), "Math".to_string()),
        ];
        let linker = NoteLinker::new(dictionary);
        let found: Vec<String> = linker
            .find_mentions("Astrology and Math", Some("self"))
            .into_iter()
            .map(|m| m.matched_text)
            .collect();
        assert_eq!(found, vec!["Math"]);
    }
}

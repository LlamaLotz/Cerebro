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

pub struct NoteLinker {
    ac: AhoCorasick,
    dictionary: Vec<(String, String)>, // (id, text)
}

impl NoteLinker {
    pub fn new(dictionary: Vec<(String, String)>) -> Self {
        let patterns: Vec<String> = dictionary.iter().map(|(_, text)| text.clone()).collect();
        let ac = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(patterns)
            .expect("Failed to build Aho-Corasick automaton");

        Self { ac, dictionary }
    }

    pub fn find_mentions(&self, content: &str, current_note_id: Option<&str>) -> Vec<LinkMention> {
        let ignored_ranges = extract_ignored_ranges(content);
        let mut mentions = Vec::new();

        for mat in self.ac.find_iter(content) {
            let start = mat.start();
            let end = mat.end();
            let matched_text = &content[start..end];
            let target_note_id = &self.dictionary[mat.pattern()].0;

            // 1. Skip self-referential links
            if let Some(curr_id) = current_note_id {
                if target_note_id == curr_id {
                    continue;
                }
            }

            // 2. Skip matches in ignored ranges
            if ignored_ranges.iter().any(|range| {
                (start >= range.start && start < range.end) || (end > range.start && end <= range.end)
            }) {
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

    ranges
}

fn is_word_boundary(content: &str, start: usize, end: usize) -> bool {
    let bytes = content.as_bytes();
    
    // Check preceding character
    if start > 0 {
        let prev_char = bytes[start - 1] as char;
        if prev_char.is_alphanumeric() {
            return false;
        }
    }

    // Check succeeding character
    if end < bytes.len() {
        let next_char = bytes[end] as char;
        if next_char.is_alphanumeric() {
            return false;
        }
    }

    true
}

use regex::Regex;

/// True when a line is publication layout junk that repeats on every page of
/// an InDesign/PDF export: standalone page numbers, dates, `.indd` identifiers
/// and garbled diacritic-symbol rows (e.g. `ÊˆÌœÛ`).
fn is_junk_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    // Adobe InDesign / export identifiers
    if t.contains(".indd") || t.contains("InDesign") {
        return true;
    }
    // Standalone page numbers: "12", "Page 12", "pg. 12", "- 5 -", "12 of 34"
    let page_num = Regex::new(r"(?i)^(?:p(?:age|g)?\.?\s*|[-–—]\s*)?\d{1,4}(?:\s*[-–—])?(?:\s+of\s+\d{1,4})?$").unwrap();
    if page_num.is_match(t) {
        return true;
    }
    // Standalone dates: "12/03/2024", "2024-12-03", "Dec 3, 2024", "December 3, 2024"
    let date = Regex::new(
        r"(?i)^(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4})$",
    )
    .unwrap();
    if date.is_match(t) {
        return true;
    }
    // Garbled diacritic symbol rows (ÊˆÌœÛ …): no ASCII letters/digits but
    // contains non-ASCII alphabetic characters — pure OCR/layout noise.
    let has_ascii = t.chars().any(|c| c.is_ascii_alphabetic() || c.is_ascii_digit());
    if !has_ascii && t.chars().any(|c| c.is_alphabetic()) {
        return true;
    }
    false
}

/// True when a line starts a markdown element that must never be joined into
/// the previous paragraph (headings, lists, quotes, tables, rules, code).
fn is_markdown_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('#')
        || t.starts_with("```")
        || t.starts_with('`')
        || t.starts_with("- ")
        || t.starts_with("* ")
        || t.starts_with("+ ")
        || t.starts_with('>')
        || t.starts_with('|')
        || t.starts_with("---")
        || t.starts_with("***")
        || t.starts_with("___")
        || t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        || t.starts_with("![")
}

pub fn format_note_content(raw_text: &str) -> String {
    if raw_text.is_empty() {
        return String::new();
    }

    // 1. Character & OCR Cleanup
    // Normalize tab characters to 2 spaces
    let mut cleaned = raw_text.replace('\t', "  ");

    // Remove unprintable ASCII control characters [\x00-\x08\x0B\x0C\x0E-\x1F],
    // replacement characters \uFFFD, zero-width spaces \u200B and BOM \uFEFF.
    cleaned = cleaned
        .chars()
        .filter(|&c| {
            let val = c as u32;
            !(val <= 0x08
                || val == 0x0B
                || val == 0x0C
                || (0x0E..=0x1F).contains(&val)
                || val == 0xFFFD
                || val == 0x200B
                || val == 0xFEFF)
        })
        .collect();

    // Fix broken quote marks (smart quotes)
    cleaned = cleaned
        .replace(['“', '”', '„', '‟', '«', '»'], "\"")
        .replace(['‘', '’', '‚', '‛'], "'");

    // 2. Heading Normalization (preserving code fences)
    let re = Regex::new(r"^(#{1,6})(?:\s*#+)*\s*(.*)$").unwrap();
    let mut in_code_fence = false;
    let mut processed_lines = Vec::new();

    // Split raw text into lines. We handle both \r\n and \n by standardizing to \n later.
    for line in cleaned.lines() {
        let trimmed_end = line.trim_end();

        // Track code fence
        if trimmed_end.trim_start().starts_with("```") {
            in_code_fence = !in_code_fence;
            processed_lines.push(trimmed_end.to_string());
            continue;
        }

        if in_code_fence {
            processed_lines.push(trimmed_end.to_string());
            continue;
        }

        let trimmed_start = trimmed_end.trim_start();
        let leading_spaces_count = trimmed_end.len() - trimmed_start.len();

        if trimmed_start.starts_with('#') && leading_spaces_count < 4 {
            if let Some(caps) = re.captures(trimmed_start) {
                let hashes = &caps[1];
                let content = caps[2].trim();
                if content.is_empty() {
                    processed_lines.push(hashes.to_string());
                } else {
                    processed_lines.push(format!("{} {}", hashes, content));
                }
            } else {
                processed_lines.push(trimmed_end.to_string());
            }
        } else {
            processed_lines.push(trimmed_end.to_string());
        }
    }

    // 3. Junk line removal: page numbers, dates, .indd identifiers and garbled
    // diacritic rows that PDF/InDesign exports sprinkle between paragraphs.
    processed_lines.retain(|l| !is_junk_line(l));

    // 4. Smart Line Joining (PDF/OCR repair): adjacent plain-text lines that
    // belong to the same paragraph get merged. Joining happens when the
    // previous line does NOT end with sentence punctuation (. ! ? : ;) and the
    // next line starts with lowercase text and is NOT a markdown element.
    let mut joined: Vec<String> = Vec::new();
    let mut fence = false;
    for line in processed_lines {
        if line.trim_start().starts_with("```") {
            fence = !fence;
            joined.push(line);
            continue;
        }
        if fence {
            joined.push(line);
            continue;
        }
        let can_join = if let Some(prev) = joined.last() {
            !prev.is_empty()
                && !is_markdown_line(prev)
                && !is_markdown_line(&line)
                && !prev
                    .trim_end()
                    .ends_with(['.', '!', '?', ':', ';'])
                && line
                    .trim_start()
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_lowercase())
                    .unwrap_or(false)
        } else {
            false
        };
        if can_join {
            let prev = joined.pop().unwrap();
            joined.push(format!("{} {}", prev.trim_end(), line.trim_start()));
        } else {
            joined.push(line);
        }
    }

    // 5. Whitespace Normalization (Collapse 3 or more consecutive blank lines to 2 newlines / 1 blank line)
    let mut final_lines = Vec::new();
    let mut i = 0;
    while i < joined.len() {
        if joined[i].is_empty() {
            let mut j = i;
            while j < joined.len() && joined[j].is_empty() {
                j += 1;
            }
            let count = j - i;
            if count >= 3 {
                final_lines.push(String::new());
            } else {
                for _ in 0..count {
                    final_lines.push(String::new());
                }
            }
            i = j;
        } else {
            final_lines.push(joined[i].clone());
            i += 1;
        }
    }

    let mut result = final_lines.join("\n");
    if !result.is_empty() && raw_text.ends_with('\n') {
        result.push('\n');
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_character_cleanup() {
        let input = "Hello\u{0007} World!\u{FFFD} Smart “quotes” and ‘single’ quotes. \tTabbed.";
        let expected = "Hello World! Smart \"quotes\" and 'single' quotes.   Tabbed.";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_heading_normalization() {
        let input = "###Header\n## # Title\n### ## Subtitle\n  ##   Indented\n#\n```\n# Verbatim inside code\n```";
        let expected = "### Header\n## Title\n### Subtitle\n## Indented\n#\n```\n# Verbatim inside code\n```";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_whitespace_normalization() {
        let input = "Line 1\n\n\n\nLine 2\nLine 3 \n\nLine 4";
        // 4 consecutive newlines (3 empty lines) collapses to 1 empty line (2 newlines)
        let expected = "Line 1\n\nLine 2\nLine 3\n\nLine 4";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_invisible_character_stripping() {
        let input = "A\u{200B}B\u{FEFF}C";
        let expected = "ABC";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_junk_line_removal() {
        let input = "Real paragraph start.\n12\nPage 3\nDecember 3, 2024\nÊˆÌœÛ\nNext paragraph.";
        let expected = "Real paragraph start.\nNext paragraph.";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_smart_line_joining() {
        let input = "The quick brown fox jumps over\nthe lazy dog. It ends properly.\nAnd this\nstarts fresh.";
        // Lines 1+2 join (no sentence punctuation, next starts lowercase);
        // "the lazy dog." ends with "." so line 4 stays separate from 3?
        // No — line 3 ("And this") has no ending punctuation and line 4 starts
        // lowercase, so they join too.
        let expected = "The quick brown fox jumps over the lazy dog. It ends properly.\nAnd this starts fresh.";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_no_join_across_markdown() {
        let input = "Paragraph text\n- list item\nmore text\n# Heading\nbody text";
        let expected = "Paragraph text\n- list item\nmore text\n# Heading\nbody text";
        assert_eq!(format_note_content(input), expected);
    }
}

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

/// Drops stray `Â` (U+00C2) / `Ã` (U+00C3) markers — double-encoding debris
/// that survives the mojibake table above. Kept when followed by a Latin-1
/// symbol/letter (`\u{a0}..=\u{ff}`, i.e. a potentially unmapped pair);
/// dropped otherwise (followed by ASCII, control, or end of line).
fn strip_stray_markers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        let keep = match c {
            '\u{c2}' | '\u{c3}' => match chars.peek().copied() {
                Some(n) => ('\u{a0}'..='\u{ff}').contains(&n),
                None => false,
            },
            _ => true,
        };
        if keep {
            out.push(c);
        }
    }
    out
}

/// Capitalizes the first letter of every word ("the dark forest" -> "The Dark Forest").
fn title_case(text: &str) -> String {
    text.split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => {
                    let mut s = String::with_capacity(w.len());
                    s.push(first.to_uppercase().next().unwrap_or(first));
                    s.push_str(&w[first.len_utf8()..].to_lowercase());
                    s
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Detects plain-text lines that are really chapter/section titles (from PDF,
/// OCR or Word exports where headings weren't written as markdown) and returns
/// them as `## Heading` lines. Runs BEFORE junk removal and smart line-joining,
/// so detected headings are protected from being merged into the paragraph
/// below. Never fires inside code fences.
///
/// Signals, all must agree:
///  - explicit markers: `Chapter 3`, `CHAPTER ONE: Title`, `Part II`, `Section 3.2`
///  - numbered sections: `1. Introduction`, `3.2 Results` (number stripped) —
///    unless the next line is numbered too, which means it's a list, not a title
///  - ALL-CAPS title lines (`THE BEGINNING`, `PART ONE`) with >= 3 words
///  - short Title-Case lines isolated by blank lines on both sides
/// Vetoes: ends with sentence punctuation, markdown/list starts, > 100 chars,
/// and marker lines whose trailing text starts lowercase ("Chapter 1 covers…"
/// is a sentence, not a heading).
fn detect_section_headings(lines: &[String]) -> Vec<String> {
    let marker_re = Regex::new(
        r"(?i)^(chapter|ch\.?|section|sec\.?|part|lesson|module|unit|appendix)\s+(\d+(?:\.\d+)*|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b(?:\s*[:.\-–—]\s*|\s+)?(.*)$",
    )
    .unwrap();
    let numbered_re = Regex::new(r#"^(\d+(?:\.\d+)*)[.)]?\s+([A-Z0-9"“][^.!?]{1,80})$"#).unwrap();
    let caps_re = Regex::new(r"^[A-Z0-9][A-Z0-9 &'’\-–—,/:()]{3,58}$").unwrap();
    let titlecase_re = Regex::new(r"^[A-Z][A-Za-z0-9'’\- ]{2,59}$").unwrap();
    let next_list_re = Regex::new(r"^[-*+>|]|^\d+[.)]").unwrap();
    let markdown_start_re = Regex::new(r"^[-*+>|]").unwrap();

    let mut out = Vec::with_capacity(lines.len());
    let mut in_fence = false;
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            out.push(line.clone());
            continue;
        }
        if in_fence || trimmed.starts_with('#') {
            out.push(line.clone());
            continue;
        }

        let prev_empty = i == 0 || lines[i - 1].trim().is_empty();
        let prev_line = if i > 0 { lines[i - 1].trim() } else { "" };
        let next = lines.get(i + 1).map(|l| l.trim()).unwrap_or("");
        let next_empty = next.is_empty();
        let next_list_like = next_list_re.is_match(next);
        let prev_list_like = next_list_re.is_match(prev_line);
        let mut heading: Option<String> = None;

        if !trimmed.is_empty()
            && trimmed.chars().count() <= 100
            && !trimmed.ends_with(['.', '!', '?'])
        {
            if let Some(caps) = marker_re.captures(trimmed) {
                let rest = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
                // Sentence veto: "Chapter 1 covers the basics" is prose.
                let rest_ok = rest.is_empty()
                    || rest.starts_with(|c: char| {
                        c.is_ascii_uppercase() || c.is_ascii_digit() || c == '"' || c == '“'
                    });
                if rest_ok {
                    let clean = trimmed.trim_end_matches(|c: char| {
                        c.is_whitespace() || matches!(c, '.' | ':' | '-' | '–' | '—')
                    });
                    // Normalize marker + number case: `CHAPTER TWO` -> `Chapter Two`,
                    // but keep roman numerals (`Part II`) and mixed case intact.
                    let mut words = clean.split_whitespace();
                    let w1 = words.next().unwrap_or("");
                    let w2 = words.next().unwrap_or("");
                    let rest: Vec<&str> = words.collect();
                    let cap_word = |w: &str| -> String {
                        let mut chars = w.chars();
                        match chars.next() {
                            Some(f) => format!("{}{}", f.to_uppercase(), w[f.len_utf8()..].to_lowercase()),
                            None => String::new(),
                        }
                    };
                    let is_roman = |w: &str| -> bool {
                        !w.is_empty()
                            && w.chars().all(|c| matches!(c.to_ascii_lowercase(), 'i' | 'v' | 'x' | 'l' | 'c' | 'd' | 'm'))
                    };
                    let w2_capped = if !w2.is_empty()
                        && w2.chars().any(|c| c.is_alphabetic())
                        && w2.chars().all(|c| !c.is_alphabetic() || c.is_uppercase())
                        && !is_roman(w2)
                    {
                        title_case(w2)
                    } else {
                        w2.to_string()
                    };
                    let mut parts = vec![cap_word(w1), w2_capped];
                    parts.extend(rest.iter().map(|s| s.to_string()));
                    heading = Some(format!("## {}", parts.join(" ")));
                }
            } else if !next_list_like && !prev_list_like && !markdown_start_re.is_match(trimmed) {
                if let Some(caps) = numbered_re.captures(trimmed) {
                    heading = Some(format!("## {}", caps[2].trim()));
                } else if caps_re.is_match(trimmed) && trimmed.chars().any(|c| c.is_ascii_uppercase()) {
                    if trimmed.split_whitespace().count() >= 3 {
                        heading = Some(format!("## {}", title_case(trimmed)));
                    }
                } else if prev_empty
                    && next_empty
                    && trimmed.chars().count() <= 60
                    && titlecase_re.is_match(trimmed)
                    && trimmed.split_whitespace().count() >= 2
                {
                    heading = Some(format!("## {}", trimmed));
                }
            }
        }
        out.push(heading.unwrap_or_else(|| line.clone()));
    }
    out
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

    // Mojibake repair: undo double-encoded UTF-8/CP1252 sequences (common in
    // PDF/Word exports). Specific sequences first, stray markers last — order
    // matters (e.g. `Ã©` -> `é` must run before stray `Ã` is stripped).
    cleaned = cleaned
        .replace("\u{e2}\u{20ac}\u{2122}", "'") // â€™ -> ' (U+2019)
        .replace("\u{e2}\u{20ac}\u{2dc}", "'") // â€˜ -> ' (U+2018)
        .replace("\u{e2}\u{20ac}\u{153}", "\"") // â€œ -> " (U+201C)
        .replace("\u{e2}\u{20ac}\u{9d}", "\"") // â€<0x9D> -> " (U+201D)
        .replace("\u{e2}\u{20ac}\u{161}", "'") // â€š -> ' (U+201A)
        .replace("\u{e2}\u{20ac}\u{2013}", "\u{2013}") // â€“ -> – (U+2013)
        .replace("\u{e2}\u{20ac}\u{2014}", "\u{2014}") // â€” -> — (U+2014)
        .replace("\u{e2}\u{20ac}\u{2026}", "\u{2026}") // â€¦ -> … (U+2026)
        .replace("\u{e2}\u{20ac}\u{a2}", "\u{2022}") // â€¢ -> • (U+2022)
        .replace("\u{c3}\u{a9}", "\u{e9}") // Ã© -> é
        .replace("\u{c3}\u{a8}", "\u{e8}") // Ã¨ -> è
        .replace("\u{c3}\u{aa}", "\u{ea}") // Ãª -> ê
        .replace("\u{c3}\u{ab}", "\u{eb}") // Ã« -> ë
        .replace("\u{c3}\u{a2}", "\u{e2}") // Ã¢ -> â
        .replace("\u{c3}\u{a4}", "\u{e4}") // Ã¤ -> ä
        .replace("\u{c3}\u{a3}", "\u{e3}") // Ã£ -> ã
        .replace("\u{c3}\u{a5}", "\u{e5}") // Ã¥ -> å
        .replace("\u{c3}\u{a7}", "\u{e7}") // Ã§ -> ç
        .replace("\u{c3}\u{ae}", "\u{ee}") // Ã® -> î
        .replace("\u{c3}\u{af}", "\u{ef}") // Ã¯ -> ï
        .replace("\u{c3}\u{b4}", "\u{f4}") // Ã´ -> ô
        .replace("\u{c3}\u{b6}", "\u{f6}") // Ã¶ -> ö
        .replace("\u{c3}\u{b5}", "\u{f5}") // Ãµ -> õ
        .replace("\u{c3}\u{b9}", "\u{f9}") // Ã¹ -> ù
        .replace("\u{c3}\u{bc}", "\u{fc}") // Ã¼ -> ü
        .replace("\u{c3}\u{bb}", "\u{fb}") // Ã» -> û
        .replace("\u{c3}\u{b1}", "\u{f1}") // Ã± -> ñ
        .replace("\u{c3}\u{89}", "\u{c9}") // Ã‰ -> É
        .replace("\u{c3}\u{9c}", "\u{dc}") // Ãœ -> Ü
        .replace("\u{c3}\u{9f}", "\u{df}") // ÃŸ -> ß
        .replace("\u{c3}\u{a6}", "\u{e6}") // Ã¦ -> æ
        .replace("\u{c3}\u{b8}", "\u{f8}") // Ã¸ -> ø
        .replace("\u{c3}\u{b0}", "\u{f0}") // Ã° -> ð
        .replace("\u{c3}\u{be}", "\u{fe}") // Ã¾ -> þ
        .replace("\u{c2}\u{a3}", "\u{a3}") // Â£ -> £
        ;
    // Stray `Â`/`Ã` that aren't part of a (mapped or unmapped) pair. Kept
    // when followed by a Latin-1 symbol/letter (potentially an unmapped pair);
    // dropped when followed by anything else or at end-of-line. (The regex
    // crate has no look-around, so this walks the chars instead.)
    cleaned = strip_stray_markers(&cleaned);

    // Final garbage pass: drop remaining C1 control chars, private-use
    // characters and stray zero-width/BOM marks that the explicit rules didn't
    // catch (the regex crate lacks a `\p{Co}` property, so walk the chars).
    cleaned = cleaned
        .chars()
        .filter(|&c| {
            let val = c as u32;
            !((0x80..=0x9F).contains(&val)
                || (0xE000..=0xF8FF).contains(&val)
                || val == 0x200B
                || val == 0xFEFF)
        })
        .collect();

    // 2. Heading Normalization (preserving code fences)
    // Only collapse hash-runs that are followed by whitespace, so
    // `## # Title` -> `## Title` but `# Section #1` keeps its trailing `#1`.
    let re = Regex::new(r"^(#{1,6})(?:\s*#+\s+)*\s*(.*)$").unwrap();
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

    // 2.5 Chapter/section title detection: plain-text lines that read as
    //     headings become `## Heading` (protected from smart-joining below).
    let detected_lines = detect_section_headings(&processed_lines);

    // 3. Junk line removal: page numbers, dates, .indd identifiers and garbled
    // diacritic rows that PDF/InDesign exports sprinkle between paragraphs.
    let mut processed_lines = detected_lines;
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
        let (can_join, hyphen_split) = if let Some(prev) = joined.last() {
            let prev_text = prev.trim_end();
            let next_text = line.trim_start();
            let next_lower = next_text
                .chars()
                .next()
                .map(|c| c.is_ascii_lowercase())
                .unwrap_or(false);
            // A trailing ASCII hyphen usually splits a word across lines
            // ("pro-\ncess"); reattach without the hyphen. Real dashes (em/en,
            // or a space before the hyphen) stay put.
            let hyphen_split = prev_text.ends_with('-')
                && prev_text.chars().count() > 2
                && !prev_text.ends_with(" -")
                && next_lower;
            let can_join = !prev.is_empty()
                && !is_markdown_line(prev)
                && !is_markdown_line(&line)
                // `:`/`;` are not sentence-enders — a line ending in them
                // usually continues.
                && !prev_text.ends_with(['.', '!', '?'])
                && (next_lower || hyphen_split);
            (can_join, hyphen_split)
        } else {
            (false, false)
        };
        if can_join {
            let prev = joined.pop().unwrap();
            if hyphen_split {
                let prev_text = prev.trim_end();
                joined.push(format!("{}{}", &prev_text[..prev_text.len() - 1], line.trim_start()));
            } else {
                joined.push(format!("{} {}", prev.trim_end(), line.trim_start()));
            }
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
        // Lowercase-start lines (so the Title-Case detector doesn't fire) with
        // punctuation/blank-line separators (so smart-joining doesn't fire).
        let input = "line one\n\n\n\nline two ends.\nline three\n\nline four";
        // 4 consecutive newlines (3 empty lines) collapses to 1 empty line (2 newlines)
        let expected = "line one\n\nline two ends.\nline three\n\nline four";
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

    #[test]
    fn test_heading_hash_number_preserved() {
        // `# Section #1` must keep its trailing `#1`; `## # Title` still collapses.
        let input = "# Section #1\n## # Title\n";
        let expected = "# Section #1\n## Title\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_mojibake_repair() {
        // `â€™` (U+2019), `â€œ`/`â€<0x9D>` (U+201C/U+201D) and `Ã©` (é) mojibake.
        let input = "R\u{e9}sum\u{e9} caf\u{e9} \u{e2}\u{20ac}\u{2122}test\u{e2}\u{20ac}\u{2122} \u{e2}\u{20ac}\u{153}quoted\u{e2}\u{20ac}\u{9d} \u{c3}\u{a9}clair.\u{fffd}";
        let expected = "R\u{e9}sum\u{e9} caf\u{e9} 'test' \"quoted\" \u{e9}clair.";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_mojibake_cp1252_dashes() {
        let input = "a\u{e2}\u{20ac}\u{2013}b\u{e2}\u{20ac}\u{2014}c\u{e2}\u{20ac}\u{2026}d";
        let expected = "a\u{2013}b\u{2014}c\u{2026}d";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_chapter_detection() {
        let input = "Chapter 1: The Beginning\nSome prose here\ncontinues on.\nCHAPTER TWO\nMore prose.\nPart II - The Awakening\nFinal prose.\n";
        let expected = "## Chapter 1: The Beginning\nSome prose here continues on.\n## Chapter Two\nMore prose.\n## Part II - The Awakening\nFinal prose.\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_numbered_section_detection() {
        let input = "1. Introduction\nIntro prose here.\n3.2 Results\nThe results were clear.\n";
        let expected = "## Introduction\nIntro prose here.\n## Results\nThe results were clear.\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_numbered_list_not_detected() {
        let input = "1. First item\n2. Second item\n3. Third item\n";
        let expected = "1. First item\n2. Second item\n3. Third item\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_marker_sentence_not_detected() {
        // "Chapter 1 covers..." reads as a sentence — must stay plain text.
        let input = "Chapter 1 covers the basics of this topic.\nChapter 2 goes deeper.\n";
        let expected = "Chapter 1 covers the basics of this topic.\nChapter 2 goes deeper.\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_heading_inside_code_fence_not_detected() {
        let input = "```\nChapter 1: Verbatim\n```\nAfter the fence.\n";
        let expected = "```\nChapter 1: Verbatim\n```\nAfter the fence.\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_hyphen_split_word_join() {
        let input = "The process was inter-\nrupted by the alarm.\n";
        let expected = "The process was interrupted by the alarm.\n";
        assert_eq!(format_note_content(input), expected);
    }

    #[test]
    fn test_colon_continuation_join() {
        // A line ending in `:` continues the sentence — join it.
        let input = "Ingredients:\nflour, sugar and eggs.\n";
        let expected = "Ingredients: flour, sugar and eggs.\n";
        assert_eq!(format_note_content(input), expected);
    }
}

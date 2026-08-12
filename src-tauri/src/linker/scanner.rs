use aho_corasick::AhoCorasick;
use memmap2::Mmap;
use std::fs::File;
use std::path::Path;
use std::io::{self};

pub struct Scanner {
    automaton: AhoCorasick,
    patterns: Vec<String>,
}

impl Scanner {
    pub fn new(patterns: Vec<String>) -> Self {
        let automaton = AhoCorasick::new(&patterns).expect("Failed to build Aho-Corasick automaton");
        Scanner { automaton, patterns }
    }

    pub fn scan<P: AsRef<Path>>(&self, path: P) -> io::Result<Vec<String>> {
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        
        let start_marker = b"<!-- LINKER_START -->";
        
        let content = &mmap[..];
        
        let effective_content = if let Some(start_pos) = content.windows(start_marker.len()).position(|w| w == start_marker) {
            &content[..start_pos]
        } else {
            content
        };

        let mut found_links = Vec::new();
        
        for mat in self.automaton.find_iter(effective_content) {
            found_links.push(self.patterns[mat.pattern()].clone());
        }
        
        // Sort and dedup to maintain set logic
        found_links.sort();
        found_links.dedup();
        
        Ok(found_links)
    }
}

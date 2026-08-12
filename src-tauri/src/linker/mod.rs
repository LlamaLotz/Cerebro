pub mod scanner;
pub mod differ;
pub mod writer;

use crate::db::Database;
use std::path::Path;
use std::io;

pub struct LinkerEngine {
    db: Database,
    scanner: scanner::Scanner,
}

impl LinkerEngine {
    pub fn new(db_path: &str, patterns: Vec<String>) -> Self {
        let db = Database::open(db_path).expect("Failed to open database");
        let scanner = scanner::Scanner::new(patterns);
        LinkerEngine { db, scanner }
    }

    pub fn scan_file<P: AsRef<Path>>(&self, path: P) -> io::Result<Vec<String>> {
        self.scanner.scan(path)
    }

    pub fn diff_file<P: AsRef<Path>>(&self, path: P) -> io::Result<Option<differ::Delta>> {
        let path_str = path.as_ref().to_string_lossy().to_string();
        let existing = self.db.get_links_for_note(&path_str).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        let new_links = self.scan_file(path.as_ref())?;
        
        Ok(differ::calculate_delta(&existing, &new_links))
    }

    pub fn apply_file<P: AsRef<Path>>(&mut self, path: P) -> io::Result<bool> {
        let path_ref = path.as_ref();
        let path_str = path_ref.to_string_lossy().to_string();
        
        let delta = self.diff_file(path_ref)?;
        
        if let Some(_d) = delta {
            // Read content for writing (Read-Once rule applied in scanner, 
            // but we need it again for the final write. 
            // Since we already scanned, we read it once more for the atomic write).
            let content = std::fs::read_to_string(path_ref)?;
            
            // Get the full list of new links
            let new_links = self.scan_file(path_ref)?;
            
            writer::atomic_write(path_ref, &content, &new_links)?;
            
            // Update DB
            self.db.update_links(&path_str, &new_links).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
            
            return Ok(true);
        }
        
        Ok(false)
    }
}

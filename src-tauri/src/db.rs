use rusqlite::{Connection, Result};
use std::path::Path;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes (
                path TEXT PRIMARY KEY,
                content_hash TEXT
            )",
            [],
        )?;
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS links (
                source TEXT,
                target TEXT,
                PRIMARY KEY (source, target)
            )",
            [],
        )?;
        
        Ok(Database { conn })
    }

    pub fn get_links_for_note(&self, source: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT target FROM links WHERE source = ?")?;
        let rows = stmt.query_map([source], |row| row.get(0))?;
        
        let mut links = Vec::new();
        for link in rows {
            links.push(link?);
        }
        Ok(links)
    }

    pub fn update_links(&mut self, source: &str, targets: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        
        tx.execute("DELETE FROM links WHERE source = ?", [source])?;
        
        for target in targets {
            tx.execute("INSERT INTO links (source, target) VALUES (?, ?)", [source, target])?;
        }
        
        tx.commit()?;
        Ok(())
    }
}

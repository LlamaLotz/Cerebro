use std::io::{self, Write};
use std::path::Path;
use tempfile::NamedTempFile;

pub fn atomic_write<P: AsRef<Path>>(path: P, content: &str, links: &[String]) -> io::Result<()> {
    let path = path.as_ref();
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No parent directory"))?;
    
    // Create a temp file in the same directory to ensure atomic rename
    let mut temp_file = NamedTempFile::new_in(dir)?;
    
    // Construct the machine-generated footer
    let mut footer = String::from("\n\n<!-- LINKER_START -->\n");
    footer.push_str("Links:\n");
    for link in links {
        footer.push_str(&format!("- {}\n", link));
    }
    footer.push_str("<!-- LINKER_END -->");
    
    // To avoid duplicating the footer, we must strip existing one from content
    let stripped_content = strip_footer(content);
    
    let final_output = format!("{}{}", stripped_content, footer);
    
    temp_file.write_all(final_output.as_bytes())?;
    temp_file.persist(path).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    
    Ok(())
}

fn strip_footer(content: &str) -> String {
    let start_marker = "<!-- LINKER_START -->";
    if let Some(pos) = content.find(start_marker) {
        content[..pos].trim_end().to_string()
    } else {
        content.trim_end().to_string()
    }
}

use std::collections::HashSet;

pub struct Delta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

pub fn calculate_delta(existing: &[String], new_links: &[String]) -> Option<Delta> {
    let existing_set: HashSet<_> = existing.iter().collect();
    let new_set: HashSet<_> = new_links.iter().collect();

    let added: Vec<String> = new_links
        .iter()
        .filter(|link| !existing_set.contains(link))
        .cloned()
        .collect();

    let removed: Vec<String> = existing
        .iter()
        .filter(|link| !new_set.contains(link))
        .cloned()
        .collect();

    if added.is_empty() && removed.is_empty() {
        None
    } else {
        Some(Delta { added, removed })
    }
}

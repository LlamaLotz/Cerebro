//! Local semantic embeddings + HNSW vector search.
//!
//! Uses `fastembed` (ONNX Runtime, 100% local CPU) with the Qdrant-quantized
//! `bge-base-en-v1.5` model to produce 768-dimensional embeddings, and
//! `hnsw_rs` for logarithmic-time approximate nearest neighbour search.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use hnsw_rs::prelude::*;
use rusqlite::{params, Connection};

use crate::db::{
    clear_all_block_embeddings, clear_all_embeddings, clear_block_embeddings,
    clear_note_embedding, load_all_block_embeddings, load_all_embeddings, save_block_embedding,
    save_note_embedding, BlockEmbedding, SemanticMatch,
};

/// Graph construction parameters (accuracy/speed trade-off).
const HNSW_MAX_CONNECTION: usize = 24;
const HNSW_EF_CONSTRUCTION: usize = 200;
const HNSW_EF_SEARCH: usize = 128;

/// Minimum cosine similarity (normalized 0.0..=1.0) for a match to surface in
/// the Related Notes panel. bge-base-en-v1.5 separates topics far better than
/// the old MiniLM model, but unrelated texts still score 0.3–0.5, so the
/// threshold must stay strict. Scores below it are filtered out honestly: the
/// panel shows an empty state instead of junk suggestions. Tuned up to 0.75 to
/// kill false positives on short notes whose token-average embeddings skim
/// close to anything.
const MIN_SIMILARITY_SCORE: f32 = 0.70;

/// Number of the active note's own blocks used as topical query units when
/// searching for related notes/blocks. A long note's whole-document embedding
/// is truncated to its first ~512 tokens and long documents converge toward
/// the centroid, making every long note look related to every other one; its
/// blocks are a far better representation of what the note is about.
const QUERY_UNIT_LIMIT: usize = 8;

/// Number of texts fed to the model per inference pass during backfill.
const BACKFILL_BATCH_SIZE: usize = 16;

/// Minimum characters for a block to stand on its own. Smaller blocks are
/// merged into a neighbour so long notes don't fragment into thousands of
/// near-empty pieces.
const MIN_BLOCK_CHARS: usize = 40;

/// Minimum characters of text for the active note to run *any* semantic
/// matching (related notes + block matches). Ultra-short notes (under this)
/// have too little signal: their token-average embeddings cosine-match
/// anything, which is exactly the false-positive complaint. They rely strictly
/// on the exact Keyword/Title Aho-Corasick matcher instead.
const MIN_SEMANTIC_NOTE_CHARS: usize = 50;

/// Maximum number of blocks kept per note. Capping prevents pathological
/// notes (e.g. whole books) from exploding into tens of thousands of embedding
/// rows and saturating CPU/RAM with parallel inference batches.
pub const MAX_BLOCKS_PER_NOTE: usize = 400;

/// Texts fed to the model per inference pass for block embeddings. Keeping
/// this small (and feeding exactly one chunk per call) means fastembed's
/// rayon `par_chunks` never fans out into dozens of concurrent ONNX sessions.
const BLOCK_EMBED_BATCH: usize = 32;

/// Notes larger than this are never embedded (note or block level). A 512-token
/// embedding of a multi-MB note captures a rounding error of its content, while
/// the tokenization + inference cost spikes CPU/RAM in debug builds. Exact
/// linking (wiki links, backlinks, `^anchor` jumps) is unaffected.
pub const MAX_EMBED_CHARS: usize = 200_000;

/// Computes cosine similarity between two vectors, normalized to 0.0..=1.0.
pub fn cosine_similarity(vec_a: &[f32], vec_b: &[f32]) -> f32 {
    if vec_a.len() != vec_b.len() || vec_a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    for i in 0..vec_a.len() {
        let a = vec_a[i] as f64;
        let b = vec_b[i] as f64;
        dot += a * b;
        norm_a += a * a;
        norm_b += b * b;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    (dot / (norm_a * norm_b).sqrt()) as f32
}

fn next_pow2(n: usize) -> usize {
    let mut v = n.max(2);
    while v & (v - 1) != 0 {
        v &= v - 1;
    }
    v << 1
}

fn hnsw_capacity_for(count: usize) -> usize {
    if count == 0 {
        16
    } else {
        next_pow2(count).max(16)
    }
}

fn hnsw_max_layer(capacity: usize) -> usize {
    16.min((capacity as f32).ln().trunc() as usize).max(1)
}

/// Builds a fresh HNSW graph from the given `(vector, external_id)` pairs.
fn build_hnsw(pairs: &[(&Vec<f32>, usize)]) -> Hnsw<'static, f32, DistCosine> {
    let capacity = hnsw_capacity_for(pairs.len());
    let hnsw = Hnsw::<f32, DistCosine>::new(
        HNSW_MAX_CONNECTION,
        capacity,
        hnsw_max_layer(capacity),
        HNSW_EF_CONSTRUCTION,
        DistCosine {},
    );
    hnsw.parallel_insert(pairs);
    hnsw
}

/// In-memory vector index (the "search engine").
///
/// SQLite is the source of truth; this structure is rebuilt from it on
/// startup and mutated incrementally as notes are saved.
struct EmbeddingIndex {
    hnsw: Hnsw<'static, f32, DistCosine>,
    /// external id -> (note_id, vector). `None` marks stale points that have
    /// been re-embedded (hnsw_rs has no deletion, so stale points are hidden
    /// via this slot map and compacted away on rebuild).
    points: Vec<Option<(String, Vec<f32>)>>,
    /// note_id -> current external id
    id_map: HashMap<String, usize>,
    stale_count: usize,
}

impl EmbeddingIndex {
    fn from_embeddings(entries: Vec<(String, Vec<f32>)>) -> Self {
        let pairs: Vec<(&Vec<f32>, usize)> = entries
            .iter()
            .enumerate()
            .map(|(id, (_, vec))| (vec, id))
            .collect();

        let hnsw = build_hnsw(&pairs);

        let mut id_map = HashMap::with_capacity(entries.len());
        let points = entries
            .into_iter()
            .enumerate()
            .map(|(id, (note_id, vec))| {
                id_map.insert(note_id.clone(), id);
                Some((note_id, vec))
            })
            .collect();

        EmbeddingIndex {
            hnsw,
            points,
            id_map,
            stale_count: 0,
        }
    }

    fn insert_new(&mut self, note_id: String, vector: Vec<f32>) {
        let id = self.points.len();
        self.points.push(Some((note_id.clone(), vector.clone())));
        self.id_map.insert(note_id, id);
        self.hnsw.insert((vector.as_slice(), id));
    }

    fn rebuild(&mut self) {
        let live: Vec<(String, Vec<f32>)> = self
            .points
            .iter()
            .flatten()
            .cloned()
            .collect();

        let pairs: Vec<(&Vec<f32>, usize)> = live
            .iter()
            .enumerate()
            .map(|(id, (_, vec))| (vec, id))
            .collect();

        self.hnsw = build_hnsw(&pairs);
        self.points = live
            .into_iter()
            .enumerate()
            .map(|(id, (note_id, vec))| {
                self.id_map.insert(note_id.clone(), id);
                Some((note_id, vec))
            })
            .collect();
        self.stale_count = 0;
    }

    /// Inserts or replaces the embedding for `note_id`.
    fn upsert(&mut self, note_id: &str, vector: Vec<f32>) {
        if let Some(&old_id) = self.id_map.get(note_id) {
            if let Some(slot) = self.points.get_mut(old_id) {
                *slot = None;
                self.stale_count += 1;
            }
            // Compact when more than half of the graph is stale points.
            if self.stale_count > self.points.len() / 2 && self.stale_count > 32 {
                self.rebuild();
            }
        }
        self.insert_new(note_id.to_string(), vector);
    }

    /// Removes `note_id` from the index entirely (stale-mark + compact, as in
    /// `upsert`). Used when a note's embedding is purged (empty content), so
    /// it stops being a search candidate without waiting for a rebuild.
    fn remove(&mut self, note_id: &str) {
        if let Some(&old_id) = self.id_map.get(note_id) {
            if let Some(slot) = self.points.get_mut(old_id) {
                *slot = None;
                self.stale_count += 1;
            }
            self.id_map.remove(note_id);
            if self.stale_count > self.points.len() / 2 && self.stale_count > 32 {
                self.rebuild();
            }
        }
    }

    /// HNSW search, mapping results back to note ids and cosine similarity
    /// scores, excluding `exclude_note_id`. Returns `top_k` best matches
    /// sorted by descending score.
    fn search(&self, query: &[f32], top_k: usize, exclude_note_id: &str) -> Vec<SemanticMatch> {
        let candidates = self.hnsw.search(query, top_k.max(8) * 4, HNSW_EF_SEARCH);

        // Enforce the similarity threshold with no fallback: below-threshold
        // neighbours are noise and surfacing them is exactly the "inaccurate
        // suggestions" complaint. An empty list is the honest answer.
        let best = self.collect_matches(&candidates, exclude_note_id, Some(MIN_SIMILARITY_SCORE));

        let mut matches: Vec<SemanticMatch> = best
            .into_iter()
            .map(|(note_id, score)| SemanticMatch {
                note_id,
                score,
                matched_text: None,
                matched_block_id: None,
            })
            .collect();
        matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        matches.truncate(top_k);
        matches
    }

    /// Deduplicates HNSW candidates by note id, keeping the best score per
    /// note, optionally enforcing a minimum similarity.
    fn collect_matches(
        &self,
        candidates: &[Neighbour],
        exclude_note_id: &str,
        min_score: Option<f32>,
    ) -> HashMap<String, f32> {
        let mut best: HashMap<String, f32> = HashMap::with_capacity(candidates.len());
        for neighbour in candidates {
            let ext_id = neighbour.get_origin_id();
            let slot = match self.points.get(ext_id) {
                Some(Some(slot)) => slot,
                _ => continue, // stale / retired point
            };
            if slot.0 == exclude_note_id {
                continue;
            }
            let score = (1.0 - neighbour.get_distance()).clamp(0.0, 1.0);
            if let Some(min) = min_score {
                if score < min {
                    continue;
                }
            }
            let entry = best.entry(slot.0.clone()).or_insert(0.0);
            if score > *entry {
                *entry = score;
            }
        }
        best
    }
}

/// A single indexed block (paragraph/section) with its embedding.
/// The block's text lives in SQLite (fetched on demand for results) so
/// thousands of blocks don't hold large strings in RAM.
struct BlockEntry {
    note_id: String,
    block_id: String,
    vector: Vec<f32>,
}

/// On-disk path of a note (via the notes table), if resolvable.
fn note_path(conn: &Connection, note_id: &str) -> Option<String> {
    conn.query_row("SELECT path FROM notes WHERE id = ?1", params![note_id], |row| {
        row.get(0)
    })
    .ok()
}

/// On-disk byte size of a note (via its path in the index), if resolvable.
fn note_byte_len(conn: &Connection, note_id: &str) -> Option<u64> {
    std::fs::metadata(&note_path(conn, note_id)?).ok().map(|m| m.len())
}

/// True when the active note's text is shorter than `MIN_SEMANTIC_NOTE_CHARS`
/// characters. Counts actual characters (not bytes), so multi-byte UTF-8 text
/// is measured correctly. Used to skip semantic matching entirely for
/// ultra-short notes, which then rely strictly on exact Keyword/Title
/// Aho-Corasick matching.
fn is_short_note(conn: &Connection, note_id: &str) -> bool {
    match note_path(conn, note_id) {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(content) => content.trim().chars().count() < MIN_SEMANTIC_NOTE_CHARS,
            Err(_) => true,
        },
        None => true,
    }
}

/// True when `content` is worth embedding. Empty/whitespace-only text embeds
/// to a meaningless token-average vector that cosine-matches *anything* — such
/// notes must be excluded from the index entirely, not embedded.
fn is_embeddable_content(content: &str) -> bool {
    !content.trim().is_empty()
}

/// True when the note on disk is empty or near-empty (smaller than the
/// minimum meaningful block). Used to filter *stale* embeddings — e.g. a note
/// that was saved empty before the purge existed — without reading its file.
fn is_empty_note(conn: &Connection, note_id: &str) -> bool {
    matches!(note_byte_len(conn, note_id), Some(len) if len < MIN_BLOCK_CHARS as u64)
}

/// True when a note is too large to embed meaningfully (see `MAX_EMBED_CHARS`).
fn is_oversized(content: &str) -> bool {
    content.len() > MAX_EMBED_CHARS
}

/// Note ids that must never surface as suggestions for `note_id`:
///  - notes the user explicitly denied/dismissed for this note
///    (`denied_links`, scoped by `kind`), and
///  - notes already linked *from* this note (`links` table — the applied
///    `[[wikilink]]` graph). Both make denied links stay denied and approved
///    links stop re-suggesting on the next scan.
fn excluded_note_ids(
    conn: &Connection,
    note_id: &str,
    kind: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut excluded = std::collections::HashSet::new();

    let mut stmt = conn
        .prepare(
            "SELECT target FROM denied_links
             WHERE note_path = ?1 AND kind = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id, kind], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        excluded.insert(row.map_err(|e| e.to_string())?);
    }

    // Applied [[wikilink]] targets: the `links` table stores the raw target
    // extracted from the note body (a title) while approval flows write note
    // paths — resolve both forms back to note ids via the notes table.
    let mut stmt = conn
        .prepare("SELECT target FROM links WHERE source = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut title_resolver = conn
        .prepare("SELECT id FROM notes WHERE lower(title) = lower(?1) OR id = ?1")
        .map_err(|e| e.to_string())?;
    for row in rows {
        let target = row.map_err(|e| e.to_string())?;
        let resolved = title_resolver
            .query_map(params![target], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for r in resolved {
            excluded.insert(r.map_err(|e| e.to_string())?);
        }
    }

    Ok(excluded)
}

/// The semantic engine: shared model (thread-safe inference) + mutable index.
pub struct EmbeddingEngine {
    model: TextEmbedding,
    index: Mutex<EmbeddingIndex>,
    blocks: Mutex<Vec<BlockEntry>>,
}

impl EmbeddingEngine {
    /// Loads the bge-base-en-v1.5 model (downloaded to `~/.cerebro/models` on
    /// first run, fully offline afterwards) and rebuilds the HNSW index from
    /// SQLite.
    pub fn new(conn: &Connection, cache_dir: PathBuf) -> Result<Self, String> {
        let options = InitOptions {
            model_name: EmbeddingModel::BGEBaseENV15Q,
            execution_providers: Default::default(),
            max_length: 512,
            cache_dir,
            show_download_progress: false,
        };

        let model = TextEmbedding::try_new(options).map_err(|e| e.to_string())?;

        // Detect a vector-dimension change (e.g. a model swap): every stored
        // embedding from the old model is garbage for the new one, so wipe
        // both tables and let the startup backfill regenerate everything.
        let probe = model
            .embed(vec!["probe".to_string()], Some(1))
            .map_err(|e| e.to_string())?;
        let model_dim = probe[0].len();
        let stored = load_all_embeddings(conn)?;
        if let Some((_, old_vec)) = stored.first() {
            if old_vec.len() != model_dim {
                println!(
                    "[embeddings] vector dimension changed ({}d -> {model_dim}d): \
                     wiping stored embeddings + block embeddings — full re-embed follows",
                    old_vec.len()
                );
                clear_all_embeddings(conn)?;
                clear_all_block_embeddings(conn)?;
            }
        }

        // One-time hygiene: drop stored embeddings for notes whose files are
        // now empty (an empty string embeds to a meaningless token-average
        // vector that cosine-matches *anything*). Without this, a note that
        // was saved empty before the purge existed would keep being suggested
        // until its next save.
        let entries = stored
            .into_iter()
            .filter(|(note_id, _)| {
                if is_empty_note(conn, note_id) {
                    let _ = clear_note_embedding(conn, note_id);
                    false
                } else {
                    true
                }
            })
            .collect();
        let index = EmbeddingIndex::from_embeddings(entries);

        let blocks = load_all_block_embeddings(conn)?
            .into_iter()
            .filter(|(note_id, _, _, _)| !is_empty_note(conn, note_id))
            .map(|(note_id, block_id, _text, vector)| BlockEntry {
                note_id,
                block_id,
                vector,
            })
            .collect();

        Ok(EmbeddingEngine {
            model,
            index: Mutex::new(index),
            blocks: Mutex::new(blocks),
        })
    }

    /// Embeds `texts` in small serial batches so fastembed's rayon
    /// `par_chunks` never fans out into dozens of concurrent ONNX sessions
    /// (which saturates every core and spikes memory on large notes). Exactly
    /// one inference pass runs at a time.
    fn embed_serial(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BLOCK_EMBED_BATCH) {
            let batch = self
                .model
                .embed(chunk.to_vec(), Some(chunk.len()))
                .map_err(|e| e.to_string())?;
            out.extend(batch);
        }
        Ok(out)
    }

    /// Generates a 768-dim embedding for `text` (no index lock held during
    /// inference so searches are never blocked by embedding work).
    pub fn generate_embedding(&self, text: &str) -> Result<Vec<f32>, String> {
        let mut embeddings = self
            .model
            .embed(vec![text.to_string()], None)
            .map_err(|e| e.to_string())?;

        embeddings.pop().ok_or_else(|| "Embedding model returned no output.".to_string())
    }

    /// Embeds `content` and persists it to SQLite + the in-memory HNSW graph.
    /// Notes above `MAX_EMBED_CHARS` are skipped (a 512-token embedding of a
    /// multi-MB note is noise, and the inference cost spikes CPU in debug
    /// builds). `Ok` is still returned so callers treat it as a no-op.
    pub fn generate_and_store(
        &self,
        conn: &Connection,
        note_id: &str,
        content: &str,
    ) -> Result<(), String> {
        if !is_embeddable_content(content) {
            // Empty notes embed to a meaningless token-average vector that
            // cosine-matches *anything* — purge any previously stored
            // embedding (and index entry) so they can never be suggested as
            // related notes.
            crate::db::clear_note_embedding(conn, note_id)?;
            self.index.lock().unwrap().remove(note_id);
            println!("[embeddings] purged embedding for empty note: {note_id}");
            return Ok(());
        }
        if is_oversized(content) {
            println!(
                "[embeddings] skipping note-level embedding for oversized note ({} bytes): {note_id}",
                content.len()
            );
            return Ok(());
        }
        let vector = self.generate_embedding(content)?;
        save_note_embedding(conn, note_id, &vector)?;
        self.index.lock().unwrap().upsert(note_id, vector);
        Ok(())
    }

    /// Finds the top-K conceptually related notes for `note_id`.
    ///
    /// The query is the note's *own blocks* (up to `QUERY_UNIT_LIMIT`, earliest
    /// first) rather than the whole-note embedding — see `QUERY_UNIT_LIMIT`.
    /// Each unit is searched against the note-level HNSW index; the best score
    /// per candidate note across units wins, and candidates below
    /// `MIN_SIMILARITY_SCORE` are dropped honestly. Ultra-short notes (under
    /// `MIN_SEMANTIC_NOTE_CHARS`) are skipped entirely — they rely strictly on
    /// exact Keyword/Title Aho-Corasick matching.
    pub fn find_related(
        &self,
        conn: &Connection,
        note_id: &str,
        top_k: usize,
    ) -> Result<Vec<SemanticMatch>, String> {
        // An empty active note has nothing to relate to.
        if is_empty_note(conn, note_id) {
            return Ok(vec![]);
        }
        // Ultra-short notes have too little signal for vector search — their
        // token-average embeddings match anything. They rely strictly on the
        // exact Keyword/Title Aho-Corasick matcher instead.
        if is_short_note(conn, note_id) {
            return Ok(vec![]);
        }
        if let Some(len) = note_byte_len(conn, note_id) {
            if len > MAX_EMBED_CHARS as u64 {
                return Err(format!(
                    "Note is too large for semantic indexing ({len} bytes > {MAX_EMBED_CHARS} char limit)"
                ));
            }
        }
        let mut units = crate::db::get_note_block_vectors(conn, note_id, QUERY_UNIT_LIMIT)?;
        if units.is_empty() {
            // No blocks (empty note): fall back to the whole-note embedding.
            let whole = crate::db::get_note_embedding(conn, note_id)?
                .ok_or_else(|| format!("No embedding stored for note: {note_id}"))?;
            units.push(whole);
        }

        let mut aggregate: HashMap<String, f32> = HashMap::new();
        {
            let index = self.index.lock().unwrap();
            for unit in &units {
                for m in index.search(unit, top_k.max(8) * 2, note_id) {
                    let entry = aggregate.entry(m.note_id).or_insert(0.0);
                    if m.score > *entry {
                        *entry = m.score;
                    }
                }
            }
        }

        // Never re-suggest notes the user denied or already linked from here,
        // and never surface empty/near-empty notes (their stale embeddings
        // would match anything).
        let excluded = excluded_note_ids(conn, note_id, "semantic")?;
        let mut matches: Vec<SemanticMatch> = aggregate
            .into_iter()
            .filter(|(id, _)| !excluded.contains(id) && !is_empty_note(conn, id))
            .map(|(note_id, score)| SemanticMatch {
                note_id,
                score,
                matched_text: None,
                matched_block_id: None,
            })
            .collect();
        matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        matches.truncate(top_k);

        // Explain every suggestion: find the candidate block that best matches
        // the query units, so the UI can show what caused the link (and jump
        // to that passage). Candidates without blocks stay explanation-free.
        {
            let blocks = self.blocks.lock().unwrap();
            let mut keys: Vec<(String, String)> = Vec::new();
            for m in matches.iter_mut() {
                let mut best: Option<(f32, String)> = None;
                for b in blocks.iter().filter(|b| b.note_id == m.note_id) {
                    for u in &units {
                        let s = cosine_similarity(u, &b.vector);
                        if s > best.as_ref().map(|(s, _)| *s).unwrap_or(f32::MIN) {
                            best = Some((s, b.block_id.clone()));
                        }
                    }
                }
                if let Some((_, bid)) = best {
                    m.matched_block_id = Some(bid.clone());
                    keys.push((m.note_id.clone(), bid));
                }
            }
            drop(blocks);
            if !keys.is_empty() {
                let texts = crate::db::get_block_texts(conn, &keys)?;
                for m in matches.iter_mut() {
                    if let Some(bid) = &m.matched_block_id {
                        m.matched_text = texts.get(&(m.note_id.clone(), bid.clone())).cloned();
                    }
                }
            }
        }
        Ok(matches)
    }

    /// Embeds and stores many notes in batches. Batching matters on first-run
    /// backfill of a large vault: a single model call processes a whole batch,
    /// so inference happens in a fraction of the one-at-a-time time.
    /// Oversized notes are dropped from the batch (their embeddings are
    /// meaningless and costly).
    pub fn backfill(
        &self,
        conn: &Connection,
        pending: Vec<(String, String)>,
    ) -> Result<usize, String> {
        let mut count = 0usize;
        let eligible: Vec<&(String, String)> = pending
            .iter()
            .filter(|(_, content)| is_embeddable_content(content) && !is_oversized(content))
            .collect();
        for chunk in eligible.chunks(BACKFILL_BATCH_SIZE) {
            let texts: Vec<String> = chunk.iter().map(|(_, content)| content.clone()).collect();
            let embeddings = self
                .model
                .embed(texts, Some(BACKFILL_BATCH_SIZE))
                .map_err(|e| e.to_string())?;

            let mut index = self.index.lock().unwrap();
            for ((id, _), vector) in chunk.iter().zip(embeddings) {
                save_note_embedding(conn, id, &vector)?;
                index.upsert(id, vector);
                count += 1;
            }
        }
        Ok(count)
    }
}

/// FNV-1a 32-bit hash used to derive stable, deterministic block ids.
fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for &b in bytes {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// Returns the trailing `^anchor` of the first line that carries one, if any.
fn existing_anchor(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(pos) = t.rfind('^') {
            let id = t[pos + 1..].trim();
            if !id.is_empty()
                && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// Strips the machine-generated linker footer (and YAML frontmatter) so only
/// the note's real body is chunked.
fn strip_metadata(content: &str) -> &str {
    let mut s = content;
    if let Some(start) = s.find("<!-- LINKER_START -->") {
        s = &s[..start];
    }
    if s.trim_start().starts_with("---") {
        let body = s.trim_start();
        if let Some(end_rel) = body[3..].find("\n---") {
            s = &body[3 + end_rel + 4..];
        }
    }
    s
}

/// Splits note content into linkable blocks: headings open a new block and
/// paragraphs are separated by blank lines. Each block is assigned its
/// existing `^anchor` when present, otherwise a deterministic generated id.
///
/// Long notes are aggressively consolidated: undersized fragments are merged
/// into neighbours and the total block count is capped so a whole textbook
/// never balloons into tens of thousands of embedding rows.
pub fn split_into_blocks(content: &str) -> Vec<(String, String)> {
    let body = strip_metadata(content);

    let mut raw_blocks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !current.trim().is_empty() {
                raw_blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        if t.starts_with('#') && !current.trim().is_empty() {
            raw_blocks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        raw_blocks.push(current);
    }

    // 1. Trim + drop empties.
    let blocks: Vec<String> = raw_blocks
        .into_iter()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect();

    // 2. Merge undersized fragments into a neighbour so short lines (dates,
    //    single words, list items) don't each become their own chunk.
    let mut merged: Vec<String> = Vec::with_capacity(blocks.len());
    for block in blocks {
        if let Some(prev) = merged.last_mut() {
            let can_merge = prev.len() < MIN_BLOCK_CHARS || block.len() < MIN_BLOCK_CHARS;
            if can_merge && prev.len() + block.len() <= 3 * MIN_BLOCK_CHARS {
                prev.push('\n');
                prev.push_str(&block);
                continue;
            }
        }
        merged.push(block);
    }
    let mut blocks = merged;

    // 3. Cap total blocks for pathologically large notes by merging neighbours.
    while blocks.len() > MAX_BLOCKS_PER_NOTE {
        let mut next: Vec<String> = Vec::with_capacity(blocks.len() / 2 + 1);
        let mut it = blocks.into_iter();
        while let Some(a) = it.next() {
            match it.next() {
                Some(b) => {
                    let mut combined = a;
                    combined.push('\n');
                    combined.push_str(&b);
                    next.push(combined);
                }
                None => next.push(a),
            }
        }
        blocks = next;
    }

    blocks
        .into_iter()
        .enumerate()
        .map(|(i, text)| {
            let id = existing_anchor(&text)
                .unwrap_or_else(|| format!("block-{:08x}-{}", fnv1a32(text.as_bytes()), i));
            (id, text)
        })
        .collect()
}

impl EmbeddingEngine {
    /// Splits a note into blocks, embeds them, and replaces the note's block
    /// index in SQLite + memory. Frontmatter and the linker footer are skipped.
    pub fn generate_and_store_blocks(
        &self,
        conn: &Connection,
        note_id: &str,
        content: &str,
    ) -> Result<(), String> {
        if is_oversized(content) {
            // Purge any pre-cap block rows: skipping alone would leave stale
            // blocks (from before the cap existed) surfacing as suggestions
            // forever, since oversized notes are never re-embedded.
            let _ = clear_block_embeddings(conn, note_id);
            self.blocks.lock().unwrap().retain(|b| b.note_id != note_id);
            println!(
                "[embeddings] purged block embeddings for oversized note ({} bytes): {note_id}",
                content.len()
            );
            return Ok(());
        }
        let blocks = split_into_blocks(content);
        // Purge existing rows *before* the empty check: a note whose blocks
        // were all removed would otherwise keep ghost block suggestions
        // forever (nothing is ever re-inserted for an empty block list).
        clear_block_embeddings(conn, note_id)?;
        self.blocks.lock().unwrap().retain(|b| b.note_id != note_id);
        if blocks.is_empty() {
            return Ok(());
        }

        let texts: Vec<String> = blocks.iter().map(|(_, t)| t.clone()).collect();
        let vectors = self.embed_serial(texts)?;

        let mut index = self.blocks.lock().unwrap();
        for ((block_id, text), vector) in blocks.iter().zip(vectors) {
            save_block_embedding(conn, note_id, block_id, text, &vector)?;
            index.push(BlockEntry {
                note_id: note_id.to_string(),
                block_id: block_id.clone(),
                vector,
            });
        }
        Ok(())
    }

    /// Returns the top-K semantically matching *blocks* from other notes for
    /// `note_id`. The query is the note's *own blocks* (topical units, see
    /// `QUERY_UNIT_LIMIT`); the best score per candidate block across units
    /// wins, and candidates below `MIN_SIMILARITY_SCORE` are dropped — the
    /// panel is empty rather than filled with unrelated blocks. Ultra-short
    /// notes (under `MIN_SEMANTIC_NOTE_CHARS`) are skipped entirely — they
    /// rely strictly on exact Keyword/Title Aho-Corasick matching. Block text
    /// is fetched from SQLite only for the final results.
    pub fn find_block_matches(
        &self,
        conn: &Connection,
        note_id: &str,
        top_k: usize,
    ) -> Result<Vec<BlockEmbedding>, String> {
        // An empty active note has no topics to match blocks against.
        if is_empty_note(conn, note_id) {
            return Ok(vec![]);
        }
        // Ultra-short notes have too little signal for vector search — their
        // token-average embeddings match anything. They rely strictly on the
        // exact Keyword/Title Aho-Corasick matcher instead.
        if is_short_note(conn, note_id) {
            return Ok(vec![]);
        }
        if let Some(len) = note_byte_len(conn, note_id) {
            if len > MAX_EMBED_CHARS as u64 {
                return Err(format!(
                    "Note is too large for block matching ({len} bytes > {MAX_EMBED_CHARS} char limit)"
                ));
            }
        }
        let mut units = crate::db::get_note_block_vectors(conn, note_id, QUERY_UNIT_LIMIT)?;
        if units.is_empty() {
            let whole = crate::db::get_note_embedding(conn, note_id)?
                .ok_or_else(|| format!("No embedding stored for note: {note_id}"))?;
            units.push(whole);
        }

        let excluded = excluded_note_ids(conn, note_id, "block")?;

        // Best score per (note_id, block_id) across all query units, with an
        // honest similarity threshold (no more unconditional top-K).
        let mut best: HashMap<(String, String), f32> = HashMap::new();
        {
            let blocks = self.blocks.lock().unwrap();
            for unit in &units {
                for b in blocks.iter() {
                    if b.note_id == note_id || excluded.contains(&b.note_id) {
                        continue;
                    }
                    let score = cosine_similarity(unit, &b.vector);
                    if score < MIN_SIMILARITY_SCORE {
                        continue;
                    }
                    let entry = best
                        .entry((b.note_id.clone(), b.block_id.clone()))
                        .or_insert(0.0);
                    if score > *entry {
                        *entry = score;
                    }
                }
            }
        }

        let mut scored: Vec<((String, String), f32)> = best
            .into_iter()
            .filter(|((n, _), _)| !is_empty_note(conn, n))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);

        let pairs: Vec<(String, String)> = scored
            .iter()
            .map(|((note_id, block_id), _)| (note_id.clone(), block_id.clone()))
            .collect();
        let texts = crate::db::get_block_texts(conn, &pairs)?;

        Ok(scored
            .into_iter()
            .map(|((note_id, block_id), score)| {
                let text = texts
                    .get(&(note_id.clone(), block_id.clone()))
                    .cloned()
                    .unwrap_or_default();
                BlockEmbedding {
                    note_id,
                    block_id,
                    text,
                    score,
                }
            })
            .collect())
    }

    /// Embeds blocks for every note that has none (first-run backfill).
    pub fn backfill_blocks(
        &self,
        conn: &Connection,
        pending: Vec<(String, String)>,
    ) -> Result<usize, String> {
        let mut count = 0usize;
        let mut new_blocks: Vec<BlockEntry> = Vec::new();

        for (note_id, content) in &pending {
            if is_oversized(content) {
                // Purge any pre-cap block rows so stale blocks never resurface
                // as suggestions (oversized notes are never re-embedded).
                let _ = clear_block_embeddings(conn, note_id);
                self.blocks.lock().unwrap().retain(|b| &b.note_id != note_id);
                println!(
                    "[embeddings] purged block embeddings for oversized note ({} bytes): {note_id}",
                    content.len()
                );
                continue;
            }
            let blocks = split_into_blocks(content);
            // Replace any stale rows (pre-cap blocks, deleted blocks) for this
            // note — including the empty case, so a note whose blocks were all
            // removed stops suggesting them.
            clear_block_embeddings(conn, note_id)?;
            if blocks.is_empty() {
                self.blocks.lock().unwrap().retain(|b| &b.note_id != note_id);
                continue;
            }
            let texts: Vec<String> = blocks.iter().map(|(_, t)| t.clone()).collect();
            let vectors = self.embed_serial(texts)?;

            for ((block_id, text), vector) in blocks.iter().zip(vectors) {
                save_block_embedding(conn, note_id, block_id, text, &vector)?;
                new_blocks.push(BlockEntry {
                    note_id: note_id.clone(),
                    block_id: block_id.clone(),
                    vector,
                });
                count += 1;
            }
        }

        let mut index = self.blocks.lock().unwrap();
        index.append(&mut new_blocks);
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_into_blocks_caps_pathological_notes() {
        let mut content = String::new();
        for i in 0..5000 {
            content.push_str(&format!(
                "Paragraph number {i} with enough words to exceed the minimum block length for a paragraph in the vault.\n\n"
            ));
        }
        let blocks = split_into_blocks(&content);
        assert!(
            blocks.len() <= MAX_BLOCKS_PER_NOTE,
            "expected cap {} got {}",
            MAX_BLOCKS_PER_NOTE,
            blocks.len()
        );
    }

    #[test]
    fn split_into_blocks_merges_tiny_fragments() {
        let content = "A tiny fragment\n\nAnother small line\n\nA normal sized paragraph that has more than the minimum number of characters in it so it should remain its own block.\n";
        let blocks = split_into_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].1.contains("A tiny fragment\nAnother small line"));
    }

    #[test]
    fn is_short_note_flags_ultra_short_notes() {
        let db = crate::db::Database::open(":memory:").unwrap();
        let dir = std::env::temp_dir().join(format!("cerebro-test-short-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let short_path = dir.join("short.md");
        let long_path = dir.join("long.md");
        std::fs::write(&short_path, "Hello world").unwrap();
        std::fs::write(
            &long_path,
            "A note with substantially more than fifty characters of real text content inside it.",
        )
        .unwrap();

        db.conn
            .execute(
                "INSERT INTO notes (id, title, path, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    "short",
                    "Short",
                    short_path.to_string_lossy(),
                    12345678i64
                ],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO notes (id, title, path, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params!["long", "Long", long_path.to_string_lossy(), 12345678i64],
            )
            .unwrap();

        assert!(is_short_note(&db.conn, "short"));
        assert!(!is_short_note(&db.conn, "long"));
        assert!(is_short_note(&db.conn, "missing"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

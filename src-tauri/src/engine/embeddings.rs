//! Local semantic embeddings + HNSW vector search.
//!
//! Uses `fastembed` (ONNX Runtime, 100% local CPU) with the `all-MiniLM-L6-v2`
//! model to produce 384-dimensional embeddings, and `hnsw_rs` for
//! logarithmic-time approximate nearest neighbour search.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use hnsw_rs::prelude::*;
use rusqlite::Connection;

use crate::db::{load_all_embeddings, save_note_embedding, SemanticMatch};

/// Graph construction parameters (accuracy/speed trade-off).
const HNSW_MAX_CONNECTION: usize = 24;
const HNSW_EF_CONSTRUCTION: usize = 200;
const HNSW_EF_SEARCH: usize = 128;

/// Minimum cosine similarity (normalized 0.0..=1.0) for a match to surface in
/// the Related Notes panel. Scores below this are usually noise — but if the
/// threshold filters *everything* out, `search` falls back to raw neighbours
/// so the panel is never silently empty on a small vault.
const MIN_SIMILARITY_SCORE: f32 = 0.15;

/// Number of texts fed to the model per inference pass during backfill.
const BACKFILL_BATCH_SIZE: usize = 16;

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

    /// HNSW search, mapping results back to note ids and cosine similarity
    /// scores, excluding `exclude_note_id`. Returns `top_k` best matches
    /// sorted by descending score.
    fn search(&self, query: &[f32], top_k: usize, exclude_note_id: &str) -> Vec<SemanticMatch> {
        let candidates = self.hnsw.search(query, top_k.max(8) * 4, HNSW_EF_SEARCH);

        let mut best = self.collect_matches(&candidates, exclude_note_id, Some(MIN_SIMILARITY_SCORE));
        // Threshold filtered everything out (small/dissimilar vault): fall back
        // to the raw nearest neighbours so the panel is never empty.
        if best.is_empty() {
            best = self.collect_matches(&candidates, exclude_note_id, None);
        }

        let mut matches: Vec<SemanticMatch> = best
            .into_iter()
            .map(|(note_id, score)| SemanticMatch { note_id, score })
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

/// The semantic engine: shared model (thread-safe inference) + mutable index.
pub struct EmbeddingEngine {
    model: TextEmbedding,
    index: Mutex<EmbeddingIndex>,
}

impl EmbeddingEngine {
    /// Loads the MiniLM model (downloaded to `~/.cerebro/models` on first run,
    /// fully offline afterwards) and rebuilds the HNSW index from SQLite.
    pub fn new(conn: &Connection, cache_dir: PathBuf) -> Result<Self, String> {
        let options = InitOptions {
            model_name: EmbeddingModel::AllMiniLML6V2,
            execution_providers: Default::default(),
            max_length: 512,
            cache_dir,
            show_download_progress: false,
        };

        let model = TextEmbedding::try_new(options).map_err(|e| e.to_string())?;

        let entries = load_all_embeddings(conn)?;
        let index = EmbeddingIndex::from_embeddings(entries);

        Ok(EmbeddingEngine {
            model,
            index: Mutex::new(index),
        })
    }

    /// Generates a 384-dim embedding for `text` (no index lock held during
    /// inference so searches are never blocked by embedding work).
    pub fn generate_embedding(&self, text: &str) -> Result<Vec<f32>, String> {
        let mut embeddings = self
            .model
            .embed(vec![text.to_string()], None)
            .map_err(|e| e.to_string())?;

        embeddings.pop().ok_or_else(|| "Embedding model returned no output.".to_string())
    }

    /// Embeds `content` and persists it to SQLite + the in-memory HNSW graph.
    pub fn generate_and_store(
        &self,
        conn: &Connection,
        note_id: &str,
        content: &str,
    ) -> Result<(), String> {
        let vector = self.generate_embedding(content)?;
        save_note_embedding(conn, note_id, &vector)?;
        self.index.lock().unwrap().upsert(note_id, vector);
        Ok(())
    }

    /// Finds the top-K conceptually related notes for `note_id`.
    pub fn find_related(
        &self,
        conn: &Connection,
        note_id: &str,
        top_k: usize,
    ) -> Result<Vec<SemanticMatch>, String> {
        let query = crate::db::get_note_embedding(conn, note_id)?
            .ok_or_else(|| format!("No embedding stored for note: {note_id}"))?;

        Ok(self.index.lock().unwrap().search(&query, top_k.max(1), note_id))
    }

    /// Embeds and stores many notes in batches. Batching matters on first-run
    /// backfill of a large vault: a single model call processes a whole batch,
    /// so inference happens in a fraction of the one-at-a-time time.
    pub fn backfill(
        &self,
        conn: &Connection,
        pending: Vec<(String, String)>,
    ) -> Result<usize, String> {
        let mut count = 0usize;
        for chunk in pending.chunks(BACKFILL_BATCH_SIZE) {
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

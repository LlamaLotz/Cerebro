//! One-off verification: loads the MiniLM model from the local cache
//! (no network) and checks it produces 384-dim embeddings.
//!
//! Run: `cargo run --example check_model`

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

fn main() {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    let cache_dir = std::path::Path::new(&home).join(".cerebro").join("models");

    let options = InitOptions {
        model_name: EmbeddingModel::AllMiniLML6V2,
        execution_providers: Default::default(),
        max_length: 512,
        cache_dir,
        show_download_progress: false,
    };

    let model = TextEmbedding::try_new(options).expect("model load failed");
    let embeddings = model
        .embed(vec!["Hello world, this is a test note about semantic search."], None)
        .expect("embedding failed");

    let dim = embeddings[0].len();
    assert_eq!(dim, 384, "expected 384-dim embedding");
    println!("OK: model loaded offline, embedding dim = {dim}");
}

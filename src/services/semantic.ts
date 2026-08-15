import { invoke } from '@tauri-apps/api/core';

export interface SemanticMatch {
  note_id: string;
  score: number;
  /** The candidate block that best matched the active note — why this note
   *  was suggested (null when the candidate has no block embeddings). */
  matched_text: string | null;
  matched_block_id: string | null;
}

export interface BlockMatch {
  note_id: string;
  block_id: string;
  text: string;
  score: number;
}

/** Generates and stores a MiniLM embedding for a note (fire-and-forget on save). */
export async function generateAndStoreEmbedding(noteId: string, content: string): Promise<void> {
  try {
    await invoke('generate_and_store_embedding', { noteId, content });
  } catch (err) {
    console.error('Failed to generate embedding:', err);
  }
}

/** Generates and stores block-level embeddings for a note (fire-and-forget). */
export async function generateAndStoreBlockEmbeddings(noteId: string, content: string): Promise<void> {
  try {
    await invoke('generate_and_store_block_embeddings', { noteId, content });
  } catch (err) {
    console.error('Failed to generate block embeddings:', err);
  }
}

/** Returns the top-K conceptually related notes via HNSW vector search. */
export async function findSemanticRelatedNotes(noteId: string, topK: number): Promise<SemanticMatch[]> {
  return await invoke('find_semantic_related_notes', { noteId, topK });
}

/** Returns the top-K semantically matching blocks from other notes. */
export async function findSemanticBlockMatches(noteId: string, topK: number): Promise<BlockMatch[]> {
  return await invoke('find_block_related_notes', { noteId, topK });
}

/** Embeds every note that doesn't have an embedding yet (first-run backfill). */
export async function backfillEmbeddings(): Promise<number> {
  try {
    return await invoke('backfill_embeddings');
  } catch (err) {
    console.error('Embedding backfill failed:', err);
    return 0;
  }
}

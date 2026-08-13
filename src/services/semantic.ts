import { invoke } from '@tauri-apps/api/core';

export interface SemanticMatch {
  note_id: string;
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

/** Returns the top-K conceptually related notes via HNSW vector search. */
export async function findSemanticRelatedNotes(noteId: string, topK: number): Promise<SemanticMatch[]> {
  return await invoke('find_semantic_related_notes', { noteId, topK });
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

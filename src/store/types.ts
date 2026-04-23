import type { Chunk, EmbeddedChunk, SearchHit, GraphEdges, StoreStats, CallGraph } from "../types.js";

export interface ChunkStore {
  /** Write a batch of embedded chunks and the call graph. Derives calledBy edges internally. */
  write(chunks: EmbeddedChunk[], graph: CallGraph): Promise<void>;
  /** Drop all tables. Called before a full re-index. */
  flush(): Promise<void>;
  /** Hybrid vector + FTS search. */
  search(queryVec: number[], query: string, topK: number): Promise<SearchHit[]>;
  /** Look up a chunk by its symbolId. */
  getSymbol(symbolId: string): Promise<Chunk | null>;
  /** Get call graph edges for a symbolId. */
  getGraphEdges(symbolId: string): Promise<GraphEdges>;
  /** Build the full-text search index. Call after write(). */
  buildFtsIndex(): Promise<void>;
  getStats(): Promise<StoreStats>;
  /** Return a random sample of up to `n` chunks (used for benchmark generation). */
  sampleChunks(n: number): Promise<Chunk[]>;
  disconnect(): Promise<void>;
}

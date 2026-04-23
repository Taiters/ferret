export interface Chunk {
  id: string;
  symbolId: string;   // e.g. "src/search.ts:Searcher.search"
  file: string;       // relative to project root
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface EmbeddedChunk extends Chunk {
  vector: number[];
}

export interface SearchHit extends Chunk {
  score: number;
}

export interface GraphEdges {
  calls: string[];    // symbolIds of callees
  calledBy: string[]; // symbolIds of callers
}

// Used by ingestion, indexer, and store
export type CallGraph = Map<string, { calls: string[]; file: string }>;

export interface StoreStats {
  chunks: number;
  graphNodes: number;
}

export interface ProjectMeta {
  path: string;      // absolute path to project root
  name: string;      // basename
  indexedAt: string; // ISO 8601
}

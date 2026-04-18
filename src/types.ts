export interface Chunk {
  id: string;
  file: string;
  category: "code" | "docs" | "git" | "text";
  name: string;
  content: string;
  tags: string[];
  start_line: number;
  end_line: number;
  vector?: number[];
}

export interface GraphEdges {
  calls: string[];
  calledBy: string[];
}

export interface GraphNode {
  calls: string[];
  file: string;
}

export type CallGraph = Map<string, GraphNode>;

export interface IndexOptions {
  gitLimit?: number;
  verbose?: boolean;
  model?: string;
}

export interface SearchOptions {
  topK?: number;
  graph?: boolean;
  model?: string;
  categories?: Array<"code" | "docs" | "text">;
  minScore?: number;
  projectRoot?: string;
}

export interface SearchHit extends Omit<Chunk, "vector"> {
  score: number;
}

export interface StoreStats {
  total: number;
  graphNodes: number;
}

export interface ProjectMeta {
  path: string;      // absolute path to project root
  name: string;      // basename
  indexedAt: string; // ISO 8601
  model: string;     // embedding model used to index
}

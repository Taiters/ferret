import type { CallGraph, Chunk } from "../types.js";

/**
 * What parsers emit: absolute file path, no symbolId.
 * The Indexer converts ParsedChunk → Chunk (relative path + symbolId).
 */
export interface ParsedChunk {
  id: string;
  file: string;    // absolute path
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface ParseResult {
  chunks: ParsedChunk[];
  graph: CallGraph;
}

export interface LanguageParser {
  readonly extensions: readonly string[];

  parse(filePath: string, source: string): ParseResult;

  /**
   * Format a chunk for embedding. chunk.file is already relative to project root.
   * Optional — if absent the indexer uses a default format.
   */
  formatForEmbedding?(chunk: Chunk): string;
}

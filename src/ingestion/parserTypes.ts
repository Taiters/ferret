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
   * Called by the Indexer to format a chunk's content before embedding.
   * chunk.file is relative to project root (already normalized by the Indexer).
   * If absent, the Indexer falls back to its own default formatting.
   */
  formatForEmbedding?(chunk: Chunk): string;
}

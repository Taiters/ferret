import type { Chunk, CallGraph } from "../types.js";

export interface ParseResult {
  chunks: Chunk[];
  graph: CallGraph;
}

export interface LanguageParser {
  readonly extensions: readonly string[];

  parse(filePath: string, source: string): ParseResult;

  /**
   * Format a chunk into the string passed to the embedder.
   * Optional — if absent the registry uses the default format.
   * Override to add language-specific context to the embedding text.
   */
  formatForEmbedding?(chunk: Chunk, relFile: string): string;
}

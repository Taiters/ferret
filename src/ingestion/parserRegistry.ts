import path from "path";
import type { Chunk } from "../types.js";
import type { LanguageParser, ParseResult } from "./parserTypes.js";

export class ParserRegistry {
  private readonly byExtension = new Map<string, LanguageParser>();

  register(parser: LanguageParser): void {
    for (const ext of parser.extensions) {
      const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      this.byExtension.set(normalized, parser);
    }
  }

  get(ext: string): LanguageParser | undefined {
    return this.byExtension.get(ext.toLowerCase());
  }

  registeredExtensions(): string[] {
    return [...this.byExtension.keys()];
  }

  parseFile(filePath: string, source: string): ParseResult {
    const ext = path.extname(filePath).toLowerCase();
    const parser = this.get(ext);
    if (!parser) return { chunks: [], graph: new Map() };
    return parser.parse(filePath, source);
  }

  formatForEmbedding(chunk: Chunk, relFile: string): string {
    const ext = path.extname(chunk.file).toLowerCase();
    const parser = this.get(ext);
    if (parser?.formatForEmbedding) {
      return parser.formatForEmbedding(chunk, relFile);
    }
    const tagLine = chunk.tags.length > 0 ? chunk.tags.join(" ") + "\n" : "";
    return `${relFile}\n${chunk.name}\n${tagLine}${chunk.content}`;
  }
}

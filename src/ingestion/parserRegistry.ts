import path from "path";
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
}

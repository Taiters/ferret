export { chunkPlainText } from "./parserUtils.js";
export type { ParseResult } from "./parserTypes.js";
import { registry } from "./registry.js";
import type { ParseResult } from "./parserTypes.js"; // needed for return type annotation

export function parseFile(filePath: string, sourceCode: string): ParseResult {
  return registry.parseFile(filePath, sourceCode);
}

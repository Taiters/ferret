import Python from "tree-sitter-python";
import { createParser, visitSemanticNodes, buildModuleContextChunk } from "../treeSitterUtils.js";
import type { LanguageParser, ParseResult } from "../parserTypes.js";

const SEMANTIC_NODES = [
  "function_definition",
  "class_definition",
  "decorated_definition",
] as const;

const MODULE_CONTEXT_NODES = [
  "import_statement",
  "import_from_statement",
  "expression_statement",
] as const;

export class PythonParser implements LanguageParser {
  readonly extensions = [".py"] as const;
  private readonly parser = createParser(Python);

  parse(filePath: string, source: string): ParseResult {
    let tree;
    try {
      tree = this.parser.parse(source);
    } catch {
      return { chunks: [], graph: new Map() };
    }

    const { chunks, graph } = visitSemanticNodes(tree.rootNode, SEMANTIC_NODES, filePath, source);
    const ctx = buildModuleContextChunk(tree.rootNode, MODULE_CONTEXT_NODES, SEMANTIC_NODES, filePath, source);
    if (ctx) chunks.push(ctx);
    return { chunks, graph };
  }
}

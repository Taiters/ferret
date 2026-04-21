import TSModule from "tree-sitter-typescript";
import { createParser, visitSemanticNodes, buildModuleContextChunk } from "../treeSitterUtils.js";
import type { LanguageParser, ParseResult } from "../parserTypes.js";

const { typescript } = TSModule;

const SEMANTIC_NODES = [
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "export_statement",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
] as const;

const MODULE_CONTEXT_NODES = [
  "import_declaration",
  "lexical_declaration",
  "variable_declaration",
] as const;

export class TypeScriptParser implements LanguageParser {
  readonly extensions = [".ts"] as const;
  private readonly parser = createParser(typescript);

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

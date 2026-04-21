import Parser from "tree-sitter";
import path from "path";
import type { Chunk, CallGraph } from "../types.js";
import { uid, windowChunk, CHUNK_LINE_LIMIT } from "./parserUtils.js";

export function createParser(language: unknown): Parser {
  const parser = new Parser();
  parser.setLanguage(language as Parameters<Parser["setLanguage"]>[0]);
  return parser;
}

export function extractName(node: Parser.SyntaxNode, source: string): string {
  const nameNode =
    node.childForFieldName("name") ??
    node.children.find((c) => c.type === "identifier");
  if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);
  return "<anonymous>";
}

export function extractCalls(node: Parser.SyntaxNode, source: string): string[] {
  const calls = new Set<string>();

  function walk(n: Parser.SyntaxNode): void {
    if (n.type === "call_expression" || n.type === "call") {
      const fn = n.childForFieldName("function") ?? n.child(0);
      if (fn) {
        const text = source.slice(fn.startIndex, fn.endIndex);
        const base = text.split(".").pop()?.split("(")[0].trim() ?? "";
        if (base && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(base)) calls.add(base);
      }
    }
    for (const child of n.children) walk(child);
  }

  walk(node);
  return [...calls];
}

/**
 * Walk the AST and extract semantic nodes (functions, classes, etc.) as chunks.
 * Each matching node becomes one chunk (or multiple windowed chunks if long).
 * Also builds a call graph for the file.
 */
export function visitSemanticNodes(
  rootNode: Parser.SyntaxNode,
  nodeTypes: readonly string[],
  filePath: string,
  source: string,
): { chunks: Chunk[]; graph: CallGraph } {
  const allLines = source.split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const chunks: Chunk[] = [];
  const graph: CallGraph = new Map();
  const visited = new Set<string>();

  function visit(node: Parser.SyntaxNode): void {
    if (nodeTypes.includes(node.type)) {
      const name = extractName(node, source);
      const startLine = node.startPosition.row; // 0-indexed
      const endLine = node.endPosition.row;
      const lineCount = endLine - startLine + 1;
      const fnLines = allLines.slice(startLine, endLine + 1);
      const key = `${name}@${startLine}`;

      if (!visited.has(key)) {
        visited.add(key);

        const calls = extractCalls(node, source);
        graph.set(name, { calls, file: filePath });

        if (lineCount <= CHUNK_LINE_LIMIT) {
          chunks.push({
            id: uid(filePath, name, startLine),
            file: filePath,
            category: "code",
            name,
            content: fnLines.join("\n"),
            tags: [name, path.basename(filePath), ext.replace(".", "")],
            start_line: startLine + 1, // 1-indexed for display
            end_line: endLine + 1,
          });
        } else {
          chunks.push(...windowChunk(filePath, name, fnLines, startLine + 1));
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(rootNode);
  return { chunks, graph };
}

/**
 * Build a single chunk representing the module-level context of a file:
 * imports, top-level constants/variables, etc.
 * Skips node types already indexed as individual semantic chunks.
 */
export function buildModuleContextChunk(
  rootNode: Parser.SyntaxNode,
  contextNodeTypes: readonly string[],
  semanticNodeTypes: readonly string[],
  filePath: string,
  source: string,
): Chunk | null {
  if (contextNodeTypes.length === 0) return null;

  const allLines = source.split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const semanticSet = new Set(semanticNodeTypes);
  const contextSet = new Set(contextNodeTypes);
  const parts: string[] = [];
  let minLine = Infinity;
  let maxLine = -1;

  for (const child of rootNode.children) {
    if (semanticSet.has(child.type)) continue; // already indexed individually
    if (!contextSet.has(child.type)) continue;

    // For Python expression_statement, only include top-level assignments
    if (child.type === "expression_statement") {
      const inner = child.child(0);
      if (!inner || (inner.type !== "assignment" && inner.type !== "augmented_assignment")) continue;
    }

    const start = child.startPosition.row;
    const end = child.endPosition.row;
    parts.push(allLines.slice(start, end + 1).join("\n"));
    minLine = Math.min(minLine, start);
    maxLine = Math.max(maxLine, end);
  }

  if (parts.length === 0) return null;

  const baseName = path.basename(filePath);
  return {
    id: uid(filePath, "module-context", 0),
    file: filePath,
    category: "code",
    name: `${baseName} [module context]`,
    content: parts.join("\n"),
    tags: [baseName, ext.replace(".", ""), "module-context"],
    start_line: minLine + 1,
    end_line: maxLine + 1,
  };
}

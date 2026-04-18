import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import { typescriptLanguage } from "./tsLanguage.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Chunk, CallGraph } from "../types.js";

const CHUNK_LINE_LIMIT = 150; // functions over this get windowed
const WINDOW_SIZE = 100; // lines per window
const WINDOW_OVERLAP = 20; // overlap between windows

// ── Language setup ────────────────────────────────────────────────────────────

const PARSERS: Record<string, Parser> = {};

function getParser(ext: string): Parser | null {
  if (PARSERS[ext]) return PARSERS[ext];

  const parser = new Parser();
  if (ext === ".py") {
    parser.setLanguage(Python);
  } else if (ext === ".js" || ext === ".jsx" || ext === ".mjs") {
    parser.setLanguage(JavaScript);
  } else if (ext === ".ts" || ext === ".tsx") {
    parser.setLanguage(typescriptLanguage(ext));
  } else {
    return null;
  }
  PARSERS[ext] = parser;
  return parser;
}

// ── Node type lists per language ──────────────────────────────────────────────

const SEMANTIC_NODES: Record<string, string[]> = {
  ".py": ["function_definition", "class_definition", "decorated_definition"],
  ".js": [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "export_statement",
  ],
  ".mjs": [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "export_statement",
  ],
  ".jsx": [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "export_statement",
  ],
  ".ts": [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "export_statement",
  ],
  ".tsx": [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "export_statement",
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(file: string, name: string, start: number): string {
  return crypto.createHash("md5").update(`${file}:${name}:${start}`).digest("hex").slice(0, 12);
}

function extractName(node: Parser.SyntaxNode, source: string): string {
  const nameNode =
    node.childForFieldName("name") ??
    node.children.find((c) => c.type === "identifier");
  if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);
  return "<anonymous>";
}

function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start, end).join("\n");
}

/**
 * Window a long function body into overlapping chunks.
 */
function windowChunk(
  file: string,
  name: string,
  lines: string[],
  startLine: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  while (offset < lines.length) {
    const windowLines = lines.slice(offset, offset + WINDOW_SIZE);
    const absStart = startLine + offset;
    const absEnd = absStart + windowLines.length - 1;
    chunks.push({
      id: uid(file, name, absStart),
      file,
      category: "code",
      name: `${name} [lines ${absStart}-${absEnd}]`,
      content: windowLines.join("\n"),
      tags: [name, path.basename(file), "windowed"],
      start_line: absStart,
      end_line: absEnd,
    });
    if (offset + WINDOW_SIZE >= lines.length) break;
    offset += WINDOW_SIZE - WINDOW_OVERLAP;
  }
  return chunks;
}

// ── Call graph extraction ─────────────────────────────────────────────────────

function extractCalls(node: Parser.SyntaxNode, source: string): string[] {
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

// ── Main parser ───────────────────────────────────────────────────────────────

interface ParseResult {
  chunks: Chunk[];
  graph: CallGraph;
}

/**
 * Parse a source file and return an array of chunks + call graph edges.
 */
export function parseFile(filePath: string, sourceCode: string): ParseResult {
  const ext = path.extname(filePath).toLowerCase();
  const parser = getParser(ext);

  if (!parser) return { chunks: [], graph: new Map() };

  let tree: Parser.Tree;
  try {
    tree = parser.parse(sourceCode);
  } catch {
    return { chunks: [], graph: new Map() };
  }

  const nodeTypes = SEMANTIC_NODES[ext] ?? [];
  const allLines = sourceCode.split("\n");
  const chunks: Chunk[] = [];
  const graph: CallGraph = new Map();
  const visited = new Set<string>();

  function visit(node: Parser.SyntaxNode): void {
    if (nodeTypes.includes(node.type)) {
      const name = extractName(node, sourceCode);
      const startLine = node.startPosition.row; // 0-indexed
      const endLine = node.endPosition.row;
      const lineCount = endLine - startLine + 1;
      const fnLines = allLines.slice(startLine, endLine + 1);
      const key = `${name}@${startLine}`;

      if (!visited.has(key)) {
        visited.add(key);

        const calls = extractCalls(node, sourceCode);
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

  visit(tree.rootNode);
  return { chunks, graph };
}

/**
 * Fallback: plain text chunker for files that can't be parsed semantically.
 */
export function chunkPlainText(
  filePath: string,
  text: string,
  category: Chunk["category"] = "general",
): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let buffer = "";
  let bufStart = 1;
  let lineCount = 1;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;
    if (buffer && lineCount + paraLines > CHUNK_LINE_LIMIT) {
      chunks.push({
        id: uid(filePath, "para", bufStart),
        file: filePath,
        category,
        name: path.basename(filePath),
        content: buffer.trim(),
        tags: [path.basename(filePath), category],
        start_line: bufStart,
        end_line: lineCount,
      });
      buffer = para;
      bufStart = lineCount;
    } else {
      buffer += (buffer ? "\n\n" : "") + para;
    }
    lineCount += paraLines + 1;
  }

  if (buffer.trim()) {
    chunks.push({
      id: uid(filePath, "para", bufStart),
      file: filePath,
      category,
      name: path.basename(filePath),
      content: buffer.trim(),
      tags: [path.basename(filePath), category],
      start_line: bufStart,
      end_line: lineCount,
    });
  }

  return chunks;
}

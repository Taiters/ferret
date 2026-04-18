import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import { typescriptLanguage } from "./tsLanguage.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const CHUNK_LINE_LIMIT = 150;  // functions over this get windowed
const WINDOW_SIZE      = 100;  // lines per window
const WINDOW_OVERLAP   = 20;   // overlap between windows

// ── Language setup ────────────────────────────────────────────────────────────

const PARSERS = {};

function getParser(ext) {
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

const SEMANTIC_NODES = {
  ".py":  ["function_definition", "class_definition", "decorated_definition"],
  ".js":  ["function_declaration", "function_expression", "arrow_function",
           "method_definition", "class_declaration", "export_statement"],
  ".mjs": ["function_declaration", "function_expression", "arrow_function",
           "method_definition", "class_declaration", "export_statement"],
  ".jsx": ["function_declaration", "function_expression", "arrow_function",
           "method_definition", "class_declaration", "export_statement"],
  ".ts":  ["function_declaration", "function_expression", "arrow_function",
           "method_definition", "class_declaration", "export_statement"],
  ".tsx": ["function_declaration", "function_expression", "arrow_function",
           "method_definition", "class_declaration", "export_statement"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(file, name, start) {
  return crypto.createHash("md5").update(`${file}:${name}:${start}`).digest("hex").slice(0, 12);
}

function extractName(node, source) {
  // Try common name-child patterns
  const nameNode =
    node.childForFieldName?.("name") ||
    node.children?.find((c) => c.type === "identifier");
  if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);
  return `<anonymous>`;
}

function linesOf(source) {
  return source.split("\n");
}

function sliceLines(lines, start, end) {
  return lines.slice(start, end).join("\n");
}

/**
 * Window a long function body into overlapping chunks.
 */
function windowChunk(file, name, lines, startLine) {
  const chunks = [];
  let offset = 0;
  while (offset < lines.length) {
    const windowLines = lines.slice(offset, offset + WINDOW_SIZE);
    const absStart = startLine + offset;
    const absEnd   = absStart + windowLines.length - 1;
    chunks.push({
      id:         uid(file, name, absStart),
      file,
      category:   "code",
      name:       `${name} [lines ${absStart}-${absEnd}]`,
      content:    windowLines.join("\n"),
      tags:       [name, path.basename(file), "windowed"],
      start_line: absStart,
      end_line:   absEnd,
    });
    if (offset + WINDOW_SIZE >= lines.length) break;
    offset += WINDOW_SIZE - WINDOW_OVERLAP;
  }
  return chunks;
}

// ── Call graph extraction ─────────────────────────────────────────────────────

function extractCalls(node, source) {
  const calls = new Set();

  function walk(n) {
    if (n.type === "call_expression" || n.type === "call") {
      const fn = n.childForFieldName?.("function") || n.child(0);
      if (fn) {
        const text = source.slice(fn.startIndex, fn.endIndex);
        // Strip member access to get the base function name
        const base = text.split(".").pop().split("(")[0].trim();
        if (base && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(base)) calls.add(base);
      }
    }
    for (const child of n.children || []) walk(child);
  }

  walk(node);
  return [...calls];
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse a source file and return an array of chunks + call graph edges.
 * Returns: { chunks: Chunk[], graph: Map<name, {calls, file}> }
 */
export function parseFile(filePath, sourceCode) {
  const ext = path.extname(filePath).toLowerCase();
  const parser = getParser(ext);

  if (!parser) return { chunks: [], graph: new Map() };

  let tree;
  try {
    tree = parser.parse(sourceCode);
  } catch {
    return { chunks: [], graph: new Map() };
  }

  const nodeTypes = SEMANTIC_NODES[ext] || [];
  const allLines  = linesOf(sourceCode);
  const chunks    = [];
  const graph     = new Map(); // fnName → { calls: string[], file: string }
  const visited   = new Set();

  function visit(node, parentName = null) {
    if (nodeTypes.includes(node.type)) {
      const name      = extractName(node, sourceCode);
      const startLine = node.startPosition.row;       // 0-indexed
      const endLine   = node.endPosition.row;
      const lineCount = endLine - startLine + 1;
      const fnLines   = allLines.slice(startLine, endLine + 1);
      const key       = `${name}@${startLine}`;

      if (!visited.has(key)) {
        visited.add(key);

        // Call graph
        const calls = extractCalls(node, sourceCode);
        graph.set(name, { calls, file: filePath });

        if (lineCount <= CHUNK_LINE_LIMIT) {
          // Single chunk
          chunks.push({
            id:         uid(filePath, name, startLine),
            file:       filePath,
            category:   "code",
            name,
            content:    fnLines.join("\n"),
            tags:       [name, path.basename(filePath), ext.replace(".", "")],
            start_line: startLine + 1, // 1-indexed for display
            end_line:   endLine   + 1,
          });
        } else {
          // Hybrid: window long function
          const windowed = windowChunk(filePath, name, fnLines, startLine + 1);
          chunks.push(...windowed);
        }
      }
    }

    for (const child of node.children || []) {
      visit(child, node.type);
    }
  }

  visit(tree.rootNode);
  return { chunks, graph };
}

/**
 * Fallback: plain text chunker for files that can't be parsed semantically.
 * Splits on blank lines, windows if too long.
 */
export function chunkPlainText(filePath, text, category = "general") {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let buffer = "";
  let bufStart = 1;
  let lineCount = 1;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;
    if (buffer && lineCount + paraLines > CHUNK_LINE_LIMIT) {
      chunks.push({
        id:         uid(filePath, "para", bufStart),
        file:       filePath,
        category,
        name:       path.basename(filePath),
        content:    buffer.trim(),
        tags:       [path.basename(filePath), category],
        start_line: bufStart,
        end_line:   lineCount,
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
      id:         uid(filePath, "para", bufStart),
      file:       filePath,
      category,
      name:       path.basename(filePath),
      content:    buffer.trim(),
      tags:       [path.basename(filePath), category],
      start_line: bufStart,
      end_line:   lineCount,
    });
  }

  return chunks;
}

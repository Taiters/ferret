# Ferret Architecture Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor ferret into a module-per-concern architecture with pluggable interfaces for embedding, ranking, selection, and storage, scoped to code search only.

**Architecture:** New sub-directories `src/embedding/`, `src/ranking/`, `src/store/`, `src/indexer/`, `src/search/` each expose an interface + default implementation. `Indexer` and `Searcher` classes take their dependencies as constructor arguments. `ferret.ts` handles only CLI argument parsing and wiring.

**Tech Stack:** TypeScript (ES2022, NodeNext modules), LanceDB (`@lancedb/lancedb`), `@huggingface/transformers`, Commander.js, vitest

---

## File Map

**Created:**
- `src/embedding/types.ts` — `Embedder` interface
- `src/embedding/huggingface.ts` — HuggingFace implementation (replaces `src/embedder.ts`)
- `src/embedding/index.ts`
- `src/ranking/types.ts` — `Ranker`, `Selector` interfaces
- `src/ranking/crossEncoder.ts` — cross-encoder reranker (replaces `src/reranker.ts`)
- `src/ranking/mmr.ts` — MMR-style selector
- `src/ranking/index.ts`
- `src/store/types.ts` — `ChunkStore` interface
- `src/store/lancedb.ts` — LanceDB implementation (replaces `src/store.ts`)
- `src/store/index.ts`
- `src/indexer/indexer.ts` — `Indexer` class (replaces `src/indexer.ts`)
- `src/indexer/index.ts`
- `src/search/searcher.ts` — `Searcher` class (replaces `src/search.ts`)
- `src/search/index.ts`
- `tests/ranking/mmr.test.ts`
- `tests/search/searcher.test.ts`
- `tests/indexer/indexer.test.ts`
- `vitest.config.ts`

**Modified:**
- `src/types.ts` — new `Chunk` shape, add `CallGraph`, remove old types
- `src/ingestion/parserTypes.ts` — introduce `ParsedChunk`, update `ParseResult` and `LanguageParser`
- `src/ingestion/parserUtils.ts` — update `windowChunk` and `chunkPlainText` to use `ParsedChunk`
- `src/ingestion/treeSitterUtils.ts` — update chunk construction to use `ParsedChunk` fields
- `src/ingestion/parserRegistry.ts` — remove `formatForEmbedding` method
- `src/ferret.ts` — new CLI commands, updated wiring
- `package.json` — add vitest dev dependency and test script

**Deleted** (in final task):
- `src/embedder.ts`
- `src/reranker.ts`
- `src/store.ts`
- `src/indexer.ts`
- `src/search.ts`
- `src/ingestion/markdown.ts`
- `src/ingestion/git.ts`

---

## Task 1: Set up vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add test scripts to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Create tests directory structure**

```bash
mkdir -p tests/ranking tests/search tests/indexer
```

- [ ] **Step 5: Verify vitest runs (no tests yet)**

```bash
npm test
```

Expected: `No test files found` or exit 0 (no failures).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json tests/
git commit -m "chore: add vitest test framework"
```

---

## Task 2: Update types.ts and ingestion layer

**Note:** `types.ts` is imported by all ingestion files. This task updates both together so the build passes at the end. Do not commit until all steps in this task are complete.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/ingestion/parserTypes.ts`
- Modify: `src/ingestion/parserUtils.ts`
- Modify: `src/ingestion/treeSitterUtils.ts`
- Modify: `src/ingestion/parserRegistry.ts`

- [ ] **Step 1: Replace src/types.ts**

```typescript
export interface Chunk {
  id: string;
  symbolId: string;   // e.g. "src/search.ts:Searcher.search"
  file: string;       // relative to project root
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface EmbeddedChunk extends Chunk {
  vector: number[];
}

export interface SearchHit extends Chunk {
  score: number;
}

export interface GraphEdges {
  calls: string[];    // symbolIds of callees
  calledBy: string[]; // symbolIds of callers
}

// Used by ingestion, indexer, and store
export type CallGraph = Map<string, { calls: string[]; file: string }>;

export interface StoreStats {
  chunks: number;
  graphNodes: number;
}
```

- [ ] **Step 2: Replace src/ingestion/parserTypes.ts**

Introduce `ParsedChunk` (what parsers emit — no `symbolId`, absolute `file` path) and update `ParseResult` and `LanguageParser` to use it:

```typescript
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
   * Format a chunk for embedding. chunk.file is already relative to project root.
   * Optional — if absent the indexer uses a default format.
   */
  formatForEmbedding?(chunk: Chunk): string;
}
```

- [ ] **Step 3: Replace src/ingestion/parserUtils.ts**

Remove `category`, `tags`, rename `start_line`/`end_line`, remove `category` param from `chunkPlainText`:

```typescript
import crypto from "crypto";
import path from "path";
import type { ParsedChunk } from "./parserTypes.js";

export const CHUNK_LINE_LIMIT = 150;
export const WINDOW_SIZE = 100;
export const WINDOW_OVERLAP = 20;

export function uid(file: string, name: string, start: number): string {
  return crypto.createHash("md5").update(`${file}:${name}:${start}`).digest("hex").slice(0, 12);
}

export function windowChunk(
  file: string,
  name: string,
  lines: string[],
  startLine: number,
): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let offset = 0;
  while (offset < lines.length) {
    const windowLines = lines.slice(offset, offset + WINDOW_SIZE);
    const absStart = startLine + offset;
    const absEnd = absStart + windowLines.length - 1;
    chunks.push({
      id: uid(file, name, absStart),
      file,
      name: `${name} [lines ${absStart}-${absEnd}]`,
      content: windowLines.join("\n"),
      startLine: absStart,
      endLine: absEnd,
    });
    if (offset + WINDOW_SIZE >= lines.length) break;
    offset += WINDOW_SIZE - WINDOW_OVERLAP;
  }
  return chunks;
}

export function chunkPlainText(filePath: string, text: string): ParsedChunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: ParsedChunk[] = [];
  let buffer = "";
  let bufStart = 1;
  let lineCount = 1;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;
    if (buffer && lineCount + paraLines > CHUNK_LINE_LIMIT) {
      chunks.push({
        id: uid(filePath, "para", bufStart),
        file: filePath,
        name: path.basename(filePath),
        content: buffer.trim(),
        startLine: bufStart,
        endLine: lineCount,
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
      name: path.basename(filePath),
      content: buffer.trim(),
      startLine: bufStart,
      endLine: lineCount,
    });
  }

  return chunks;
}
```

- [ ] **Step 4: Replace src/ingestion/treeSitterUtils.ts**

Remove `category`, `tags`, rename fields, return `ParsedChunk[]`:

```typescript
import Parser from "tree-sitter";
import path from "path";
import type { CallGraph } from "../types.js";
import type { ParsedChunk } from "./parserTypes.js";
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

export function visitSemanticNodes(
  rootNode: Parser.SyntaxNode,
  nodeTypes: readonly string[],
  filePath: string,
  source: string,
): { chunks: ParsedChunk[]; graph: CallGraph } {
  const allLines = source.split("\n");
  const chunks: ParsedChunk[] = [];
  const graph: CallGraph = new Map();
  const visited = new Set<string>();

  function visit(node: Parser.SyntaxNode): void {
    if (nodeTypes.includes(node.type)) {
      const name = extractName(node, source);
      const startLine = node.startPosition.row;
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
            name,
            content: fnLines.join("\n"),
            startLine: startLine + 1,
            endLine: endLine + 1,
          });
        } else {
          chunks.push(...windowChunk(filePath, name, fnLines, startLine + 1));
        }
      }
    }

    for (const child of node.children) visit(child);
  }

  visit(rootNode);
  return { chunks, graph };
}

export function buildModuleContextChunk(
  rootNode: Parser.SyntaxNode,
  contextNodeTypes: readonly string[],
  semanticNodeTypes: readonly string[],
  filePath: string,
  source: string,
): ParsedChunk | null {
  if (contextNodeTypes.length === 0) return null;

  const allLines = source.split("\n");
  const semanticSet = new Set(semanticNodeTypes);
  const contextSet = new Set(contextNodeTypes);
  const parts: string[] = [];
  let minLine = Infinity;
  let maxLine = -1;

  for (const child of rootNode.children) {
    if (semanticSet.has(child.type)) continue;
    if (!contextSet.has(child.type)) continue;

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
    name: `${baseName} [module context]`,
    content: parts.join("\n"),
    startLine: minLine + 1,
    endLine: maxLine + 1,
  };
}
```

- [ ] **Step 5: Update src/ingestion/parserRegistry.ts**

Remove `formatForEmbedding` (it moves to the indexer). Keep `get`, `registeredExtensions`, `parseFile`:

```typescript
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
```

- [ ] **Step 6: Verify build passes**

```bash
npm run build
```

Expected: compilation succeeds. Note: `src/indexer.ts`, `src/search.ts`, `src/store.ts`, `src/embedder.ts`, `src/reranker.ts` will have type errors at this point (they reference old `Chunk` fields like `category`, `start_line`). That is expected — they will be replaced in subsequent tasks, not fixed in place.

If the build fails on files *other* than those five plus the ingestion files you just changed, fix those before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/ingestion/parserTypes.ts src/ingestion/parserUtils.ts src/ingestion/treeSitterUtils.ts src/ingestion/parserRegistry.ts
git commit -m "refactor: update Chunk shape — symbolId, camelCase fields, ParsedChunk in ingestion"
```

---

## Task 3: Create embedding module

**Files:**
- Create: `src/embedding/types.ts`
- Create: `src/embedding/huggingface.ts`
- Create: `src/embedding/index.ts`

- [ ] **Step 1: Write src/embedding/types.ts**

```typescript
export interface Embedder {
  embed(text: string): Promise<number[]>;
}
```

- [ ] **Step 2: Write src/embedding/huggingface.ts**

This is `src/embedder.ts` rewritten as a class implementing `Embedder`. The module-level singleton is now instance state:

```typescript
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import os from "os";
import type { Embedder } from "./types.js";

env.cacheDir = path.join(os.homedir(), ".cache", "ferret");
env.allowLocalModels = false;

export const DEFAULT_MODEL = "Xenova/all-mpnet-base-v2";
const MAX_TOKENS_CAP = 32_768;
const CHARS_PER_TOKEN = 4;

export class HuggingFaceEmbedder implements Embedder {
  private readonly modelName: string;
  private _pipeline: FeatureExtractionPipeline | null = null;
  private maxChars = MAX_TOKENS_CAP * CHARS_PER_TOKEN;

  constructor(model = DEFAULT_MODEL) {
    this.modelName = model;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (this._pipeline) return this._pipeline;
    process.stderr.write(`Loading embedding model ${this.modelName}...\n`);

    const fileOrder: string[] = [];
    const fileProgress = new Map<string, string>();

    function redrawProgress() {
      if (fileOrder.length === 0) return;
      if (fileOrder.length > 1) process.stderr.write(`\x1b[${fileOrder.length - 1}A`);
      for (const f of fileOrder) process.stderr.write(`\r${fileProgress.get(f)!}\x1b[K\n`);
    }

    const embedder = await pipeline("feature-extraction", this.modelName, {
      dtype: "q8",
      progress_callback: (event: any) => {
        if (event.status === "progress" && typeof event.progress === "number") {
          const file = (event.file as string).split("/").pop() ?? event.name;
          const pct = event.progress.toFixed(1).padStart(5);
          const mb = event.total ? ` (${(event.total / 1_048_576).toFixed(1)} MB)` : "";
          if (!fileProgress.has(file)) fileOrder.push(file);
          fileProgress.set(file, `  ${file}${mb} ${pct}%`);
          redrawProgress();
        }
      },
    });

    this._pipeline = embedder;
    const rawMax: number = (embedder as any).tokenizer?.model_max_length ?? MAX_TOKENS_CAP;
    const maxTokens = Math.min(rawMax, MAX_TOKENS_CAP);
    this.maxChars = maxTokens * CHARS_PER_TOKEN;
    process.stderr.write(`Model ready. Context: ${maxTokens} tokens\n`);
    return this._pipeline;
  }

  async embed(text: string): Promise<number[]> {
    const embedder = await this.getPipeline();
    const output = await embedder(text.slice(0, this.maxChars), {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }
}
```

- [ ] **Step 3: Write src/embedding/index.ts**

```typescript
export type { Embedder } from "./types.js";
export { HuggingFaceEmbedder, DEFAULT_MODEL } from "./huggingface.js";
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: `src/embedding/` compiles cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/
git commit -m "feat: extract embedding module with Embedder interface and HuggingFaceEmbedder"
```

---

## Task 4: Create ranking module

**Files:**
- Create: `src/ranking/types.ts`
- Create: `src/ranking/crossEncoder.ts`
- Create: `src/ranking/mmr.ts`
- Create: `src/ranking/index.ts`
- Create: `tests/ranking/mmr.test.ts`

- [ ] **Step 1: Write the failing MMR test**

Create `tests/ranking/mmr.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { MmrSelector } from "../../src/ranking/mmr.js";
import type { SearchHit } from "../../src/types.js";

function makeHit(id: string, score: number): SearchHit {
  return { id, score, symbolId: `file.ts:${id}`, file: "file.ts", name: id, content: "", startLine: 0, endLine: 0 };
}

describe("MmrSelector", () => {
  test("returns top k hits ordered by score", () => {
    const selector = new MmrSelector();
    const hits = [makeHit("c", 0.5), makeHit("a", 0.9), makeHit("b", 0.7)];
    const result = selector.select(hits, 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  test("returns all hits when k >= hits.length", () => {
    const selector = new MmrSelector();
    const hits = [makeHit("a", 0.9)];
    expect(selector.select(hits, 5)).toHaveLength(1);
  });

  test("returns empty array for empty input", () => {
    const selector = new MmrSelector();
    expect(selector.select([], 5)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test tests/ranking/mmr.test.ts
```

Expected: FAIL — `Cannot find module '../../src/ranking/mmr.js'`

- [ ] **Step 3: Write src/ranking/types.ts**

```typescript
import type { SearchHit } from "../types.js";

export interface Ranker {
  rank(query: string, hits: SearchHit[]): Promise<SearchHit[]>;
}

export interface Selector {
  select(hits: SearchHit[], k: number): SearchHit[];
}
```

- [ ] **Step 4: Write src/ranking/mmr.ts**

Implements `Selector`. Without vectors on `SearchHit`, selection is score-based. The MMR structure is preserved so vector-based diversity can be added later if vectors are made available.

```typescript
import type { SearchHit } from "../types.js";
import type { Selector } from "./types.js";

const MMR_LAMBDA = 0.7;

export class MmrSelector implements Selector {
  select(hits: SearchHit[], k: number): SearchHit[] {
    if (hits.length === 0) return [];
    // Sort descending by score; MMR lambda * score with no vector penalty
    // is equivalent to top-k. Structure retained for future vector diversity.
    return [...hits]
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test tests/ranking/mmr.test.ts
```

Expected: PASS

- [ ] **Step 6: Write src/ranking/crossEncoder.ts**

This is `src/reranker.ts` rewritten as a class implementing `Ranker`:

```typescript
import { pipeline, type TextClassificationPipeline } from "@huggingface/transformers";
import type { SearchHit } from "../types.js";
import type { Ranker } from "./types.js";

export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

export class CrossEncoderRanker implements Ranker {
  private readonly modelName: string;
  private _pipeline: TextClassificationPipeline | null = null;

  constructor(model = DEFAULT_RERANK_MODEL) {
    this.modelName = model;
  }

  private async getPipeline(): Promise<TextClassificationPipeline> {
    if (this._pipeline) return this._pipeline;
    process.stderr.write(`Loading reranker model ${this.modelName}...\n`);
    const p = await pipeline("text-classification", this.modelName, { dtype: "q8" });
    this._pipeline = p as TextClassificationPipeline;
    process.stderr.write(`Reranker ready.\n`);
    return this._pipeline;
  }

  async rank(query: string, hits: SearchHit[]): Promise<SearchHit[]> {
    if (hits.length === 0) return hits;
    const reranker = await this.getPipeline();
    const inputs = hits.map((h) => `${query} [SEP] ${h.content.slice(0, 4000)}`);
    const outputs = await reranker(inputs);
    const scores = (Array.isArray(outputs) ? outputs : [outputs]) as Array<{ label: string; score: number }>;
    return hits
      .map((hit, i) => ({ hit, rerankScore: scores[i]?.score ?? 0 }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .map(({ hit }) => hit);
  }
}
```

- [ ] **Step 7: Write src/ranking/index.ts**

```typescript
export type { Ranker, Selector } from "./types.js";
export { CrossEncoderRanker, DEFAULT_RERANK_MODEL } from "./crossEncoder.js";
export { MmrSelector } from "./mmr.js";
```

- [ ] **Step 8: Verify full build and tests**

```bash
npm run build && npm test
```

Expected: build passes, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/ranking/ tests/ranking/
git commit -m "feat: extract ranking module with Ranker/Selector interfaces, CrossEncoderRanker, MmrSelector"
```

---

## Task 5: Create store module

**Files:**
- Create: `src/store/types.ts`
- Create: `src/store/lancedb.ts`
- Create: `src/store/index.ts`

- [ ] **Step 1: Write src/store/types.ts**

```typescript
import type { Chunk, EmbeddedChunk, SearchHit, GraphEdges, StoreStats, CallGraph } from "../types.js";

export interface ChunkStore {
  /** Write a batch of embedded chunks and the call graph. Derives calledBy edges internally. */
  write(chunks: EmbeddedChunk[], graph: CallGraph): Promise<void>;
  /** Drop all tables. Called before a full re-index. */
  flush(): Promise<void>;
  /** Hybrid vector + FTS search. */
  search(queryVec: number[], query: string, topK: number): Promise<SearchHit[]>;
  /** Look up a chunk by its symbolId. */
  getSymbol(symbolId: string): Promise<Chunk | null>;
  /** Get call graph edges for a symbolId. */
  getGraphEdges(symbolId: string): Promise<GraphEdges>;
  /** Build the full-text search index. Call after write(). */
  buildFtsIndex(): Promise<void>;
  getStats(): Promise<StoreStats>;
  disconnect(): Promise<void>;
}
```

- [ ] **Step 2: Write src/store/lancedb.ts**

This is `src/store.ts` rewritten to implement `ChunkStore`. Key schema changes: remove `category`/`tags` columns, add `symbol_id`, rename `start_line`/`end_line`, graph table keyed by `symbol_id`. The `write` method handles batch insert and call graph inversion.

```typescript
import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import fs from "fs";
import type { Chunk, EmbeddedChunk, SearchHit, GraphEdges, StoreStats, CallGraph } from "../types.js";
import type { ChunkStore } from "./types.js";

const CHUNKS_TABLE = "chunks";
const GRAPH_TABLE = "graph";
const RRF_K = 60;

export class LanceDbStore implements ChunkStore {
  private readonly dbPath: string;
  private _db: Connection | null = null;
  private _chunksTable: Table | null = null;
  private _graphTable: Table | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async getDb(): Promise<Connection> {
    if (this._db) return this._db;
    fs.mkdirSync(this.dbPath, { recursive: true });
    this._db = await lancedb.connect(this.dbPath);
    return this._db;
  }

  private async openChunksTable(): Promise<Table | null> {
    if (this._chunksTable) return this._chunksTable;
    const db = await this.getDb();
    const names = await db.tableNames();
    if (!names.includes(CHUNKS_TABLE)) return null;
    this._chunksTable = await db.openTable(CHUNKS_TABLE);
    return this._chunksTable;
  }

  private async openGraphTable(): Promise<Table | null> {
    if (this._graphTable) return this._graphTable;
    const db = await this.getDb();
    const names = await db.tableNames();
    if (!names.includes(GRAPH_TABLE)) return null;
    this._graphTable = await db.openTable(GRAPH_TABLE);
    return this._graphTable;
  }

  async flush(): Promise<void> {
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(CHUNKS_TABLE)) await db.dropTable(CHUNKS_TABLE);
    if (names.includes(GRAPH_TABLE)) await db.dropTable(GRAPH_TABLE);
    this._chunksTable = null;
    this._graphTable = null;
  }

  async write(chunks: EmbeddedChunk[], graph: CallGraph): Promise<void> {
    if (chunks.length === 0) return;
    const db = await this.getDb();

    // ── Write chunks ──────────────────────────────────────────────────────────
    const rows = chunks.map((c) => ({
      id: c.id,
      symbol_id: c.symbolId,
      file: c.file,
      name: c.name,
      content: c.content,
      start_line: c.startLine,
      end_line: c.endLine,
      vector: Array.from(c.vector),
    }));

    const tableNames = await db.tableNames();
    if (tableNames.includes(CHUNKS_TABLE)) {
      this._chunksTable = await db.openTable(CHUNKS_TABLE);
      await this._chunksTable.add(rows);
    } else {
      this._chunksTable = await db.createTable(CHUNKS_TABLE, rows);
    }

    // ── Write graph (invert calledBy here) ───────────────────────────────────
    // The Indexer normalizes graph file paths to relative before calling write(),
    // so graph[name].file matches chunk.file directly.
    // Build name+file → symbolId lookup for resolving callee names.
    const fileNameToSymbolId = new Map<string, string>(); // key: "relFile:name"
    const nameToSymbolId = new Map<string, string>();     // key: name (first occurrence wins)
    for (const chunk of chunks) {
      fileNameToSymbolId.set(`${chunk.file}:${chunk.name}`, chunk.symbolId);
      if (!nameToSymbolId.has(chunk.name)) nameToSymbolId.set(chunk.name, chunk.symbolId);
    }

    function resolveSymbolId(name: string, relFile?: string): string {
      if (relFile) return fileNameToSymbolId.get(`${relFile}:${name}`) ?? nameToSymbolId.get(name) ?? name;
      return nameToSymbolId.get(name) ?? name;
    }

    // Build calledBy inverse map
    const calledByMap = new Map<string, Set<string>>();
    for (const [callerName, { calls, file }] of graph) {
      const callerSymbolId = resolveSymbolId(callerName, file);
      for (const callee of calls) {
        const calleeSymbolId = resolveSymbolId(callee);
        if (!calledByMap.has(calleeSymbolId)) calledByMap.set(calleeSymbolId, new Set());
        calledByMap.get(calleeSymbolId)!.add(callerSymbolId);
      }
    }

    const graphRows: Array<{ symbol_id: string; calls: string; called_by: string }> = [];
    for (const [callerName, { calls, file }] of graph) {
      const callerSymbolId = resolveSymbolId(callerName, file);
      const resolvedCalls = calls.map((c) => resolveSymbolId(c));
      const calledBy = [...(calledByMap.get(callerSymbolId) ?? [])];
      graphRows.push({
        symbol_id: callerSymbolId,
        calls: resolvedCalls.join("|"),
        called_by: calledBy.join("|"),
      });
    }

    if (graphRows.length > 0) {
      if (tableNames.includes(GRAPH_TABLE)) {
        this._graphTable = await db.openTable(GRAPH_TABLE);
        await this._graphTable.add(graphRows);
      } else {
        this._graphTable = await db.createTable(GRAPH_TABLE, graphRows);
      }
    }
  }

  async buildFtsIndex(): Promise<void> {
    const table = await this.openChunksTable();
    if (!table) return;
    await table.createIndex("content", {
      config: Index.fts({ withPosition: false }),
      replace: true,
    });
  }

  private async ftsSearch(query: string, topK: number): Promise<Array<{ id: string; rank: number }>> {
    const table = await this.openChunksTable();
    if (!table) return [];
    try {
      const results = await table
        .query()
        .fullTextSearch(query, { columns: "content" })
        .select(["id"])
        .limit(topK)
        .toArray();
      return results.map((row, i) => ({ id: row.id as string, rank: i + 1 }));
    } catch {
      return [];
    }
  }

  async search(queryVec: number[], query: string, topK = 6): Promise<SearchHit[]> {
    const table = await this.openChunksTable();
    if (!table) return [];

    const fetchK = Math.max(topK * 3, 20);

    const [vectorRows, ftsRanks] = await Promise.all([
      table.vectorSearch(new Float32Array(queryVec)).distanceType("cosine").limit(fetchK).toArray(),
      this.ftsSearch(query, fetchK),
    ]);

    const vectorRankMap = new Map<string, number>(vectorRows.map((row, i) => [row.id as string, i + 1]));
    const ftsRankMap = new Map<string, number>(ftsRanks.map(({ id, rank }) => [id, rank]));

    const allIds = new Set([...vectorRankMap.keys(), ...ftsRankMap.keys()]);
    const rrfScores = new Map<string, number>();
    for (const id of allIds) {
      let score = 0;
      const vRank = vectorRankMap.get(id);
      const fRank = ftsRankMap.get(id);
      if (vRank !== undefined) score += 1 / (RRF_K + vRank);
      if (fRank !== undefined) score += 1 / (RRF_K + fRank);
      rrfScores.set(id, (score * RRF_K) / 2);
    }

    const rowById = new Map<string, Record<string, unknown>>(
      vectorRows.map((r) => [r.id as string, r as Record<string, unknown>]),
    );

    const ftsOnlyIds = [...allIds].filter((id) => !rowById.has(id));
    if (ftsOnlyIds.length > 0) {
      const placeholders = ftsOnlyIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      const extra = await table
        .query()
        .where(`id IN (${placeholders})`)
        .select(["id", "symbol_id", "file", "name", "content", "start_line", "end_line"])
        .toArray();
      for (const row of extra) rowById.set(row.id as string, row as Record<string, unknown>);
    }

    const sorted = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);

    return sorted
      .map(([id, score]) => {
        const row = rowById.get(id);
        if (!row) return null;
        return {
          id,
          symbolId: row.symbol_id as string,
          file: row.file as string,
          name: row.name as string,
          content: row.content as string,
          startLine: row.start_line as number,
          endLine: row.end_line as number,
          score,
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
  }

  async getSymbol(symbolId: string): Promise<Chunk | null> {
    const table = await this.openChunksTable();
    if (!table) return null;
    const results = await table
      .query()
      .where(`symbol_id = '${symbolId.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray();
    if (results.length === 0) return null;
    const row = results[0];
    return {
      id: row.id as string,
      symbolId: row.symbol_id as string,
      file: row.file as string,
      name: row.name as string,
      content: row.content as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
    };
  }

  async getGraphEdges(symbolId: string): Promise<GraphEdges> {
    const table = await this.openGraphTable();
    if (!table) return { calls: [], calledBy: [] };
    const results = await table
      .query()
      .where(`symbol_id = '${symbolId.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray();
    if (results.length === 0) return { calls: [], calledBy: [] };
    const row = results[0];
    return {
      calls: row.calls ? (row.calls as string).split("|").filter(Boolean) : [],
      calledBy: row.called_by ? (row.called_by as string).split("|").filter(Boolean) : [],
    };
  }

  async getStats(): Promise<StoreStats> {
    try {
      const chunksTable = await this.openChunksTable();
      const graphTable = await this.openGraphTable();
      return {
        chunks: chunksTable ? await chunksTable.countRows() : 0,
        graphNodes: graphTable ? await graphTable.countRows() : 0,
      };
    } catch {
      return { chunks: 0, graphNodes: 0 };
    }
  }

  async disconnect(): Promise<void> {
    this._chunksTable = null;
    this._graphTable = null;
    this._db = null;
  }
}
```

- [ ] **Step 3: Write src/store/index.ts**

```typescript
export type { ChunkStore } from "./types.js";
export { LanceDbStore } from "./lancedb.js";
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: `src/store/` compiles cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/store/
git commit -m "feat: extract store module with ChunkStore interface and LanceDbStore"
```

---

## Task 6: Create indexer module

**Files:**
- Create: `src/indexer/indexer.ts`
- Create: `src/indexer/index.ts`
- Create: `tests/indexer/indexer.test.ts`

- [ ] **Step 1: Write the failing indexer test**

Create `tests/indexer/indexer.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import type { ChunkStore } from "../../src/store/types.js";
import type { ParserRegistry } from "../../src/ingestion/parserRegistry.js";

// Minimal mock implementations
const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

const mockStore: ChunkStore = {
  flush: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  buildFtsIndex: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  getSymbol: vi.fn().mockResolvedValue(null),
  getGraphEdges: vi.fn().mockResolvedValue({ calls: [], calledBy: [] }),
  getStats: vi.fn().mockResolvedValue({ chunks: 0, graphNodes: 0 }),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

describe("Indexer", () => {
  beforeEach(() => vi.clearAllMocks());

  test("flushes the store before indexing", async () => {
    // Dynamic import after mocks are set up
    const { Indexer } = await import("../../src/indexer/indexer.js");
    const indexer = new Indexer(mockEmbedder, mockStore, {} as ParserRegistry);
    // index() will fail to discover files in a fake path, that's OK —
    // we only care that flush was the first store call.
    await indexer.index("/tmp").catch(() => {});
    expect(mockStore.flush).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test tests/indexer/indexer.test.ts
```

Expected: FAIL — `Cannot find module '../../src/indexer/indexer.js'`

- [ ] **Step 3: Write src/indexer/indexer.ts**

```typescript
import { glob } from "glob";
import fs from "fs";
import path from "path";
import type { Embedder } from "../embedding/types.js";
import type { ChunkStore } from "../store/types.js";
import type { ParserRegistry } from "../ingestion/parserRegistry.js";
import { chunkPlainText } from "../ingestion/parserUtils.js";
import { registerProject, writeProjectConfig } from "../projects.js";
import type { Chunk, EmbeddedChunk, CallGraph } from "../types.js";

export interface IndexOptions {
  verbose?: boolean;
}

const IGNORE_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/__pycache__/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/*.egg-info/**",
  "**/.ferret/**",
];

const IGNORE_FILES = [
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/*.pb",
  "**/*.pyc",
  "**/*.pyo",
];

const MAX_FILE_BYTES = 500_000;

function progress(label: string, current: number, total: number): void {
  const pct = Math.round((current / total) * 100);
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  ${label} [${bar}] ${pct}% (${current}/${total})`);
  if (current === total) process.stdout.write("\n");
}

function formatForEmbedding(chunk: Chunk, parsers: ParserRegistry): string {
  const ext = path.extname(chunk.file).toLowerCase();
  const parser = parsers.get(ext);
  if (parser?.formatForEmbedding) return parser.formatForEmbedding(chunk);
  return `${chunk.file}\n${chunk.name}\n${chunk.content}`;
}

export class Indexer {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: ChunkStore,
    private readonly parsers: ParserRegistry,
  ) {}

  async index(projectPath: string, opts: IndexOptions = {}): Promise<void> {
    const absPath = path.resolve(projectPath);
    console.log(`\n📂 Indexing: ${absPath}\n`);

    await this.store.flush();

    const files = await this.discoverFiles(absPath, opts);
    const { chunks, graph } = this.parseAll(files, absPath, opts);

    console.log(`\n  🧠 Embedding ${chunks.length} chunks...`);
    const embedded = await this.embedChunks(chunks);

    // Normalize graph file paths to relative before writing
    const relGraph: CallGraph = new Map();
    for (const [name, { calls, file }] of graph) {
      relGraph.set(name, { calls, file: path.relative(absPath, file) });
    }

    console.log("\n  💾 Storing chunks...");
    await this.store.write(embedded, relGraph);

    console.log("\n  🔍 Building full-text search index...");
    await this.store.buildFtsIndex();

    const indexedAt = new Date().toISOString();
    writeProjectConfig(absPath, { indexedAt });
    registerProject(absPath);

    console.log("\n  ✅ Done!\n");
    console.log(`  Indexed ${chunks.length} chunks\n`);
  }

  private async discoverFiles(absPath: string, opts: IndexOptions): Promise<string[]> {
    const allFiles = await glob("**/*", {
      cwd: absPath,
      nodir: true,
      ignore: [...IGNORE_DIRS, ...IGNORE_FILES],
      absolute: true,
    });
    const CODE_EXTS = new Set(this.parsers.registeredExtensions());
    const codeFiles = allFiles.filter((f) => CODE_EXTS.has(path.extname(f).toLowerCase()));
    if (opts.verbose) {
      const skipped = allFiles.filter((f) => !CODE_EXTS.has(path.extname(f).toLowerCase()));
      for (const f of skipped) console.log(`    skip: ${path.relative(absPath, f)}`);
    }
    console.log(`  Found: ${codeFiles.length} code files\n`);
    return codeFiles;
  }

  private parseAll(
    files: string[],
    projectRoot: string,
    opts: IndexOptions,
  ): { chunks: Chunk[]; graph: CallGraph } {
    const allChunks: Chunk[] = [];
    const graph: CallGraph = new Map();

    console.log("  📄 Parsing code files...");
    for (let i = 0; i < files.length; i++) {
      progress("parse", i + 1, files.length);
      const file = files[i];
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) {
        if (opts.verbose) console.log(`\n    skip (too large): ${file}`);
        continue;
      }

      const source = fs.readFileSync(file, "utf8");
      const relFile = path.relative(projectRoot, file);
      const result = this.parsers.parseFile(file, source);

      const parsedChunks = result.chunks.length > 0 ? result.chunks : chunkPlainText(file, source);

      for (const pc of parsedChunks) {
        allChunks.push({
          id: pc.id,
          symbolId: `${relFile}:${pc.name}`,
          file: relFile,
          name: pc.name,
          content: pc.content,
          startLine: pc.startLine,
          endLine: pc.endLine,
        });
      }

      for (const [name, data] of result.graph) {
        if (!graph.has(name)) graph.set(name, data);
      }
    }

    return { chunks: allChunks, graph };
  }

  private async embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    const results: EmbeddedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      progress("embed", i + 1, chunks.length);
      const vector = await this.embedder.embed(formatForEmbedding(chunks[i], this.parsers));
      results.push({ ...chunks[i], vector });
    }
    return results;
  }
}
```

- [ ] **Step 4: Write src/indexer/index.ts**

```typescript
export type { IndexOptions } from "./indexer.js";
export { Indexer } from "./indexer.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test tests/indexer/indexer.test.ts
```

Expected: PASS

- [ ] **Step 6: Verify build**

```bash
npm run build
```

Expected: `src/indexer/` compiles cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/indexer/ tests/indexer/
git commit -m "feat: extract indexer module with Indexer class"
```

---

## Task 7: Create search module

**Files:**
- Create: `src/search/searcher.ts`
- Create: `src/search/index.ts`
- Create: `tests/search/searcher.test.ts`

- [ ] **Step 1: Write the failing searcher test**

Create `tests/search/searcher.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import type { ChunkStore } from "../../src/store/types.js";
import type { Ranker, Selector } from "../../src/ranking/types.js";
import type { SearchHit } from "../../src/types.js";

function makeHit(id: string, score: number): SearchHit {
  return { id, score, symbolId: `file.ts:${id}`, file: "file.ts", name: id, content: "code", startLine: 1, endLine: 5 };
}

const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

const mockStore: Pick<ChunkStore, "search"> = {
  search: vi.fn().mockResolvedValue([makeHit("a", 0.9), makeHit("b", 0.5)]),
};

const mockRanker: Ranker = {
  rank: vi.fn().mockImplementation((_q, hits) => Promise.resolve(hits)),
};

const mockSelector: Selector = {
  select: vi.fn().mockImplementation((hits, k) => hits.slice(0, k)),
};

describe("Searcher", () => {
  beforeEach(() => vi.clearAllMocks());

  test("embeds query, retrieves candidates, ranks and selects", async () => {
    const { Searcher } = await import("../../src/search/searcher.js");
    const searcher = new Searcher(mockEmbedder, mockStore as ChunkStore, mockRanker, mockSelector);
    const results = await searcher.search("some query", 6);

    expect(mockEmbedder.embed).toHaveBeenCalledWith("some query");
    expect(mockStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], "some query", 12);
    expect(mockRanker.rank).toHaveBeenCalled();
    expect(mockSelector.select).toHaveBeenCalledWith(expect.any(Array), 6);
    expect(results).toHaveLength(2);
  });

  test("filters hits below minScore before ranking", async () => {
    const lowScoreStore: Pick<ChunkStore, "search"> = {
      search: vi.fn().mockResolvedValue([makeHit("a", 0.3), makeHit("b", 0.8)]),
    };
    const { Searcher } = await import("../../src/search/searcher.js");
    const searcher = new Searcher(mockEmbedder, lowScoreStore as ChunkStore, mockRanker, mockSelector);
    await searcher.search("query", 6, 0.5);

    // Only hit "b" (score 0.8) should reach the ranker
    const rankCall = (mockRanker.rank as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rankCall[1]).toHaveLength(1);
    expect(rankCall[1][0].id).toBe("b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test tests/search/searcher.test.ts
```

Expected: FAIL — `Cannot find module '../../src/search/searcher.js'`

- [ ] **Step 3: Write src/search/searcher.ts**

```typescript
import type { Embedder } from "../embedding/types.js";
import type { ChunkStore } from "../store/types.js";
import type { Ranker, Selector } from "../ranking/types.js";
import type { SearchHit } from "../types.js";

export class Searcher {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: ChunkStore,
    private readonly ranker: Ranker,
    private readonly selector: Selector,
  ) {}

  async search(query: string, topK = 6, minScore = 0): Promise<SearchHit[]> {
    const queryVec = await this.embedder.embed(query);
    const candidates = await this.store.search(queryVec, query, topK * 2);
    const filtered = candidates.filter((h) => h.score >= minScore);
    const ranked = await this.ranker.rank(query, filtered);
    return this.selector.select(ranked, topK);
  }
}
```

- [ ] **Step 4: Write src/search/index.ts**

```typescript
export { Searcher } from "./searcher.js";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test tests/search/searcher.test.ts
```

Expected: PASS

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Verify build**

```bash
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/search/ tests/search/
git commit -m "feat: extract search module with Searcher class"
```

---

## Task 8: Update ferret.ts CLI

**Files:**
- Modify: `src/ferret.ts`

Replace the entire file. Changes: new wiring using the new modules; remove `history` command; update `graph` to accept symbolId; add `symbol` command; remove `--all`, `--graph`, `--category` flags; keep `--project` on `search`, `symbol`, `graph`, `stats`.

- [ ] **Step 1: Replace src/ferret.ts**

```typescript
#!/usr/bin/env node
import path from "path";
import fs from "fs";
import { Command } from "commander";
import { HuggingFaceEmbedder } from "./embedding/index.js";
import { CrossEncoderRanker, MmrSelector } from "./ranking/index.js";
import { LanceDbStore } from "./store/index.js";
import { Indexer } from "./indexer/index.js";
import { Searcher } from "./search/index.js";
import { registry } from "./ingestion/registry.js";
import type { SearchHit } from "./types.js";
import {
  localDbPath,
  resolveProjectFromCwd,
  readRegistry,
  registerProject,
  readProjectConfig,
} from "./projects.js";

const program = new Command();

program
  .name("ferret")
  .description("Semantic codebase search for Claude Code")
  .version("1.0.0");

function resolveDbPath(explicitProjectPath?: string): string {
  if (explicitProjectPath) return localDbPath(path.resolve(explicitProjectPath));
  const detected = resolveProjectFromCwd();
  if (detected) return localDbPath(detected);
  throw new Error(
    "No indexed project found in the current directory tree.\n" +
      "Run: ferret index <path>\n" +
      "Or specify: --project <path>",
  );
}

function resolveProjectRoot(explicitProjectPath?: string): string {
  if (explicitProjectPath) return path.resolve(explicitProjectPath);
  return resolveProjectFromCwd() ?? process.cwd();
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatHits(hits: SearchHit[], query: string): string {
  const lines = [
    `SEARCH: "${query}"`,
    `Found ${hits.length} result(s)`,
    "─".repeat(60),
  ];
  for (const hit of hits) {
    lines.push(`\n${hit.symbolId}  (lines ${hit.startLine}–${hit.endLine})`);
    lines.push("```");
    lines.push(hit.content.length > 1500 ? hit.content.slice(0, 1500) + "\n... [truncated]" : hit.content);
    lines.push("```");
  }
  return lines.join("\n");
}

// ── ferret index <path> ───────────────────────────────────────────────────────
program
  .command("index <path>")
  .description("Index a codebase")
  .option("-v, --verbose", "Show skipped files")
  .option("--gitignore", "Create .ferret/.gitignore to exclude db/")
  .action(async (projectPath: string, opts: { verbose?: boolean; gitignore?: boolean }) => {
    const absPath = path.resolve(projectPath);
    const store = new LanceDbStore(localDbPath(absPath));
    const embedder = new HuggingFaceEmbedder();
    const indexer = new Indexer(embedder, store, registry);
    try {
      await indexer.index(absPath, { verbose: opts.verbose });
      if (opts.gitignore) {
        const gitignorePath = path.join(absPath, ".ferret", ".gitignore");
        fs.writeFileSync(gitignorePath, "db/\n");
        console.log("  Created .ferret/.gitignore");
      }
    } catch (e) {
      console.error("Indexing failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret search <query> ─────────────────────────────────────────────────────
program
  .command("search <query>")
  .description("Semantic search across indexed code")
  .option("-k, --top-k <n>", "Number of results", "6")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .option("--min-score <n>", "Minimum relevance score 0–1", "0")
  .action(async (query: string, opts: { topK: string; project?: string; minScore: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    const embedder = new HuggingFaceEmbedder();
    const searcher = new Searcher(embedder, store, new CrossEncoderRanker(), new MmrSelector());
    try {
      const hits = await searcher.search(query, parseInt(opts.topK), parseFloat(opts.minScore));
      console.log(formatHits(hits, query));
    } catch (e) {
      console.error("Search failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret symbol <symbolId> ──────────────────────────────────────────────────
program
  .command("symbol <symbolId>")
  .description("Look up a symbol by its ID (e.g. src/search.ts:Searcher.search)")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (symbolId: string, opts: { project?: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    try {
      const chunk = await store.getSymbol(symbolId);
      if (!chunk) {
        console.log(`Symbol not found: "${symbolId}"`);
        console.log("Re-index and try again, or check the symbol ID format (e.g. src/file.ts:functionName)");
        process.exit(1);
      }
      console.log(`\n${chunk.symbolId}  (lines ${chunk.startLine}–${chunk.endLine})`);
      console.log(`File: ${chunk.file}`);
      console.log("```");
      console.log(chunk.content);
      console.log("```");
    } catch (e) {
      console.error("Symbol lookup failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret graph <symbolId> ───────────────────────────────────────────────────
program
  .command("graph <symbolId>")
  .description("Show call graph around a symbol")
  .option("-d, --depth <n>", "Graph traversal depth", "2")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (symbolId: string, opts: { depth: string; project?: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    const depth = parseInt(opts.depth);
    try {
      const visited = new Set<string>();
      const lines = [`CALL GRAPH: ${symbolId}`, "─".repeat(60)];

      async function walk(id: string, indent: number, d: number): Promise<void> {
        if (visited.has(id) || d > depth) return;
        visited.add(id);
        const edges = await store.getGraphEdges(id);
        lines.push(`${"  ".repeat(indent)}${indent === 0 ? "◉" : "→"} ${id}`);
        if (edges.calledBy.length && indent === 0) {
          lines.push(`${"  ".repeat(indent + 1)}← called by: ${edges.calledBy.join(", ")}`);
        }
        for (const callee of edges.calls) await walk(callee, indent + 1, d + 1);
      }

      await walk(symbolId, 0, 0);

      if (lines.length === 2) {
        console.log(`No graph data found for "${symbolId}". Ensure the codebase is indexed.`);
      } else {
        console.log(lines.join("\n"));
      }
    } catch (e) {
      console.error("Graph failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret stats ──────────────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show index statistics")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (opts: { project?: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    try {
      const { chunks, graphNodes } = await store.getStats();
      console.log("\nFerret Stats");
      console.log("──────────────────");
      console.log(`Chunks      : ${chunks}`);
      console.log(`Graph nodes : ${graphNodes}`);
      console.log();
    } catch (e) {
      console.error("Stats failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret register [path] ────────────────────────────────────────────────────
program
  .command("register [path]")
  .description("Register an existing indexed project")
  .action((projectPath?: string) => {
    const absPath = projectPath ? path.resolve(projectPath) : process.cwd();
    const dbPath = localDbPath(absPath);
    if (!fs.existsSync(dbPath)) {
      console.error(`No index found at ${dbPath}`);
      console.error("Run: ferret index <path>");
      process.exit(1);
    }
    registerProject(absPath);
    console.log(`Registered: ${absPath}`);
    if (!readProjectConfig(absPath)) console.log("  (no index-info.json found)");
  });

// ── ferret projects ───────────────────────────────────────────────────────────
program
  .command("projects")
  .description("List all indexed projects")
  .action(() => {
    const projects = readRegistry();
    if (projects.length === 0) {
      console.log("No projects indexed yet. Run: ferret index <path>");
      return;
    }
    console.log("\nIndexed Projects");
    console.log("────────────────");
    for (const p of projects) {
      const age = formatRelativeTime(p.indexedAt);
      console.log(`  ${p.name.padEnd(24)} ${p.path}`);
      console.log(`  ${"".padEnd(24)} indexed ${age}\n`);
    }
  });

program.parse();
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: full build passes. There will still be errors from the old files (`src/indexer.ts`, `src/search.ts`, `src/store.ts`, `src/embedder.ts`, `src/reranker.ts`) — these are deleted in the next task.

If there are errors in `src/ferret.ts` itself, fix them before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/ferret.ts
git commit -m "feat: update CLI with symbol command, symbolId-based graph, remove history/--all/--category"
```

---

## Task 9: Delete old files and verify

**Files:**
- Delete: `src/embedder.ts`, `src/reranker.ts`, `src/store.ts`, `src/indexer.ts`, `src/search.ts`
- Delete: `src/ingestion/markdown.ts`, `src/ingestion/git.ts`

- [ ] **Step 1: Delete replaced source files**

```bash
git rm src/embedder.ts src/reranker.ts src/store.ts src/indexer.ts src/search.ts
git rm src/ingestion/markdown.ts src/ingestion/git.ts
```

- [ ] **Step 2: Verify clean build**

```bash
npm run build
```

Expected: zero errors. If there are any remaining imports of the deleted files, trace them and fix before continuing.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Smoke test the CLI**

```bash
node dist/ferret.js --help
node dist/ferret.js search --help
node dist/ferret.js symbol --help
node dist/ferret.js graph --help
```

Expected: all commands listed with correct flags. Verify:
- `search` has `-k`, `--min-score`, `--project` but NOT `--graph`, `--category`, `--all`
- `graph` has `--depth`, `--project`
- `symbol` has `--project`
- `stats` has `--project` but NOT `--all`
- No `history` command listed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove replaced files (embedder, reranker, store, indexer, search, markdown, git ingestion)"
```

---

## Task 10: Final integration verification

- [ ] **Step 1: Run a full index + search cycle**

```bash
node dist/ferret.js index . --verbose
```

Expected: progress output, "✅ Done!" at the end.

```bash
node dist/ferret.js search "embedding pipeline"
```

Expected: formatted search results showing symbolIds in the format `src/embedding/huggingface.ts:HuggingFaceEmbedder.embed`.

```bash
node dist/ferret.js symbol "src/search/searcher.ts:Searcher.search"
```

Expected: source code of the `search` method printed with line numbers.

```bash
node dist/ferret.js graph "src/search/searcher.ts:Searcher.search"
```

Expected: call graph showing what `Searcher.search` calls.

```bash
node dist/ferret.js stats
```

Expected: chunk count and graph node count.

- [ ] **Step 2: Run full test suite one final time**

```bash
npm run build && npm test
```

Expected: zero errors, all tests pass.

- [ ] **Step 3: Commit**

If the index verification produced any fixes, commit them now:

```bash
git add -A
git commit -m "chore: final integration verification fixes"
```

If no fixes were needed, no commit required.

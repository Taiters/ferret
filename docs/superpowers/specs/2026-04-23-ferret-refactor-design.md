# Ferret Refactor Design

**Date:** 2026-04-23

## Goal

Refactor ferret into a more maintainable, pluggable architecture. Scope the tool to code search only (remove docs and git history ingestion). Introduce clean interfaces for swappable pipeline stages (embedding, ranking, selection, storage). Restructure the flat `src/` layout into focused sub-directories.

## CLI Commands (end state)

| Command | Description |
|---|---|
| `ferret index <path>` | Index a codebase |
| `ferret search "<query>"` | Semantic search |
| `ferret symbol "<symbolId>"` | Look up a specific symbol by ID |
| `ferret graph "<symbolId>"` | Show call graph for a symbol |
| `ferret stats` | Show index statistics |
| `ferret projects` | List indexed projects |
| `ferret register [path]` | Register an existing index |

Removed: `ferret history`, `--git-limit`, `--all`, `--graph` (on search), `--category`.

Added: `--project <path>` on `search`, `symbol`, `graph`, `stats` — allows targeting a specific project explicitly (useful for LLM callers).

## Folder Structure

```
src/
  types.ts          # Shared domain types
  ferret.ts         # CLI entry point — wiring only, no logic

  ingestion/        # Unchanged — parser registry + language impls
  projects/         # Unchanged — registry, path resolution

  embedding/
    types.ts        # Embedder interface
    huggingface.ts  # HuggingFace implementation
    index.ts

  ranking/
    types.ts        # Ranker + Selector interfaces
    crossEncoder.ts # Cross-encoder reranker (implements Ranker)
    mmr.ts          # MMR selection (implements Selector)
    index.ts

  store/
    types.ts        # ChunkStore interface
    lancedb.ts      # LanceDB implementation
    index.ts

  indexer/
    indexer.ts      # Indexer class
    index.ts

  search/
    searcher.ts     # Searcher class
    index.ts
```

## Core Types

```typescript
// src/types.ts

export interface Chunk {
  id: string;         // MD5 hash — deduplication key
  symbolId: string;   // e.g. "src/search.ts:Searcher.search"
  file: string;       // relative to project root
  name: string;       // symbol name
  content: string;
  startLine: number;
  endLine: number;
}

export interface EmbeddedChunk extends Chunk {
  vector: number[];   // internal to pipeline — not exposed to CLI
}

export interface SearchHit extends Chunk {
  score: number;
}

export interface GraphEdges {
  calls: string[];    // symbolIds of callees
  calledBy: string[]; // symbolIds of callers
}

export interface StoreStats {
  chunks: number;
  graphNodes: number;
}

// Used by ingestion, indexer, and store — lives here rather than ingestion/
export type CallGraph = Map<string, { calls: string[]; file: string }>;
```

**Symbol ID format:** `<relPath>:<symbolName>`, where relPath is relative to the project root. Class methods use `<relPath>:<ClassName>.<methodName>`. Symbol IDs are assigned by the indexer (not the parser) — parsers emit `name`, the indexer combines it with the relative file path.

**`CallGraph`** crosses multiple module boundaries (ingestion → indexer → store), so it lives in `types.ts`. The store is responsible for inverting call edges into `calledBy` when writing.

Removed from types: `category`, `tags`, `vector?` on Chunk, `expandedVia` on SearchHit, `GraphNode`, `ProjectMeta` (moves to `projects/`), git/docs-related variants.

## Interfaces

```typescript
// embedding/types.ts
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

// ranking/types.ts
export interface Ranker {
  rank(query: string, hits: SearchHit[]): Promise<SearchHit[]>;
}

export interface Selector {
  select(hits: SearchHit[], k: number): SearchHit[];
}

// store/types.ts
export interface ChunkStore {
  write(chunks: EmbeddedChunk[], graph: CallGraph): Promise<void>;
  flush(): Promise<void>;
  search(queryVec: number[], query: string, topK: number): Promise<SearchHit[]>;
  getSymbol(symbolId: string): Promise<Chunk | null>;
  getGraphEdges(symbolId: string): Promise<GraphEdges>;
  buildFtsIndex(): Promise<void>;
  getStats(): Promise<StoreStats>;
  disconnect(): Promise<void>;
}
```

Notes:
- `Selector.select` is sync — MMR is pure vector math
- `Ranker` takes the query string because cross-encoders score `(query, chunk)` pairs
- `ChunkStore.write` takes `CallGraph` and is responsible for deriving `calledBy` edges internally
- `buildFtsIndex` is called explicitly by the indexer after all chunks are written

## Indexer

```typescript
// indexer/indexer.ts
export class Indexer {
  constructor(
    private embedder: Embedder,
    private store: ChunkStore,
    private parsers: ParserRegistry,
  ) {}

  async index(projectPath: string, opts: IndexOptions = {}): Promise<void> {
    await this.store.flush();
    const files = await discoverFiles(projectPath, opts);
    const { chunks, graph } = parseAll(files, this.parsers, projectPath);
    const embedded = await this.embedChunks(chunks);
    await this.store.write(embedded, graph);
    await this.store.buildFtsIndex();
  }

  private async embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    const results: EmbeddedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      progress("embed", i + 1, chunks.length);
      const vector = await this.embedder.embed(formatForEmbedding(chunks[i]));
      results.push({ ...chunks[i], vector });
    }
    return results;
  }
}
```

`discoverFiles` and `parseAll` are module-level functions in `indexer/indexer.ts`. `formatForEmbedding` moves from the parser registry into a utility in `indexer/` since it is an indexing concern.

## Searcher

```typescript
// search/searcher.ts
export class Searcher {
  constructor(
    private embedder: Embedder,
    private store: ChunkStore,
    private ranker: Ranker,
    private selector: Selector,
  ) {}

  async search(query: string, topK = 6, minScore = 0): Promise<SearchHit[]> {
    const queryVec = await this.embedder.embed(query);
    const candidates = await this.store.search(queryVec, query, topK * 2);
    const filtered = candidates.filter(h => h.score >= minScore);
    const ranked = await this.ranker.rank(query, filtered);
    return this.selector.select(ranked, topK);
  }
}
```

Graph expansion logic (currently in `search.ts`) is removed entirely. Users can follow up with `ferret graph <symbolId>` if they want graph context.

## CLI Wiring

`ferret.ts` is responsible only for parsing CLI arguments and wiring implementations:

```typescript
const embedder = new HuggingFaceEmbedder();
const store = new LanceDbStore(dbPath);
const searcher = new Searcher(embedder, store, new CrossEncoderRanker(), new MmrSelector());
const indexer = new Indexer(embedder, store, registry);
```

No business logic lives in `ferret.ts`.

## What Is Removed

- `ferret history` command and all git ingestion (`ingestion/git.ts`, `ingestion/markdown.ts`)
- `--git-limit` flag on `ferret index`
- `--all` flag on `ferret search` and `ferret stats`
- `--graph` flag on `ferret search`
- `--category` flag on `ferret search`
- Graph expansion in the search pipeline (`expandWithGraph` in `search.ts`)
- `category` and `tags` fields on `Chunk`
- `docs`, `git`, `text` chunk categories

## Incremental Indexing (Future)

The design is structured to support incremental indexing later without further restructuring:
- `Chunk.id` (MD5) enables deduplication
- `ChunkStore.write` can be changed to upsert rather than replace
- `Indexer` can be extended to diff discovered files against the stored index

This is out of scope for this refactor.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A semantic codebase search tool for Claude Code. It indexes codebases into a local LanceDB vector store and exposes a `ferret` CLI for semantic search and call graph queries. The `SKILL.md` file is copied into other projects' `.claude/skills/` so Claude Code there can query this indexed codebase.

## Prerequisites & Setup

- Node.js 18+
- Install CLI: `npm install && npm run build && npm link`
- Index DB is stored at `<project>/.ferret/db` (inside each indexed project). Registry is at `~/.local/share/ferret/registry.json`. No external services required.

## CLI Commands

```bash
ferret index <path>                        # Index a codebase (full re-index, clears previous)
ferret index <path> --verbose              # Show skipped files
ferret index <path> --gitignore            # Create .ferret/.gitignore to exclude db/
ferret search "<query>"                    # Semantic search
ferret search "<query>" -k 10             # More results (default 6)
ferret search "<query>" --min-score 0.5    # Filter by minimum relevance score (0–1)
ferret search "<query>" -p <path>          # Explicit project path (overrides CWD detection)
ferret symbol <symbolId>                   # Look up a symbol by ID (e.g. src/search.ts:Searcher.search)
ferret graph <symbolId>                    # Call graph around a symbol
ferret graph <symbolId> --depth 3          # Deeper call traversal (default: 2)
ferret stats                               # Chunk count + graph node count
ferret projects                            # List all indexed projects
ferret register [path]                     # Register an existing indexed project in the registry
ferret benchmark generate                  # Sample chunks and generate eval questions via Anthropic API
ferret benchmark run                       # Evaluate search quality against generated benchmark
```

## Architecture

The project is TypeScript (`src/`) compiled to `dist/` via `tsc`. Source uses ES modules (`"type": "module"`).

**Source layout**:
```
src/
  types.ts              # Shared interfaces (Chunk, EmbeddedChunk, SearchHit, GraphEdges, etc.)
  ferret.ts             # CLI entry point (Commander.js)
  projects.ts           # Project registry, DB path resolution, CWD detection
  embedding/
    huggingface.ts      # Local embeddings via @huggingface/transformers (all-mpnet-base-v2)
    types.ts            # Embedder interface
  indexer/
    indexer.ts          # Indexing pipeline orchestrator
  ingestion/
    parser.ts           # Tree-sitter base parser + call graph builder
    parserRegistry.ts   # Registry mapping file extensions to parsers
    parserTypes.ts      # LanguageParser interface, ParseResult type
    parserUtils.ts      # Shared helpers (plain-text chunking, windowing)
    registry.ts         # Registers JS/TS/TSX/Python parsers
    treeSitterUtils.ts  # Tree-sitter grammar loader utilities
    parsers/
      javascriptParser.ts
      typescriptParser.ts
      typescriptXParser.ts
      pythonParser.ts
  ranking/
    crossEncoder.ts     # Cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2)
    mmr.ts              # MMR selector for result diversity
    types.ts            # Ranker and Selector interfaces
  search/
    searcher.ts         # Semantic search: embed → KNN → rerank → MMR select
  store/
    lancedb.ts          # LanceDB embedded vector store (chunks + graph tables)
    types.ts            # ChunkStore interface
  benchmark/
    generator.ts        # LLM-powered eval question generation via Anthropic API
    runner.ts           # Benchmark execution against a Searcher
    types.ts            # Benchmark types
dist/                   # Compiled output (gitignored)
```

**Build**: `npm run build` (runs `tsc`). `npm run build:watch` for development.
**Tests**: `npm test` (vitest).

**Indexing pipeline** (`indexer/indexer.ts` orchestrates):
1. File discovery via glob; ignores node_modules, dist, lock files, .ferret/, files >500KB
2. Code parsing via `ParserRegistry`: tree-sitter extracts functions/classes for JS/TS/TSX/Python; call graph built simultaneously; unknown file types fall back to plain-text windowing
3. Embedding: `HuggingFaceEmbedder` uses Xenova/all-mpnet-base-v2, cached at `~/.cache/huggingface/`. First run downloads ~400MB.
4. Storage: `LanceDbStore` writes `chunks` table (vectors + FTS index) and `graph` table. DB lives at `<project>/.ferret/db`.

**Search pipeline** (`search/searcher.ts`):
- Embed query → KNN over `chunks` (2× topK candidates) → `CrossEncoderRanker` reranks → `MmrSelector` selects final topK

**Project registry** (`projects.ts`): tracks indexed projects at `~/.local/share/ferret/registry.json`. CWD detection walks up the directory tree looking for `.ferret/db`.

## Key Design Decisions

- All embeddings are local (offline, private) — no external API calls for indexing/search
- Search pipeline: KNN → cross-encoder rerank → MMR selection (three-stage)
- Full re-index on every `ferret index` run (no incremental updates)
- Parsers are registered via `ParserRegistry`; adding a new language = new `LanguageParser` implementation
- `SKILL.md` is the artifact installed into other projects — changes here affect how Claude Code behaves in those projects

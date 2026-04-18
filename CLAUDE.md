# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A semantic memory system for Claude Code. It indexes codebases into a local LanceDB vector store and exposes a `memory` CLI for semantic search and call graph queries. The `SKILL.md` file is copied into other projects' `.claude/skills/` so Claude Code there can query this indexed memory.

## Prerequisites & Setup

- Node.js 18+
- Install CLI: `npm install && npm run build && npm link`
- Data is stored at `~/.local/share/memory-skill/db` (override with `MEMORY_DB_PATH` env var). No external services required.

## CLI Commands

```bash
memory index <path>                        # Index a codebase (full re-index, clears previous)
memory index <path> --git-limit 200        # Ingest more git history
memory index <path> --verbose              # Show skipped files
memory search "<query>"                    # Semantic search
memory search "<query>" --graph            # Search + call graph context
memory search "<query>" -k 10             # More results (default 6)
memory graph "<function>"                  # Call graph for a function
memory graph "<function>" --depth 3        # Deeper call traversal
memory stats                               # Chunk count + breakdown by category
```

## Architecture

The project is TypeScript (`src/`) compiled to `dist/` via `tsc`. Source uses ES modules (`"type": "module"`).

**Source layout**:
```
src/
  types.ts              # Shared interfaces (Chunk, GraphEdges, etc.)
  memory.ts             # CLI entry point (Commander.js)
  indexer.ts            # Indexing pipeline orchestrator
  embedder.ts           # Local embeddings via @huggingface/transformers
  search.ts             # Semantic search + call graph queries
  store.ts              # LanceDB embedded vector store (file-based)
  ingestion/
    parser.ts           # Tree-sitter code parser + call graph builder
    markdown.ts         # Heading-based markdown chunker
    git.ts              # Git history ingestion
    tsLanguage.ts       # TypeScript grammar resolver
dist/                   # Compiled output (gitignored)
```

**Build**: `npm run build` (runs `tsc`). `npm run build:watch` for development.

**Indexing pipeline** (`indexer.ts` orchestrates):
1. File discovery via glob with ignore lists (node_modules, dist, lock files, files >500KB)
2. Code parsing (`ingestion/parser.ts`): tree-sitter extracts functions/classes for Python/JS/TS; long functions (>150 lines) are windowed with 100-line windows + 20-line overlap; call graph built simultaneously
3. Markdown parsing (`ingestion/markdown.ts`): splits by headings (h1-h4) with same windowing
4. Git history (`ingestion/git.ts`): batches of 10 commits, up to 100 by default
5. Embedding (`embedder.ts`): Xenova/all-MiniLM-L6-v2 via @huggingface/transformers, 384 dimensions, truncates to 2000 chars, cached at `~/.cache/memory-skill/`
6. Storage (`store.ts`): LanceDB `chunks` table for vectors, `graph` table for call graph adjacency

**Search** (`search.ts`): KNN vector search with 30% similarity threshold, optional call graph enrichment.

**CLI entry point**: `dist/memory.js` (compiled from `src/memory.ts`) using Commander.js.

## Key Design Decisions

- All embeddings are local (offline, private) — no external API calls for indexing/search
- Full re-index on every `memory index` run (no incremental updates)
- Chunk IDs are MD5-based for deduplication
- `SKILL.md` is the artifact installed into other projects — changes here affect how Claude Code behaves in those projects

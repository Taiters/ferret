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
ferret index <path> --git-limit 200        # Ingest more git history (default: 50)
ferret index <path> --verbose              # Show skipped files
ferret index <path> --gitignore            # Create .ferret/.gitignore to exclude db/
ferret search "<query>"                    # Semantic search (default category: code)
ferret search "<query>" --graph            # Search + call graph context
ferret search "<query>" -k 10             # More results (default 6)
ferret search "<query>" --category docs    # Search docs category (repeatable)
ferret search "<query>" --min-score 0.5    # Filter by minimum relevance score (0–1)
ferret search "<query>" --all              # Search across all indexed projects
ferret history "<query>"                   # Search git history for related commits
ferret history "<query>" --file <path>     # Filter to commits touching a specific file
ferret history "<query>" -k 10            # More history results (default 6)
ferret graph "<function>"                  # Call graph for a function
ferret graph "<function>" --depth 3        # Deeper call traversal (default: 2)
ferret stats                               # Chunk count + breakdown by category
ferret stats --all                         # Stats for all indexed projects
ferret projects                            # List all indexed projects
ferret register [path]                     # Register an existing indexed project in the registry
```

## Architecture

The project is TypeScript (`src/`) compiled to `dist/` via `tsc`. Source uses ES modules (`"type": "module"`).

**Source layout**:
```
src/
  types.ts              # Shared interfaces (Chunk, GraphEdges, etc.)
  ferret.ts             # CLI entry point (Commander.js)
  indexer.ts            # Indexing pipeline orchestrator
  embedder.ts           # Local embeddings via @huggingface/transformers
  search.ts             # Semantic search + call graph queries
  store.ts              # LanceDB embedded vector store (file-based)
  projects.ts           # Project registry, DB path resolution, CWD detection
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
4. Git history (`ingestion/git.ts`): batches of 10 commits, up to 50 by default
5. Embedding (`embedder.ts`): Xenova/all-mpnet-base-v2 via @huggingface/transformers, cached at `~/.cache/ferret/`. First run downloads the model (~400MB); subsequent runs use the cache.
6. Storage (`store.ts`): LanceDB `chunks` table for vectors, `graph` table for call graph adjacency. DB lives at `<project>/.ferret/db`.

**Project registry** (`projects.ts`): tracks indexed projects at `~/.local/share/ferret/registry.json`. CWD detection walks up the directory tree looking for `.ferret/db`.

**Search** (`search.ts`): KNN vector search, optional call graph enrichment. `ferret history` uses a separate `searchHistory` function that filters to the `history` category.

**CLI entry point**: `dist/ferret.js` (compiled from `src/ferret.ts`) using Commander.js.

## Key Design Decisions

- All embeddings are local (offline, private) — no external API calls for indexing/search
- Full re-index on every `ferret index` run (no incremental updates)
- Chunk IDs are MD5-based for deduplication
- `SKILL.md` is the artifact installed into other projects — changes here affect how Claude Code behaves in those projects

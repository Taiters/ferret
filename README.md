# @taiters/ferret

Semantic codebase search for Claude Code. Index your codebase once, query it during every conversation — no more pasting code into context.

**What it does:**
- Parses Python, JS, TS by function/class (long methods windowed with overlap)
- Builds a call graph so Claude understands code flow
- Embeds everything locally (free, offline, ~25MB model)
- Stores vectors in LanceDB for fast semantic search

---

## Prerequisites

- Node.js 18+

---

## Setup

### 1. Install the CLI

```bash
npm install -g @taiters/ferret
```

This makes `ferret` available globally in your terminal.

### 2. Enable the plugin

Install the plugin via the Claude Code plugin manager:

```bash
claude plugin add @taiters/ferret
```

Or load it for a single session:

```bash
claude --plugin-dir $(npm root -g)/@taiters/ferret
```

---

## Usage

### Index a codebase

```bash
ferret index /path/to/your/project
```

Takes 1-5 minutes depending on codebase size. The embedding model downloads once (~25MB) on first run.

Options:
```bash
ferret index . --verbose         # show skipped files
```

### Search

```bash
ferret search "authentication middleware"
ferret search "how does payment work" --graph   # include call graph
ferret search "recent changes" -k 10            # more results
```

### Call graph

```bash
ferret graph "validateToken"
ferret graph "processPayment" --depth 3
```

### Stats

```bash
ferret stats
```

---

## How Claude Code uses it

Once the plugin is enabled, Claude Code automatically uses `ferret search` before answering questions about your code.

Example conversation:
```
You:    "How does the auth system work?"
Claude: [runs: ferret search "authentication flow" --graph]
Claude: "Based on your codebase, auth works as follows:
         login() in src/auth/login.py:12-45 calls validateToken()
         which calls checkPermissions()..."
```

Claude grounds answers in your actual code without you needing to paste anything.

---

## Architecture

```
@taiters/ferret/
├── .claude-plugin/plugin.json       ← plugin manifest
├── skills/
│   ├── search/SKILL.md              ← ferret:search skill
│   └── graph/SKILL.md               ← ferret:graph skill
└── src/
    ├── ferret.ts                     ← CLI entry point
    ├── indexer/                      ← orchestrates indexing
    ├── search/                       ← semantic search pipeline
    ├── embedding/                    ← local transformers.js embeddings
    ├── store/                        ← LanceDB interface
    └── ingestion/                    ← tree-sitter parsers (py/js/ts)

LanceDB (local, file-based):
  - Vectors stored in chunks table with HNSW index
  - Call graph stored in graph table as adjacency list
  - DB stored at <project>/.ferret/db
```

---

## Re-indexing

Re-index any time you want to refresh (full re-index, clears previous):

```bash
ferret index /path/to/project
```

Takes the same time as initial indexing. Recommended after large refactors or when Claude seems to have stale context.

---

## Troubleshooting

**`ferret: command not found`**
Run `npm install -g @taiters/ferret` and make sure your npm global bin directory is on your `PATH`.

**`No results found`**
- Check `ferret stats` — if total is 0, index first
- Try broader search terms
- Lower similarity threshold is 30% — very specific queries may not match

**Slow first search**
- Normal — embedding model loads into memory on first call (~3s)
- Subsequent searches are fast (<500ms)

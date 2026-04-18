# @taiters/ferret

Semantic codebase search for Claude Code. Index your codebase once, query it during every conversation — no more pasting code into context.

**What it does:**
- Parses Python, JS, TS by function/class (long methods windowed with overlap)
- Splits markdown/README by heading sections
- Ingests git history in batches
- Builds a call graph so Claude understands code flow
- Embeds everything locally (free, offline, ~25MB model)
- Stores vectors in LanceDB for fast semantic search

---

## Prerequisites

- Node.js 18+

---

## Setup

### 1. Install & link the CLI

```bash
cd ~/repos/Taiters/memory-skill
npm install
npm run build
npm link
```

This makes `ferret` available globally in your terminal.

### 2. Register the skill with Claude Code

Copy `SKILL.md` into your project's skills directory:

```bash
mkdir -p /path/to/your/project/.claude/skills
cp ~/repos/Taiters/memory-skill/SKILL.md /path/to/your/project/.claude/skills/ferret.md
```

Or install it globally for all Claude Code sessions:

```bash
mkdir -p ~/.claude/skills
cp ~/repos/Taiters/memory-skill/SKILL.md ~/.claude/skills/ferret.md
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
ferret index . --git-limit 200   # ingest more git history
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

Once `SKILL.md` is in `.claude/skills/`, Claude Code reads it at session start and knows to call `ferret search` before answering questions about your code.

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
your project/
└── .claude/skills/ferret.md    ← Claude Code reads this

~/repos/Taiters/memory-skill/
├── src/
│   ├── ferret.ts               ← CLI entry point
│   ├── indexer.ts              ← orchestrates indexing
│   ├── search.ts               ← semantic search + graph
│   ├── embedder.ts             ← local transformers.js embeddings
│   ├── store.ts                ← LanceDB interface
│   └── ingestion/
│       ├── parser.ts           ← tree-sitter chunker (py/js/ts)
│       ├── markdown.ts         ← heading-based md splitter
│       └── git.ts              ← git log ingestion

LanceDB (local, file-based):
  - Vectors stored in chunks table with HNSW index
  - Call graph stored in graph table as adjacency list
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
```bash
cd ~/repos/Taiters/memory-skill && npm run build && npm link
```

**`No results found`**
- Check `ferret stats` — if total is 0, index first
- Try broader search terms
- Lower similarity threshold is 30% — very specific queries may not match

**Slow first search**
- Normal — embedding model loads into memory on first call (~3s)
- Subsequent searches are fast (<500ms)

# memory-skill

Semantic memory store for Claude Code. Index your codebase once, query it during every conversation — no more pasting code into context.

**What it does:**
- Parses Python, JS, TS by function/class (long methods windowed with overlap)
- Splits markdown/README by heading sections  
- Ingests git history in batches
- Builds a call graph so Claude understands code flow
- Embeds everything locally (free, offline, ~25MB model)
- Stores vectors in Redis Stack for fast semantic search

---

## Prerequisites

- Node.js 18+
- Docker (for Redis Stack)

---

## Setup

### 1. Start Redis Stack

```bash
cd ~/memory-skill
docker compose up -d
```

Redis UI available at http://localhost:8001 (optional, lets you browse stored vectors).

### 2. Install & link the CLI

```bash
cd ~/memory-skill
npm install
npm link
```

This makes `memory` available globally in your terminal.

### 3. Register the skill with Claude Code

Copy `SKILL.md` into your project's skills directory:

```bash
mkdir -p /path/to/your/project/.claude/skills
cp ~/memory-skill/SKILL.md /path/to/your/project/.claude/skills/memory.md
```

Or install it globally for all Claude Code sessions:

```bash
mkdir -p ~/.claude/skills
cp ~/memory-skill/SKILL.md ~/.claude/skills/memory.md
```

---

## Usage

### Index a codebase

```bash
memory index /path/to/your/project
```

Takes 1-5 minutes depending on codebase size. The embedding model downloads once (~25MB) on first run.

Options:
```bash
memory index . --git-limit 200   # ingest more git history
memory index . --verbose         # show skipped files
```

### Search

```bash
memory search "authentication middleware"
memory search "how does payment work" --graph   # include call graph
memory search "recent changes" -k 10            # more results
```

### Call graph

```bash
memory graph "validateToken"
memory graph "processPayment" --depth 3
```

### Stats

```bash
memory stats
```

---

## How Claude Code uses it

Once `SKILL.md` is in `.claude/skills/`, Claude Code reads it at session start and knows to call `memory search` before answering questions about your code.

Example conversation:
```
You:    "How does the auth system work?"
Claude: [runs: memory search "authentication flow" --graph]
Claude: "Based on your codebase, auth works as follows:
         login() in src/auth/login.py:12-45 calls validateToken()
         which calls checkPermissions()..."
```

Claude grounds answers in your actual code without you needing to paste anything.

---

## Architecture

```
your project/
└── .claude/skills/memory.md    ← Claude Code reads this

~/memory-skill/
├── bin/memory.js               ← CLI entry point
├── indexer.js                  ← orchestrates indexing
├── search.js                   ← semantic search + graph
├── embedder.js                 ← local transformers.js embeddings
├── store.js                    ← Redis Stack interface
├── tsLanguage.js               ← TypeScript grammar helper
├── ingestion/
│   ├── parser.js               ← tree-sitter chunker (py/js/ts)
│   ├── markdown.js             ← heading-based md splitter
│   └── git.js                  ← git log ingestion
└── docker-compose.yml          ← Redis Stack

Redis Stack (local):
  - Vectors stored as HASH with HNSW index
  - Call graph stored as adjacency list (HASH)
  - FT.SEARCH for KNN vector queries
```

---

## Re-indexing

Re-index any time you want to refresh (full re-index, clears previous):

```bash
memory index /path/to/project
```

Takes the same time as initial indexing. Recommended after large refactors or when Claude seems to have stale context.

---

## Troubleshooting

**`memory: command not found`**
```bash
cd ~/memory-skill && npm link
```

**`Redis connection refused`**
```bash
cd ~/memory-skill && docker compose up -d
```

**`No results found`**
- Check `memory stats` — if total is 0, index first
- Try broader search terms
- Lower similarity threshold is 30% — very specific queries may not match

**Slow first search**
- Normal — embedding model loads into memory on first call (~3s)
- Subsequent searches are fast (<500ms)

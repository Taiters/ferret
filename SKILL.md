---
name: ferret
description: Use when you need to find code, understand how something is implemented, trace call flow, or look up a specific function/class in an indexed codebase. Use before answering questions about how features work, where things are defined, or how code connects.
---

# Ferret — Semantic Codebase Search

You have access to `ferret`, a semantic search tool over indexed codebases. Use it proactively rather than guessing from memory or grepping blindly.

## When to use ferret

- Understanding how a feature is implemented
- Finding where a function, class, or type is defined
- Tracing what calls what (call graph)
- Answering "where does X happen?" questions
- Any question where seeing real code would help

## Commands

### Semantic search
```bash
ferret search "<natural language query>"
ferret search "<query>" -k 10             # More results (default: 6)
ferret search "<query>" --min-score 0.5    # Filter low-relevance results (0–1)
ferret search "<query>" -p /path/to/proj  # Explicit project (overrides CWD)
```

Write queries as natural language, not keywords:
```bash
ferret search "how does authentication middleware work"
ferret search "database connection pooling"
ferret search "error handling in the payment flow"
```

### Look up a specific symbol
```bash
ferret symbol src/auth/login.ts:validateToken
ferret symbol -p /path/to/proj src/auth/login.ts:validateToken
```
Use when you know the exact file and symbol name. Format: `<file>:<SymbolName>` or `<file>:<Class>.<method>`.

### Call graph around a symbol
```bash
ferret graph src/auth/login.ts:validateToken
ferret graph src/auth/login.ts:validateToken --depth 3   # Deeper (default: 2)
```
Use when the user asks how code flows, what calls what, or wants to trace execution paths.

### Discovery
```bash
ferret projects    # List all indexed projects
ferret stats       # Chunk count + graph node count for current project
```

## Using results

Results include file paths and line ranges. When referencing them:
- Cite location: `src/auth/login.ts:12-45`
- Prefer results with score ≥ 0.5 — below that, treat with caution
- Graph output shows `calls:` and `called by:` edges — use these to explain flow

## Example workflows

**"How does the auth system work?"**
1. `ferret search "authentication flow"`
2. Read chunks, follow up with `ferret graph` on key functions if flow is unclear

**"What does validateToken do and what calls it?"**
1. `ferret symbol src/auth/login.ts:validateToken`
2. `ferret graph src/auth/login.ts:validateToken`

**No results or wrong project?**
```bash
ferret projects                            # Check what's indexed
ferret search "<query>" -p /correct/path   # Force the right project
```
If nothing is indexed, ask the user to run `ferret index <path>` — indexing is their responsibility.

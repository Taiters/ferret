---
name: ferret-graph
description: Use when tracing call flow, understanding what calls what, or following execution paths through a codebase. Use after ferret search has identified the key symbols involved.
---

# Ferret — Call Graph

You have access to `ferret graph`, which shows what a function calls and what calls it.

## When to use

- Tracing how execution flows through the code
- Understanding what calls a particular function
- Getting a rough picture of code dependencies

## Command

```bash
ferret graph src/auth/login.ts:validateToken
ferret graph src/auth/login.ts:validateToken --depth 3   # Deeper traversal (default: 2)
ferret graph -p /path/to/proj src/auth/login.ts:validateToken
```

Format: `<file>:<SymbolName>` or `<file>:<Class>.<method>`.

## Important caveat

**The graph uses simple name matching and is not always accurate.** It can:
- Match the wrong function if the same name appears in multiple files
- Miss calls made through dynamic dispatch, higher-order functions, or aliases
- Include false edges where unrelated functions share a name

Treat graph output as a rough orientation, not a precise call graph. Always verify interesting edges by reading the actual source code.

## Using results

Graph output shows `calls:` and `called by:` edges. Use these to guide where to look next, then confirm by reading the referenced files directly.

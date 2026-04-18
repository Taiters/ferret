# Memory Skill

You have access to a semantic memory store containing indexed codebase context, documentation, and git history. Use it proactively whenever you need to understand code structure, find relevant implementations, or trace code flow.

## When to use memory

Use memory search **before** answering questions about:
- How a feature works or is implemented
- Where something is defined or called
- Recent changes (use git category)
- Architecture or design decisions (check docs category)
- Any question where seeing the actual code would help

## Commands

### Search for relevant context
```bash
memory search "<natural language query>"
```
Examples:
```bash
memory search "authentication middleware"
memory search "how does payment processing work"
memory search "database connection setup"
memory search "recent changes to user model"
```

### Search with call graph (for understanding code flow)
```bash
memory search "<query>" --graph
```
Use `--graph` when the user asks how code flows, what calls what, or wants to trace execution paths.

### Show call graph for a specific function
```bash
memory graph "<function_name>"
memory graph "<function_name>" --depth 3
```
Use when the user mentions a specific function and wants to understand its relationships.

### Check what's indexed
```bash
memory stats
```

### Index or re-index a codebase
```bash
memory index <path>
memory index /path/to/project
```
Run this when the user asks to index a project, or when search returns no results and a codebase should be available.

## How to use results

Results are returned as ranked chunks with file paths and line numbers. When referencing them:
- Cite the file and line range: `src/auth/login.py:12-45`
- Use the match percentage to gauge relevance — prefer 70%+ matches
- The `--graph` output shows `calls:` and `called by:` edges — use these to explain flow

## Example workflow

User: "How does the auth system work?"

1. Run: `memory search "authentication flow" --graph`
2. Read the returned chunks and graph edges
3. Answer based on the actual code, citing file locations
4. If you need more detail on a specific function: `memory graph "validateToken"`

## Troubleshooting

If `memory` command is not found:
```bash
cd ~/memory-skill && npm install && npm link
```

If Redis is not running:
```bash
cd ~/memory-skill && docker compose up -d
```

If no results are returned, the codebase may not be indexed:
```bash
memory index /path/to/project
```

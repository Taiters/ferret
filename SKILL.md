# Memory Skill

You have access to a semantic memory store containing indexed codebase context, documentation, and git history. Use it proactively whenever you need to understand code structure, find relevant implementations, or trace code flow.

## When to use memory

Use memory search **before** answering questions about:
- How a feature works or is implemented
- Where something is defined or called
- Recent changes (use `memory history`)
- Architecture or design decisions (use `--category docs`)
- Any question where seeing the actual code would help

## Commands

### Search for relevant context
```bash
memory search "<natural language query>"
```
Search automatically scopes to the current project (detected from your working directory).

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

### Search specific content categories
```bash
memory search "<query>" --category docs
memory search "<query>" --category code --category docs
```
Default is `code` only. Repeat `--category` for multiple categories. Options: `code`, `docs`, `text`. Git history is always separate (use `memory history`).

### Show call graph for a specific function
```bash
memory graph "<function_name>"
memory graph "<function_name>" --depth 3
```
Use when the user mentions a specific function and wants to understand its relationships.

### Search across all indexed projects
```bash
memory search "<query>" --all
```
Use `--all` when exploring across multiple repos or looking for a pattern that might exist in any indexed project. Results are ranked by relevance and labelled with the project name.

### Search a specific project explicitly
```bash
memory search "<query>" --project /path/to/project
```
Use when auto-detection fails or you want to search a project other than the current one.

### List all indexed projects
```bash
memory projects
```
Use to discover what projects are available before doing a cross-project search.

### Check what's indexed
```bash
memory stats
memory stats --all
```

### Index or re-index a codebase
```bash
memory index <path>
memory index /path/to/project
```
Each project is stored independently — indexing one project does not affect others. Run this when the user asks to index a project, or when search returns no results and a codebase should be available.

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

User: "Do any of our other repos handle auth differently?"

1. Run: `memory projects` to see what's indexed
2. Run: `memory search "authentication" --all` to compare across projects

## Troubleshooting

If `memory` command is not found:
```bash
cd ~/repos/Taiters/memory-skill && npm install && npm run build && npm link
```

If no results are returned, the codebase may not be indexed:
```bash
memory index /path/to/project
```

If search returns results from the wrong project, you may be outside the project directory tree. Use `--project` to be explicit:
```bash
memory search "<query>" --project /path/to/correct/project
```

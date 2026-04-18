import { embed } from "./embedder.js";
import { search as vectorSearch, getGraphEdges } from "./store.js";

const SIMILARITY_THRESHOLD = 0.3;

/**
 * Semantic search + optional call graph expansion.
 * Returns formatted text ready for Claude to consume.
 */
export async function searchMemory(query, { topK = 6, graph = false } = {}) {
  const queryVec = await embed(query);
  const results  = await vectorSearch(queryVec, topK);
  const hits     = results.filter((r) => r.score >= SIMILARITY_THRESHOLD);

  if (hits.length === 0) {
    return `No relevant memories found for: "${query}"\nTry rephrasing or check if the codebase has been indexed (run: memory index <path>)`;
  }

  const lines = [
    `MEMORY SEARCH: "${query}"`,
    `Found ${hits.length} relevant chunks${graph ? " (with call graph)" : ""}`,
    "─".repeat(60),
  ];

  for (const hit of hits) {
    const pct = Math.round(hit.score * 100);
    lines.push(`\n[${pct}% match] ${hit.category.toUpperCase()} — ${hit.name}`);
    lines.push(`File: ${hit.file}:${hit.start_line}-${hit.end_line}`);

    if (graph && hit.category === "code") {
      const edges = await getGraphEdges(hit.name);
      if (edges.calls.length)    lines.push(`Calls:     ${edges.calls.join(", ")}`);
      if (edges.calledBy.length) lines.push(`Called by: ${edges.calledBy.join(", ")}`);
    }

    lines.push("```");
    // Truncate very long content for readability
    const content = hit.content.length > 1500
      ? hit.content.slice(0, 1500) + "\n... [truncated, see file for full content]"
      : hit.content;
    lines.push(content);
    lines.push("```");
  }

  return lines.join("\n");
}

/**
 * Show call graph around a specific function name.
 */
export async function showGraph(fnName, depth = 2) {
  const visited = new Set();
  const lines   = [`CALL GRAPH: ${fnName}`, "─".repeat(60)];

  async function walk(name, indent, d) {
    if (visited.has(name) || d > depth) return;
    visited.add(name);

    const edges = await getGraphEdges(name);
    lines.push(`${"  ".repeat(indent)}${indent === 0 ? "◉" : "→"} ${name}`);

    if (edges.calledBy.length && indent === 0) {
      lines.push(`${"  ".repeat(indent + 1)}← called by: ${edges.calledBy.join(", ")}`);
    }

    for (const callee of edges.calls) {
      await walk(callee, indent + 1, d + 1);
    }
  }

  await walk(fnName, 0, 0);

  if (lines.length === 2) {
    return `No graph data found for "${fnName}". Ensure the codebase is indexed.`;
  }

  return lines.join("\n");
}

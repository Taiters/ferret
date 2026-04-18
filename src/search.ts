import { embed } from "./embedder.js";
import { Store } from "./store.js";
import { readRegistry, localDbPath } from "./projects.js";
import type { SearchHit, SearchOptions } from "./types.js";

const SIMILARITY_THRESHOLD = 0.3;

export interface HistoryOptions {
  topK?: number;
  file?: string;
}

/**
 * Semantic search + optional call graph expansion.
 * Excludes git category chunks — use searchHistory for commit queries.
 * Returns formatted text ready for Claude to consume.
 */
export async function searchMemory(query: string, store: Store, { topK = 6, graph = false }: SearchOptions = {}): Promise<string> {
  const queryVec = await embed(query);
  // Fetch extra results to account for git chunks being filtered out
  const results = await store.search(queryVec, topK * 2);
  const hits = results
    .filter((r) => r.score >= SIMILARITY_THRESHOLD && r.category !== "git")
    .slice(0, topK);

  if (hits.length === 0) {
    return `No relevant memories found for: "${query}"\nTry rephrasing or check if the codebase has been indexed (run: memory index <path>)`;
  }

  return formatHits(query, hits, store, graph);
}

/**
 * Search git history for commits related to a query.
 * Optionally filter to commits that touched a specific file path.
 */
export async function searchHistory(query: string, store: Store, { topK = 6, file }: HistoryOptions = {}): Promise<string> {
  const queryVec = await embed(query);
  const results = await store.search(queryVec, topK * 4);

  let hits = results.filter((r) => r.score >= SIMILARITY_THRESHOLD && r.category === "git");

  if (file) {
    hits = hits.filter((r) => r.tags.some((t) => t.includes(file)));
  }

  hits = hits.slice(0, topK);

  if (hits.length === 0) {
    const fileNote = file ? ` touching "${file}"` : "";
    return `No relevant commits found for: "${query}"${fileNote}\nCheck if the codebase has been indexed (run: memory index <path>)`;
  }

  return formatHistoryHits(query, hits);
}

/**
 * Search across all projects in the registry, aggregating and ranking results.
 * Excludes git category chunks.
 */
export async function searchAllProjects(query: string, { topK = 6, graph = false }: SearchOptions = {}): Promise<string> {
  const projects = readRegistry();
  if (projects.length === 0) {
    return "No projects indexed yet. Run: memory index <path>";
  }

  const queryVec = await embed(query);

  type HitWithProject = SearchHit & { projectName: string; projectStore: Store };
  const allHits: HitWithProject[] = [];

  for (const project of projects) {
    const store = new Store(localDbPath(project.path));
    try {
      const results = await store.search(queryVec, topK * 2);
      for (const hit of results) {
        if (hit.score >= SIMILARITY_THRESHOLD && hit.category !== "git") {
          allHits.push({ ...hit, projectName: project.name, projectStore: store });
        }
      }
    } finally {
      await store.disconnect();
    }
  }

  if (allHits.length === 0) {
    return `No relevant memories found for: "${query}" across any indexed project.`;
  }

  allHits.sort((a, b) => b.score - a.score);
  const topHits = allHits.slice(0, topK);

  const lines: string[] = [
    `MEMORY SEARCH (all projects): "${query}"`,
    `Found ${topHits.length} relevant chunks across ${projects.length} project(s)`,
    "─".repeat(60),
  ];

  for (const hit of topHits) {
    const pct = Math.round(hit.score * 100);
    lines.push(`\n[${pct}% match] [${hit.projectName}] ${hit.category.toUpperCase()} — ${hit.name}`);
    lines.push(`File: ${hit.file}:${hit.start_line}-${hit.end_line}`);
    lines.push("```");
    const content =
      hit.content.length > 1500
        ? hit.content.slice(0, 1500) + "\n... [truncated, see file for full content]"
        : hit.content;
    lines.push(content);
    lines.push("```");
  }

  return lines.join("\n");
}

async function formatHits(query: string, hits: SearchHit[], store: Store, graph: boolean): Promise<string> {
  const lines: string[] = [
    `MEMORY SEARCH: "${query}"`,
    `Found ${hits.length} relevant chunks${graph ? " (with call graph)" : ""}`,
    "─".repeat(60),
  ];

  for (const hit of hits) {
    const pct = Math.round(hit.score * 100);
    lines.push(`\n[${pct}% match] ${hit.category.toUpperCase()} — ${hit.name}`);
    lines.push(`File: ${hit.file}:${hit.start_line}-${hit.end_line}`);

    if (graph && hit.category === "code") {
      const edges = await store.getGraphEdges(hit.name);
      if (edges.calls.length) lines.push(`Calls:     ${edges.calls.join(", ")}`);
      if (edges.calledBy.length) lines.push(`Called by: ${edges.calledBy.join(", ")}`);
    }

    lines.push("```");
    const content =
      hit.content.length > 1500
        ? hit.content.slice(0, 1500) + "\n... [truncated, see file for full content]"
        : hit.content;
    lines.push(content);
    lines.push("```");
  }

  return lines.join("\n");
}

function formatHistoryHits(query: string, hits: SearchHit[]): string {
  const lines: string[] = [
    `GIT HISTORY: "${query}"`,
    `Found ${hits.length} relevant commit(s)`,
    "─".repeat(60),
  ];

  for (const hit of hits) {
    const pct = Math.round(hit.score * 100);
    // Name format: "commit abc12345 (2026-03-10): feat: add OAuth [part 1/2]"
    // Extract hash and date from name for a cleaner header
    const nameMatch = hit.name.match(/^commit (\w+) \(([^)]+)\): (.+?)(\s*\[part .+])?$/);
    if (nameMatch) {
      const [, hash, date, msg] = nameMatch;
      lines.push(`\n[${pct}% match] ${hash} — ${date}`);
      lines.push(msg);
    } else {
      lines.push(`\n[${pct}% match] ${hit.name}`);
    }

    const files = hit.tags.filter((t) => !["git", "history", "commits"].includes(t));
    if (files.length) lines.push(`Files: ${files.join(", ")}`);

    lines.push("───");
    const content =
      hit.content.length > 2000
        ? hit.content.slice(0, 2000) + "\n... [truncated]"
        : hit.content;
    lines.push(content);
  }

  return lines.join("\n");
}

/**
 * Show call graph around a specific function name.
 */
export async function showGraph(fnName: string, store: Store, depth = 2): Promise<string> {
  const visited = new Set<string>();
  const lines: string[] = [`CALL GRAPH: ${fnName}`, "─".repeat(60)];

  async function walk(name: string, indent: number, d: number): Promise<void> {
    if (visited.has(name) || d > depth) return;
    visited.add(name);

    const edges = await store.getGraphEdges(name);
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

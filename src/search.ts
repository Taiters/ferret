import path from "path";
import { embed } from "./embedder.js";
import { rerank } from "./reranker.js";
import { Store } from "./store.js";
import { readRegistry, localDbPath } from "./projects.js";
import type { SearchHit, SearchOptions } from "./types.js";

export interface HistoryOptions {
  topK?: number;
  file?: string;
  model?: string;
}

/**
 * Semantic search + optional call graph expansion.
 * Excludes git category chunks — use searchHistory for commit queries.
 * Returns formatted text ready for Claude to consume.
 */
const GRAPH_EXPAND_DISCOUNT = 0.7;
const MMR_LAMBDA = 0.7;

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function mmrSelect(hits: SearchHit[], k: number): SearchHit[] {
  if (hits.length === 0) return [];
  const pool = [...hits];
  const selected: SearchHit[] = [];

  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const h = pool[i];
      const relevance = h.score;
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((s) =>
                h.vector && s.vector ? dot(h.vector, s.vector) : 0,
              ),
            );
      const mmrScore = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }

  return selected;
}

async function expandWithGraph(hits: SearchHit[], store: Store): Promise<SearchHit[]> {
  const codeHits = hits.filter((h) => h.category === "code");
  if (codeHits.length === 0) return hits;

  const existingIds = new Set(hits.map((h) => h.id));
  const existingNames = new Set(hits.map((h) => h.name.replace(/ \[lines \d+-\d+\]$/, "")));

  const edgeResults = await Promise.all(
    codeHits.map((h) => store.getGraphEdges(h.name.replace(/ \[lines \d+-\d+\]$/, ""))),
  );

  const relatedNames = new Map<string, SearchHit>(); // name → triggering hit
  for (let i = 0; i < codeHits.length; i++) {
    const { calls, calledBy } = edgeResults[i];
    for (const name of [...calls, ...calledBy]) {
      if (!existingNames.has(name) && !relatedNames.has(name)) {
        relatedNames.set(name, codeHits[i]);
      }
    }
  }

  if (relatedNames.size === 0) return hits;

  const namesToFetch = [...relatedNames.keys()];
  const fetched = await store.getChunksByName(namesToFetch);

  // Skip names that matched too many chunks (too generic)
  const nameCounts = new Map<string, number>();
  for (const hit of fetched) nameCounts.set(hit.name, (nameCounts.get(hit.name) ?? 0) + 1);

  const expanded: SearchHit[] = [];
  for (const hit of fetched) {
    if (existingIds.has(hit.id)) continue;
    if ((nameCounts.get(hit.name) ?? 0) > 10) continue;
    const trigger = relatedNames.get(hit.name)!;
    expanded.push({ ...hit, score: trigger.score * GRAPH_EXPAND_DISCOUNT, expandedVia: trigger.name });
  }

  return [...hits, ...expanded];
}

export async function searchMemory(query: string, store: Store, { topK = 6, graph = false, model, categories = ["code"], minScore = 0, projectRoot }: SearchOptions = {}): Promise<string> {
  const queryVec = await embed(query, model);
  const results = await store.search(queryVec, query, topK * 2, categories as string[]);
  const filtered = results.filter((r) => r.score >= minScore);

  if (filtered.length === 0) {
    return `No relevant results found for: "${query}"\nTry rephrasing or check if the codebase has been indexed (run: ferret index <path>)`;
  }

  const reranked = await rerank(query, filtered);
  const expanded = await expandWithGraph(reranked, store);
  const hits = mmrSelect(expanded, topK).map(({ vector: _v, ...h }) => h);

  return formatHits(query, hits, store, graph, projectRoot);
}

/**
 * Search git history for commits related to a query.
 * Optionally filter to commits that touched a specific file path.
 */
export async function searchHistory(query: string, store: Store, { topK = 6, file, model }: HistoryOptions = {}): Promise<string> {
  const queryVec = await embed(query, model);
  const results = await store.search(queryVec, query, topK, ["git"]);

  let hits = results;

  if (file) {
    hits = hits.filter((r) => r.tags.some((t) => t.includes(file)));
  }

  if (hits.length === 0) {
    const fileNote = file ? ` touching "${file}"` : "";
    return `No relevant commits found for: "${query}"${fileNote}\nCheck if the codebase has been indexed (run: ferret index <path>)`;
  }

  return formatHistoryHits(query, hits);
}

/**
 * Search across all projects in the registry, aggregating and ranking results.
 * Excludes git category chunks.
 */
export async function searchAllProjects(query: string, { topK = 6, graph = false, model, categories = ["code"], minScore = 0 }: SearchOptions = {}): Promise<string> {
  const projects = readRegistry();
  if (projects.length === 0) {
    return "No projects indexed yet. Run: ferret index <path>";
  }

  const queryVec = await embed(query, model);

  type HitWithProject = SearchHit & { projectName: string; projectPath: string; projectStore: Store };
  const allHits: HitWithProject[] = [];

  for (const project of projects) {
    const store = new Store(localDbPath(project.path));
    try {
      const results = await store.search(queryVec, query, topK, categories as string[]);
      for (const hit of results) {
        if (hit.score < minScore) continue;
        allHits.push({ ...hit, projectName: project.name, projectPath: project.path, projectStore: store });
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
    lines.push(`\n[${hit.projectName}] ${hit.category.toUpperCase()} — ${hit.name}`);
    const relFile = path.relative(hit.projectPath, hit.file);
    lines.push(`File: ${relFile}:${hit.start_line}-${hit.end_line}`);
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

async function formatHits(query: string, hits: SearchHit[], store: Store, graph: boolean, projectRoot?: string): Promise<string> {
  const lines: string[] = [
    `MEMORY SEARCH: "${query}"`,
    `Found ${hits.length} relevant chunks${graph ? " (with call graph)" : ""}`,
    "─".repeat(60),
  ];

  for (const hit of hits) {
    const expandedNote = hit.expandedVia ? ` (via: ${hit.expandedVia})` : "";
    lines.push(`\n${hit.category.toUpperCase()} — ${hit.name}${expandedNote}`);
    const filePath = projectRoot ? path.relative(projectRoot, hit.file) : hit.file;
    lines.push(`File: ${filePath}:${hit.start_line}-${hit.end_line}`);

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
    // Name format: "commit abc12345 (2026-03-10): feat: add OAuth [part 1/2]"
    // Extract hash and date from name for a cleaner header
    const nameMatch = hit.name.match(/^commit (\w+) \(([^)]+)\): (.+?)(\s*\[part .+])?$/);
    if (nameMatch) {
      const [, hash, date, msg] = nameMatch;
      lines.push(`\n${hash} — ${date}`);
      lines.push(msg);
    } else {
      lines.push(`\n${hit.name}`);
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

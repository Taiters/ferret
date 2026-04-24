/**
 * Benchmark multiple embedding models against indexing speed and search quality.
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts [project-path]
 *
 * project-path defaults to the ferret repo itself (good dog-food test).
 *
 * For each model the script:
 *   1. Re-indexes the project into a temporary per-model store
 *   2. Runs a fixed probe set and records Recall@1, Recall@5, and MRR
 *   3. Records wall-clock indexing time
 *   4. Cleans up the temporary store
 *
 * Results are printed as a markdown table.
 */

import path from "path";
import fs from "fs";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";
import { indexProject } from "../src/indexer.js";
import { embed } from "../src/embedder.js";
import { Store } from "../src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── Models to benchmark ───────────────────────────────────────────────────────

const MODELS = [
  "Xenova/all-MiniLM-L6-v2",
  "Xenova/all-MiniLM-L12-v2",
  "Xenova/all-mpnet-base-v2",
  "onnx-community/bge-base-en-v1.5",
  "onnx-community/nomic-embed-text-v1.5",
  "jinaai/jina-embeddings-v2-base-code",
];

// ── Probe set ─────────────────────────────────────────────────────────────────
// Each probe has a natural-language query and one or more acceptable hits.
// A hit matches if the result's file path contains `file` AND (if specified)
// the chunk name contains `name`. Either criterion alone is sufficient for a match.

interface Probe {
  query: string;
  category?: "code" | "docs" | "git"; // defaults to "code"
  // At least one of these must match a result for it to count as correct.
  matches: Array<{ file?: string; name?: string }>;
}

const PROBES: Probe[] = [
  {
    query: "embedding model cache",
    matches: [{ file: "embedder", name: "getEmbedder" }],
  },
  {
    query: "detect project root from current directory",
    matches: [{ file: "projects", name: "resolveProjectFromCwd" }],
  },
  {
    query: "git commit ingestion",
    matches: [{ file: "git" }],
  },
  {
    query: "markdown heading chunker",
    matches: [{ file: "markdown" }],
  },
  {
    query: "tree-sitter parse functions",
    matches: [{ file: "parser" }],
  },
  {
    query: "store vector chunk lancedb",
    matches: [{ file: "store", name: "upsertChunk" }],
  },
  {
    query: "relative time formatting",
    matches: [{ file: "ferret", name: "formatRelativeTime" }],
  },
  {
    query: "search all projects",
    matches: [{ file: "search", name: "searchAllProjects" }],
  },
  {
    query: "full text search index",
    matches: [{ file: "store", name: "buildFtsIndex" }],
  },
  {
    query: "call graph depth traversal",
    matches: [{ file: "search", name: "showGraph" }],
  },
  {
    query: "project registry",
    matches: [{ file: "projects", name: "registerProject" }],
  },
  {
    query: "sliding window overlap long functions",
    matches: [{ file: "parser" }],
  },
  // ── Git probes ───────────────────────────────────────────────────────────
  // Matched against commit message keywords in the chunk name field.
  {
    query: "rename project",
    category: "git",
    matches: [{ name: "ferret" }],
  },
  {
    query: "multi project support",
    category: "git",
    matches: [{ name: "multi project" }],
  },
  {
    query: "improve git history search",
    category: "git",
    matches: [{ name: "git history" }],
  },
  // ── Docs probes ──────────────────────────────────────────────────────────
  // Matched against heading names from README.md and SKILL.md.
  {
    query: "install and link the CLI",
    category: "docs",
    matches: [{ file: "README", name: "Setup" }],
  },
  {
    query: "ferret command not found error",
    category: "docs",
    matches: [{ name: "Troubleshooting" }],
  },
  {
    query: "when should Claude run a search",
    category: "docs",
    matches: [{ file: "SKILL", name: "When to use" }],
  },
  {
    query: "lancedb vector storage architecture",
    category: "docs",
    matches: [{ file: "README", name: "Architecture" }],
  },
  {
    query: "how to read search results and cite files",
    category: "docs",
    matches: [{ file: "SKILL", name: "How to use results" }],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMatch(hit: { file: string; name: string }, probe: Probe): boolean {
  return probe.matches.some((m) => {
    const fileOk = !m.file || hit.file.toLowerCase().includes(m.file.toLowerCase());
    const nameOk = !m.name || hit.name.toLowerCase().includes(m.name.toLowerCase());
    // Both conditions must hold when both are specified; either alone is enough otherwise.
    if (m.file && m.name) return fileOk && nameOk;
    return fileOk || nameOk;
  });
}

function tempDbPath(model: string): string {
  const slug = model.replace(/[^a-z0-9]/gi, "-");
  return path.join(REPO_ROOT, ".ferret", `bench-${slug}`, "db");
}

function rmrf(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── Per-model benchmark ───────────────────────────────────────────────────────

interface ModelResult {
  model: string;
  indexSecs: number;
  recall1: number;
  recall5: number;
  mrr: number;
  perProbe: Array<{ query: string; rank: number | null }>;
}

async function benchmarkModel(model: string, projectPath: string): Promise<ModelResult> {
  const dbPath = tempDbPath(model);
  rmrf(path.dirname(dbPath)); // clean any previous run
  const store = new Store(dbPath);

  // ── Index ──────────────────────────────────────────────────────────────────
  console.log(`\n  Indexing with ${model}...`);
  const t0 = performance.now();
  await indexProject(projectPath, store, { model, gitLimit: 50 });
  const indexSecs = (performance.now() - t0) / 1000;

  // ── Search probes ──────────────────────────────────────────────────────────
  console.log(`  Running ${PROBES.length} probes...`);
  const perProbe: ModelResult["perProbe"] = [];
  let reciprocalRankSum = 0;
  let hits1 = 0;
  let hits5 = 0;

  for (const probe of PROBES) {
    const queryVec = await embed(probe.query, model);
    // Fetch top 10 so we can score Recall@5 and MRR accurately
    const results = await store.search(queryVec, probe.query, 10);
    const codeResults = results.filter((r) => r.category === (probe.category ?? "code"));

    let rank: number | null = null;
    for (let i = 0; i < codeResults.length; i++) {
      const hit = codeResults[i];
      if (isMatch({ file: hit.file, name: hit.name }, probe)) {
        rank = i + 1; // 1-indexed
        break;
      }
    }

    perProbe.push({ query: probe.query, rank });
    if (rank === 1) hits1++;
    if (rank !== null && rank <= 5) hits5++;
    if (rank !== null) reciprocalRankSum += 1 / rank;
  }

  await store.disconnect();
  rmrf(path.dirname(dbPath));

  const n = PROBES.length;
  return {
    model,
    indexSecs,
    recall1: hits1 / n,
    recall5: hits5 / n,
    mrr: reciprocalRankSum / n,
    perProbe,
  };
}

// ── Output ────────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function printSummaryTable(results: ModelResult[]): void {
  console.log("\n## Summary\n");
  console.log(
    "| Model | Index time | Recall@1 | Recall@5 | MRR |",
  );
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    const shortModel = r.model.split("/")[1];
    console.log(
      `| ${shortModel} | ${r.indexSecs.toFixed(1)}s | ${pct(r.recall1)} | ${pct(r.recall5)} | ${r.mrr.toFixed(2)} |`,
    );
  }
}

function printProbeBreakdown(results: ModelResult[]): void {
  console.log("\n## Per-probe ranks (− = not in top 10)\n");
  const header = ["Query", ...results.map((r) => r.model.split("/")[1])];
  console.log("| " + header.join(" | ") + " |");
  console.log("| " + header.map(() => "---").join(" | ") + " |");
  for (let i = 0; i < PROBES.length; i++) {
    const query = PROBES[i].query.slice(0, 50);
    const ranks = results.map((r) => {
      const rank = r.perProbe[i].rank;
      return rank === null ? "−" : String(rank);
    });
    console.log(`| ${query} | ${ranks.join(" | ")} |`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const projectPath = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
console.log(`\nFerret Model Benchmark`);
console.log(`Project: ${projectPath}`);
console.log(`Models:  ${MODELS.length}`);
console.log(`Probes:  ${PROBES.length}`);

const results: ModelResult[] = [];
for (const model of MODELS) {
  try {
    const result = await benchmarkModel(model, projectPath);
    results.push(result);
    console.log(
      `  → index: ${result.indexSecs.toFixed(1)}s  R@1: ${pct(result.recall1)}  R@5: ${pct(result.recall5)}  MRR: ${result.mrr.toFixed(2)}`,
    );
  } catch (err) {
    console.error(`  ✗ ${model} failed:`, err instanceof Error ? err.message : err);
  }
}

printSummaryTable(results);
printProbeBreakdown(results);

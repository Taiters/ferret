#!/usr/bin/env node
import path from "path";
import fs from "fs";
import { Command } from "commander";
import { HuggingFaceEmbedder } from "./embedding/index.js";
import { CrossEncoderRanker, MmrSelector } from "./ranking/index.js";
import { LanceDbStore } from "./store/index.js";
import { Indexer } from "./indexer/index.js";
import { Searcher } from "./search/index.js";
import { registry } from "./ingestion/registry.js";
import type { SearchHit } from "./types.js";
import {
  localDbPath,
  resolveProjectFromCwd,
  readRegistry,
  registerProject,
  readProjectConfig,
} from "./projects.js";

const program = new Command();

program
  .name("ferret")
  .description("Semantic codebase search for Claude Code")
  .version("1.0.0");

function resolveDbPath(explicitProjectPath?: string): string {
  if (explicitProjectPath) return localDbPath(path.resolve(explicitProjectPath));
  const detected = resolveProjectFromCwd();
  if (detected) return localDbPath(detected);
  throw new Error(
    "No indexed project found in the current directory tree.\n" +
      "Run: ferret index <path>\n" +
      "Or specify: --project <path>",
  );
}

function resolveProjectRoot(explicitProjectPath?: string): string {
  if (explicitProjectPath) return path.resolve(explicitProjectPath);
  return resolveProjectFromCwd() ?? process.cwd();
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatHits(hits: SearchHit[], query: string): string {
  const lines = [
    `SEARCH: "${query}"`,
    `Found ${hits.length} result(s)`,
    "─".repeat(60),
  ];
  for (const hit of hits) {
    lines.push(`\n${hit.symbolId}  (lines ${hit.startLine}–${hit.endLine})`);
    lines.push("```");
    lines.push(hit.content.length > 1500 ? hit.content.slice(0, 1500) + "\n... [truncated]" : hit.content);
    lines.push("```");
  }
  return lines.join("\n");
}

// ── ferret index <path> ───────────────────────────────────────────────────────
program
  .command("index <path>")
  .description("Index a codebase")
  .option("-v, --verbose", "Show skipped files")
  .option("--gitignore", "Create .ferret/.gitignore to exclude db/")
  .action(async (projectPath: string, opts: { verbose?: boolean; gitignore?: boolean }) => {
    const absPath = path.resolve(projectPath);
    const store = new LanceDbStore(localDbPath(absPath));
    const embedder = new HuggingFaceEmbedder();
    const indexer = new Indexer(embedder, store, registry);
    try {
      await indexer.index(absPath, { verbose: opts.verbose });
      if (opts.gitignore) {
        const gitignorePath = path.join(absPath, ".ferret", ".gitignore");
        fs.writeFileSync(gitignorePath, "db/\n");
        console.log("  Created .ferret/.gitignore");
      }
    } catch (e) {
      console.error("Indexing failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret search <query> ─────────────────────────────────────────────────────
program
  .command("search <query>")
  .description("Semantic search across indexed code")
  .option("-k, --top-k <n>", "Number of results", "6")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .option("--min-score <n>", "Minimum relevance score 0–1", "0")
  .action(async (query: string, opts: { topK: string; project?: string; minScore: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    const embedder = new HuggingFaceEmbedder();
    const searcher = new Searcher(embedder, store, new CrossEncoderRanker(), new MmrSelector());
    try {
      const hits = await searcher.search(query, parseInt(opts.topK), parseFloat(opts.minScore));
      console.log(formatHits(hits, query));
    } catch (e) {
      console.error("Search failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret symbol <symbolId> ──────────────────────────────────────────────────
program
  .command("symbol <symbolId>")
  .description("Look up a symbol by its ID (e.g. src/search.ts:Searcher.search)")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (symbolId: string, opts: { project?: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    try {
      const chunk = await store.getSymbol(symbolId);
      if (!chunk) {
        console.log(`Symbol not found: "${symbolId}"`);
        console.log("Re-index and try again, or check the symbol ID format (e.g. src/file.ts:functionName)");
        process.exit(1);
      }
      console.log(`\n${chunk.symbolId}  (lines ${chunk.startLine}–${chunk.endLine})`);
      console.log(`File: ${chunk.file}`);
      console.log("```");
      console.log(chunk.content);
      console.log("```");
    } catch (e) {
      console.error("Symbol lookup failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret graph <symbolId> ───────────────────────────────────────────────────
program
  .command("graph <symbolId>")
  .description("Show call graph around a symbol")
  .option("-d, --depth <n>", "Graph traversal depth", "2")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (symbolId: string, opts: { depth: string; project?: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    const depth = parseInt(opts.depth);
    try {
      const visited = new Set<string>();
      const lines = [`CALL GRAPH: ${symbolId}`, "─".repeat(60)];

      async function walk(id: string, indent: number, d: number): Promise<void> {
        if (visited.has(id) || d > depth) return;
        visited.add(id);
        const edges = await store.getGraphEdges(id);
        lines.push(`${"  ".repeat(indent)}${indent === 0 ? "◉" : "→"} ${id}`);
        if (edges.calledBy.length && indent === 0) {
          lines.push(`${"  ".repeat(indent + 1)}← called by: ${edges.calledBy.join(", ")}`);
        }
        for (const callee of edges.calls) await walk(callee, indent + 1, d + 1);
      }

      await walk(symbolId, 0, 0);

      if (lines.length === 2) {
        console.log(`No graph data found for "${symbolId}". Ensure the codebase is indexed.`);
      } else {
        console.log(lines.join("\n"));
      }
    } catch (e) {
      console.error("Graph failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret stats ──────────────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show index statistics")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (opts: { project?: string }) => {
    const store = new LanceDbStore(resolveDbPath(opts.project));
    try {
      const { chunks, graphNodes } = await store.getStats();
      console.log("\nFerret Stats");
      console.log("──────────────────");
      console.log(`Chunks      : ${chunks}`);
      console.log(`Graph nodes : ${graphNodes}`);
      console.log();
    } catch (e) {
      console.error("Stats failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── ferret register [path] ────────────────────────────────────────────────────
program
  .command("register [path]")
  .description("Register an existing indexed project")
  .action((projectPath?: string) => {
    const absPath = projectPath ? path.resolve(projectPath) : process.cwd();
    const dbPath = localDbPath(absPath);
    if (!fs.existsSync(dbPath)) {
      console.error(`No index found at ${dbPath}`);
      console.error("Run: ferret index <path>");
      process.exit(1);
    }
    registerProject(absPath);
    console.log(`Registered: ${absPath}`);
    if (!readProjectConfig(absPath)) console.log("  (no index-info.json found)");
  });

// ── ferret projects ───────────────────────────────────────────────────────────
program
  .command("projects")
  .description("List all indexed projects")
  .action(() => {
    const projects = readRegistry();
    if (projects.length === 0) {
      console.log("No projects indexed yet. Run: ferret index <path>");
      return;
    }
    console.log("\nIndexed Projects");
    console.log("────────────────");
    for (const p of projects) {
      const age = formatRelativeTime(p.indexedAt);
      console.log(`  ${p.name.padEnd(24)} ${p.path}`);
      console.log(`  ${"".padEnd(24)} indexed ${age}\n`);
    }
  });

program.parse();

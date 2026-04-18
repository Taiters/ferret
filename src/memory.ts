#!/usr/bin/env node
import path from "path";
import { Command } from "commander";
import { indexProject } from "./indexer.js";
import { searchMemory, searchAllProjects, searchHistory, showGraph } from "./search.js";
import { Store } from "./store.js";
import {
  localDbPath,
  resolveProjectFromCwd,
  readRegistry,
} from "./projects.js";

const program = new Command();

program
  .name("memory")
  .description("Semantic memory store for Claude Code")
  .version("1.0.0");

function resolveStore(explicitProjectPath?: string): Store {
  if (explicitProjectPath) {
    return new Store(localDbPath(path.resolve(explicitProjectPath)));
  }
  const detected = resolveProjectFromCwd();
  if (detected) return new Store(localDbPath(detected));
  throw new Error(
    "No indexed project found in the current directory tree.\n" +
    "Run: memory index <path>\n" +
    "Or specify: --project <path>",
  );
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── memory index <path> ───────────────────────────────────────────────────────
program
  .command("index <path>")
  .description("Index a codebase into the memory store")
  .option("--git-limit <n>", "Number of git commits to ingest", "50")
  .option("-v, --verbose", "Show skipped files")
  .action(async (projectPath: string, opts: { gitLimit: string; verbose?: boolean }) => {
    const absPath = path.resolve(projectPath);
    const store = new Store(localDbPath(absPath));
    try {
      await indexProject(absPath, store, {
        gitLimit: parseInt(opts.gitLimit),
        verbose: opts.verbose,
      });
    } catch (e) {
      console.error("Indexing failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store.disconnect();
    }
  });

// ── memory search <query> ─────────────────────────────────────────────────────
program
  .command("search <query>")
  .description("Semantic search across indexed memory")
  .option("-k, --top-k <n>", "Number of results", "6")
  .option("-g, --graph", "Include call graph edges in results")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .option("-a, --all", "Search across all indexed projects")
  .action(async (query: string, opts: { topK: string; graph?: boolean; project?: string; all?: boolean }) => {
    try {
      if (opts.all) {
        const result = await searchAllProjects(query, {
          topK: parseInt(opts.topK),
          graph: opts.graph,
        });
        console.log(result);
      } else {
        const store = resolveStore(opts.project);
        try {
          const result = await searchMemory(query, store, {
            topK: parseInt(opts.topK),
            graph: opts.graph,
          });
          console.log(result);
        } finally {
          await store.disconnect();
        }
      }
    } catch (e) {
      console.error("Search failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

// ── memory history <query> ────────────────────────────────────────────────────
program
  .command("history <query>")
  .description("Search git history for commits related to a query")
  .option("-k, --top-k <n>", "Number of results", "6")
  .option("--file <path>", "Filter to commits that touched a specific file")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (query: string, opts: { topK: string; file?: string; project?: string }) => {
    let store: Store | undefined;
    try {
      store = resolveStore(opts.project);
      const result = await searchHistory(query, store, {
        topK: parseInt(opts.topK),
        file: opts.file,
      });
      console.log(result);
    } catch (e) {
      console.error("History search failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store?.disconnect();
    }
  });

// ── memory graph <fn-name> ────────────────────────────────────────────────────
program
  .command("graph <function>")
  .description("Show call graph around a function")
  .option("-d, --depth <n>", "Graph traversal depth", "2")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .action(async (fnName: string, opts: { depth: string; project?: string }) => {
    let store: Store | undefined;
    try {
      store = resolveStore(opts.project);
      const result = await showGraph(fnName, store, parseInt(opts.depth));
      console.log(result);
    } catch (e) {
      console.error("Graph failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await store?.disconnect();
    }
  });

// ── memory stats ──────────────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show memory store statistics")
  .option("-p, --project <path>", "Explicit project path (overrides CWD detection)")
  .option("-a, --all", "Show stats for all indexed projects")
  .action(async (opts: { project?: string; all?: boolean }) => {
    try {
      if (opts.all) {
        const projects = readRegistry();
        if (projects.length === 0) {
          console.log("No projects indexed yet. Run: memory index <path>");
          return;
        }
        for (const p of projects) {
          const store = new Store(localDbPath(p.path));
          try {
            const { total, graphNodes } = await store.getStats();
            const byCategory = await store.getAllByCategory();
            console.log(`\n${p.name} (${p.path})`);
            console.log("─".repeat(60));
            console.log(`Total chunks : ${total}`);
            console.log(`Graph nodes  : ${graphNodes}`);
            for (const [cat, count] of Object.entries(byCategory)) {
              console.log(`  ${cat.padEnd(12)} ${count}`);
            }
          } finally {
            await store.disconnect();
          }
        }
        console.log();
      } else {
        const store = resolveStore(opts.project);
        try {
          const { total, graphNodes } = await store.getStats();
          const byCategory = await store.getAllByCategory();
          console.log("\nMemory Store Stats");
          console.log("──────────────────");
          console.log(`Total chunks : ${total}`);
          console.log(`Graph nodes  : ${graphNodes}`);
          console.log("\nBy category:");
          for (const [cat, count] of Object.entries(byCategory)) {
            console.log(`  ${cat.padEnd(12)} ${count}`);
          }
          console.log();
        } finally {
          await store.disconnect();
        }
      }
    } catch (e) {
      console.error("Stats failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

// ── memory projects ───────────────────────────────────────────────────────────
program
  .command("projects")
  .description("List all indexed projects")
  .action(() => {
    const projects = readRegistry();
    if (projects.length === 0) {
      console.log("No projects indexed yet. Run: memory index <path>");
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

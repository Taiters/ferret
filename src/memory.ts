#!/usr/bin/env node
import { Command } from "commander";
import { indexProject } from "./indexer.js";
import { searchMemory, showGraph } from "./search.js";
import { getStats, getAllByCategory, disconnect } from "./store.js";

const program = new Command();

program
  .name("memory")
  .description("Semantic memory store for Claude Code")
  .version("1.0.0");

// ── memory index <path> ───────────────────────────────────────────────────────
program
  .command("index <path>")
  .description("Index a codebase into the memory store")
  .option("--git-limit <n>", "Number of git commits to ingest", "100")
  .option("-v, --verbose", "Show skipped files")
  .action(async (projectPath: string, opts: { gitLimit: string; verbose?: boolean }) => {
    try {
      await indexProject(projectPath, {
        gitLimit: parseInt(opts.gitLimit),
        verbose: opts.verbose,
      });
    } catch (e) {
      console.error("Indexing failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await disconnect();
    }
  });

// ── memory search <query> ─────────────────────────────────────────────────────
program
  .command("search <query>")
  .description("Semantic search across indexed memory")
  .option("-k, --top-k <n>", "Number of results", "6")
  .option("-g, --graph", "Include call graph edges in results")
  .action(async (query: string, opts: { topK: string; graph?: boolean }) => {
    try {
      const result = await searchMemory(query, {
        topK: parseInt(opts.topK),
        graph: opts.graph,
      });
      console.log(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Search failed:", msg);
      if (msg.includes("connect")) {
        console.error("Is Redis running? Try: docker compose up -d");
      }
      process.exit(1);
    } finally {
      await disconnect();
    }
  });

// ── memory graph <fn-name> ────────────────────────────────────────────────────
program
  .command("graph <function>")
  .description("Show call graph around a function")
  .option("-d, --depth <n>", "Graph traversal depth", "2")
  .action(async (fnName: string, opts: { depth: string }) => {
    try {
      const result = await showGraph(fnName, parseInt(opts.depth));
      console.log(result);
    } catch (e) {
      console.error("Graph failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      await disconnect();
    }
  });

// ── memory stats ──────────────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show memory store statistics")
  .action(async () => {
    try {
      const { total, graphNodes } = await getStats();
      const byCategory = await getAllByCategory();
      console.log("\nMemory Store Stats");
      console.log("──────────────────");
      console.log(`Total chunks : ${total}`);
      console.log(`Graph nodes  : ${graphNodes}`);
      console.log("\nBy category:");
      for (const [cat, count] of Object.entries(byCategory)) {
        console.log(`  ${cat.padEnd(12)} ${count}`);
      }
      console.log();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Stats failed:", msg);
      if (msg.includes("connect")) {
        console.error("Is Redis running? Try: docker compose up -d");
      }
      process.exit(1);
    } finally {
      await disconnect();
    }
  });

program.parse();

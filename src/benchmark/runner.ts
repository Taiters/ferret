import fs from "fs";
import type { Searcher } from "../search/searcher.js";
import { benchmarkPath } from "../projects.js";
import type { BenchmarkFile, BenchmarkResults } from "./types.js";

const TOP_K = 5;
const WORST_PERFORMERS_COUNT = 5;

export interface RunOptions {
  projectRoot: string;
}

export async function runBenchmark(
  searcher: Searcher,
  opts: RunOptions,
): Promise<BenchmarkResults> {
  const filePath = benchmarkPath(opts.projectRoot);
  if (!fs.existsSync(filePath)) {
    console.error(
      "\n  No benchmark file found. Run first:\n\n" +
        "    ferret benchmark generate\n",
    );
    process.exit(1);
  }

  const benchmarkFile = JSON.parse(fs.readFileSync(filePath, "utf8")) as BenchmarkFile;
  const { entries } = benchmarkFile;

  if (entries.length === 0) {
    console.error("  Benchmark file has no entries.");
    process.exit(1);
  }

  console.log(`\n  Benchmark: ${filePath}`);
  console.log(`  Generated: ${new Date(benchmarkFile.generated).toLocaleString()}`);
  console.log(`  Entries  : ${entries.length} chunks, ${entries.reduce((s, e) => s + e.questions.length, 0)} questions\n`);

  let totalQuestions = 0;
  let hits1 = 0;
  let hits3 = 0;
  let hits5 = 0;
  let reciprocalRankSum = 0;

  // Per-entry stats for worst-performer report
  const entryStats: Array<{ symbolId: string; found: number; total: number }> = [];

  let done = 0;
  for (const entry of entries) {
    let entryFound = 0;

    for (const question of entry.questions) {
      totalQuestions++;
      const hits = await searcher.search(question, TOP_K);
      const rank = hits.findIndex((h) => h.symbolId === entry.symbolId) + 1; // 0 if not found

      if (rank > 0) {
        entryFound++;
        if (rank === 1) hits1++;
        if (rank <= 3) hits3++;
        hits5++; // rank is always ≤ TOP_K if found
        reciprocalRankSum += 1 / rank;
      }
    }

    entryStats.push({
      symbolId: entry.symbolId,
      found: entryFound,
      total: entry.questions.length,
    });

    done++;
    process.stdout.write(`\r  Evaluating: ${done}/${entries.length}`);
  }
  process.stdout.write("\n");

  const worstPerformers = [...entryStats]
    .sort((a, b) => a.found / a.total - b.found / b.total)
    .slice(0, WORST_PERFORMERS_COUNT);

  return {
    totalQuestions,
    recall1: hits1 / totalQuestions,
    recall3: hits3 / totalQuestions,
    recall5: hits5 / totalQuestions,
    mrr: reciprocalRankSum / totalQuestions,
    worstPerformers,
  };
}

export function printResults(results: BenchmarkResults): void {
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  console.log("\n  Results");
  console.log("  ─────────────────────────────");
  console.log(`  Questions    : ${results.totalQuestions}`);
  console.log(`  Recall@1     : ${pct(results.recall1)}`);
  console.log(`  Recall@3     : ${pct(results.recall3)}`);
  console.log(`  Recall@5     : ${pct(results.recall5)}`);
  console.log(`  MRR          : ${results.mrr.toFixed(3)}`);

  if (results.worstPerformers.length > 0) {
    console.log("\n  Worst performers (by questions found / total):");
    for (const wp of results.worstPerformers) {
      console.log(`    ${wp.found}/${wp.total}  ${wp.symbolId}`);
    }
  }
  console.log();
}

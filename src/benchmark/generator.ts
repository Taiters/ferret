import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import type { ChunkStore } from "../store/types.js";
import type { Chunk } from "../types.js";
import { benchmarkPath } from "../projects.js";
import type { BenchmarkEntry, BenchmarkFile } from "./types.js";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_SAMPLE = 100;
const CONCURRENCY = 5;

// Max content length to send per chunk — long functions add cost without
// meaningfully improving question quality.
const MAX_CONTENT_CHARS = 1500;

const SYSTEM_PROMPT = `You are generating evaluation questions for a semantic code search system.

Given a code chunk, generate exactly 3 natural language questions that a developer might type into a search box to find this code. Vary the angle:
- What the code does (functional description)
- How it works (implementation detail)
- When or why to use it

Respond with ONLY a JSON object in this exact format, no other text:
{"questions": ["question 1", "question 2", "question 3"]}`;

export interface GenerateOptions {
  sample?: number;
  model?: string;
  projectRoot: string;
}

async function generateQuestions(
  client: Anthropic,
  chunk: Chunk,
  model: string,
): Promise<string[]> {
  const content = `File: ${chunk.file}
Name: ${chunk.name}

\`\`\`
${chunk.content.slice(0, MAX_CONTENT_CHARS)}
\`\`\``;

  const response = await client.messages.create({
    model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  // Extract the JSON object from the response — the model sometimes wraps it in
  // markdown code fences (```json ... ```) despite instructions not to.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in response: ${text.slice(0, 100)}`);
  const parsed = JSON.parse(match[0]) as { questions: string[] };
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("Invalid response shape");
  }
  return parsed.questions.slice(0, 3);
}

function estimateCost(sampleSize: number, model: string): string {
  // Rough per-request: ~150 system + ~400 content input, ~100 output
  // Haiku 4.5: $1/M input, $5/M output
  const inputPerRequest = 550;
  const outputPerRequest = 100;
  const inputRate = model.includes("haiku") ? 1 : model.includes("sonnet") ? 3 : 15;
  const outputRate = model.includes("haiku") ? 5 : model.includes("sonnet") ? 15 : 75;
  const cost =
    (sampleSize * inputPerRequest * inputRate) / 1_000_000 +
    (sampleSize * outputPerRequest * outputRate) / 1_000_000;
  return `~$${cost.toFixed(2)}`;
}

export async function generateBenchmark(
  store: ChunkStore,
  opts: GenerateOptions,
): Promise<void> {
  const model = opts.model ?? DEFAULT_MODEL;
  const sampleSize = opts.sample ?? DEFAULT_SAMPLE;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "\n  Error: ANTHROPIC_API_KEY is not set.\n" +
        "  Export it before running benchmark generate:\n\n" +
        "    export ANTHROPIC_API_KEY=sk-ant-...\n",
    );
    process.exit(1);
  }

  console.log(`\n  Model  : ${model}`);
  console.log(`  Sample : ${sampleSize} chunks`);
  console.log(`  Cost   : ${estimateCost(sampleSize, model)} (estimated)`);
  console.log();

  console.log("  Sampling chunks from index...");
  const chunks = await store.sampleChunks(sampleSize);
  if (chunks.length === 0) {
    console.error("  No chunks found. Run: ferret index <path>");
    process.exit(1);
  }
  const actual = chunks.length;
  if (actual < sampleSize) {
    console.log(`  (only ${actual} chunks available — using all)\n`);
  }

  const client = new Anthropic({ apiKey });
  const entries: BenchmarkEntry[] = [];
  let done = 0;
  let failed = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((chunk) => generateQuestions(client, chunk, model)),
    );

    for (let j = 0; j < batch.length; j++) {
      done++;
      const result = results[j];
      const chunk = batch[j];
      if (result.status === "fulfilled") {
        entries.push({
          chunkId: chunk.id,
          symbolId: chunk.symbolId,
          file: chunk.file,
          name: chunk.name,
          questions: result.value,
        });
      } else {
        failed++;
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        process.stdout.write("\n");
        console.error(`  Error (${chunk.symbolId}): ${reason}`);
      }
      process.stdout.write(`\r  Generating: ${done}/${actual} (${failed} failed)`);
    }
  }
  process.stdout.write("\n");

  const benchmarkFile: BenchmarkFile = {
    generated: new Date().toISOString(),
    model,
    entries,
  };

  const outPath = benchmarkPath(opts.projectRoot);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(benchmarkFile, null, 2));

  console.log(`\n  Generated ${entries.length} entries (${failed} skipped)`);
  console.log(`  Saved to: ${outPath}`);
  console.log(`  Run evaluation: ferret benchmark run\n`);
}

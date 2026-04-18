import { glob } from "glob";
import fs from "fs";
import path from "path";
import { parseFile, chunkPlainText } from "./ingestion/parser.js";
import { parseMarkdown } from "./ingestion/markdown.js";
import { parseGitHistory } from "./ingestion/git.js";
import { embedBatch } from "./embedder.js";
import { ensureIndex, upsertChunk, flushAll, setGraphEdges } from "./store.js";
import type { Chunk, IndexOptions } from "./types.js";

// ── Ignore patterns ───────────────────────────────────────────────────────────
const IGNORE_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/__pycache__/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/*.egg-info/**",
];

const IGNORE_FILES = [
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/*.pb",
  "**/*.pyc",
  "**/*.pyo",
];

const CODE_EXTS = new Set([".py", ".js", ".mjs", ".jsx", ".ts", ".tsx"]);
const MD_EXTS = new Set([".md", ".mdx", ".rst", ".txt"]);
const MAX_FILE_BYTES = 500_000;

// ── Progress helper ───────────────────────────────────────────────────────────
function progress(label: string, current: number, total: number): void {
  const pct = Math.round((current / total) * 100);
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  ${label} [${bar}] ${pct}% (${current}/${total})`);
  if (current === total) process.stdout.write("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function indexProject(
  projectPath: string,
  { gitLimit = 100, verbose = false }: IndexOptions = {},
): Promise<void> {
  const absPath = path.resolve(projectPath);
  console.log(`\n📂 Indexing: ${absPath}\n`);

  await ensureIndex();

  console.log("  🗑  Flushing existing index...");
  await flushAll();

  // ── 1. Collect files ───────────────────────────────────────────────────────
  const allFiles = await glob("**/*", {
    cwd: absPath,
    nodir: true,
    ignore: [...IGNORE_DIRS, ...IGNORE_FILES],
    absolute: true,
  });

  const codeFiles = allFiles.filter((f) => CODE_EXTS.has(path.extname(f).toLowerCase()));
  const mdFiles = allFiles.filter((f) => MD_EXTS.has(path.extname(f).toLowerCase()));

  console.log(`  Found: ${codeFiles.length} code files, ${mdFiles.length} doc files\n`);

  // ── 2. Parse & collect all chunks ─────────────────────────────────────────
  const allChunks: Chunk[] = [];
  const callGraph = new Map<string, { calls: string[]; file: string }>();

  // Code files
  console.log("  📄 Parsing code files...");
  for (let i = 0; i < codeFiles.length; i++) {
    const file = codeFiles[i];
    progress("code", i + 1, codeFiles.length);

    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      if (verbose) console.log(`\n    skip (too large): ${file}`);
      continue;
    }

    const source = fs.readFileSync(file, "utf8");
    const { chunks, graph } = parseFile(file, source);

    if (chunks.length === 0) {
      allChunks.push(...chunkPlainText(file, source, "code"));
    } else {
      allChunks.push(...chunks);
    }

    for (const [name, data] of graph) {
      if (!callGraph.has(name)) {
        callGraph.set(name, data);
      }
    }
  }

  // Markdown / docs
  if (mdFiles.length > 0) {
    console.log("\n  📝 Parsing docs...");
    for (let i = 0; i < mdFiles.length; i++) {
      progress("docs", i + 1, mdFiles.length);
      const file = mdFiles[i];
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      const source = fs.readFileSync(file, "utf8");
      allChunks.push(...parseMarkdown(file, source));
    }
  }

  // Git history
  console.log("\n  🔀 Reading git history...");
  const gitChunks = await parseGitHistory(absPath, gitLimit);
  allChunks.push(...gitChunks);
  console.log(`    ${gitChunks.length} commit batch(es) ingested`);

  // ── 3. Embed all chunks ────────────────────────────────────────────────────
  console.log(`\n  🧠 Embedding ${allChunks.length} chunks...`);
  const texts = allChunks.map((c) => `${c.name}\n${c.content}`);
  const vectors = await embedBatch(texts, (i, t) => progress("embed", i, t));

  // ── 4. Store chunks + vectors ──────────────────────────────────────────────
  console.log("\n  💾 Writing to Redis...");
  for (let i = 0; i < allChunks.length; i++) {
    progress("store", i + 1, allChunks.length);
    await upsertChunk({ ...allChunks[i], vector: vectors[i] });
  }

  // ── 5. Build calledBy edges and store graph ────────────────────────────────
  console.log("\n  🕸  Building call graph...");
  const calledBy = new Map<string, Set<string>>();

  for (const [caller, { calls }] of callGraph) {
    for (const callee of calls) {
      if (!calledBy.has(callee)) calledBy.set(callee, new Set());
      calledBy.get(callee)!.add(caller);
    }
  }

  for (const [name, { calls }] of callGraph) {
    await setGraphEdges(name, {
      calls,
      calledBy: [...(calledBy.get(name) ?? [])],
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const byCategory: Record<string, number> = {};
  for (const c of allChunks) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;

  console.log("\n  ✅ Done!\n");
  console.log("  Indexed:");
  for (const [cat, count] of Object.entries(byCategory)) {
    console.log(`    ${cat.padEnd(10)} ${count} chunks`);
  }
  console.log(`    ${"graph".padEnd(10)} ${callGraph.size} nodes`);
  console.log();
}

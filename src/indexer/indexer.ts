import { glob } from "glob";
import fs from "fs";
import path from "path";
import type { Embedder } from "../embedding/types.js";
import type { ChunkStore } from "../store/types.js";
import type { ParserRegistry } from "../ingestion/parserRegistry.js";
import { chunkPlainText } from "../ingestion/parserUtils.js";
import { registerProject, writeProjectConfig } from "../projects.js";
import type { Chunk, EmbeddedChunk, CallGraph } from "../types.js";

export interface IndexOptions {
  verbose?: boolean;
  model?: string;
}

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
  "**/.ferret/**",
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

const MAX_FILE_BYTES = 500_000;

function progress(label: string, current: number, total: number): void {
  const pct = Math.round((current / total) * 100);
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  ${label} [${bar}] ${pct}% (${current}/${total})`);
  if (current === total) process.stdout.write("\n");
}

function formatForEmbedding(chunk: Chunk, parsers: ParserRegistry): string {
  const ext = path.extname(chunk.file).toLowerCase();
  const parser = parsers.get(ext);
  if (parser?.formatForEmbedding) return parser.formatForEmbedding(chunk);
  return `${chunk.file}\n${chunk.name}\n${chunk.content}`;
}

export class Indexer {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: ChunkStore,
    private readonly parsers: ParserRegistry,
  ) {}

  async index(projectPath: string, opts: IndexOptions = {}): Promise<void> {
    const absPath = path.resolve(projectPath);
    console.log(`\n📂 Indexing: ${absPath}\n`);

    await this.store.flush();

    const files = await this.discoverFiles(absPath, opts);
    const { chunks, graph } = this.parseAll(files, absPath, opts);

    console.log(`\n  🧠 Embedding ${chunks.length} chunks...`);
    const embedded = await this.embedChunks(chunks);

    // Normalize graph file paths to relative before writing
    const relGraph: CallGraph = new Map();
    for (const [name, { calls, file }] of graph) {
      relGraph.set(name, { calls, file: path.isAbsolute(file) ? path.relative(absPath, file) : file });
    }

    console.log("\n  💾 Storing chunks...");
    await this.store.write(embedded, relGraph);

    console.log("\n  🔍 Building full-text search index...");
    await this.store.buildFtsIndex();

    const indexedAt = new Date().toISOString();
    writeProjectConfig(absPath, { indexedAt, model: opts.model });
    registerProject(absPath);

    console.log("\n  ✅ Done!\n");
    console.log(`  Indexed ${chunks.length} chunks\n`);
  }

  private async discoverFiles(absPath: string, opts: IndexOptions): Promise<string[]> {
    const allFiles = await glob("**/*", {
      cwd: absPath,
      nodir: true,
      ignore: [...IGNORE_DIRS, ...IGNORE_FILES],
      absolute: true,
    });
    const CODE_EXTS = new Set(this.parsers.registeredExtensions());
    const codeFiles = allFiles.filter((f) => CODE_EXTS.has(path.extname(f).toLowerCase()));
    if (opts.verbose) {
      const skipped = allFiles.filter((f) => !CODE_EXTS.has(path.extname(f).toLowerCase()));
      for (const f of skipped) console.log(`    skip: ${path.relative(absPath, f)}`);
    }
    console.log(`  Found: ${codeFiles.length} code files\n`);
    return codeFiles;
  }

  private parseAll(
    files: string[],
    projectRoot: string,
    opts: IndexOptions,
  ): { chunks: Chunk[]; graph: CallGraph } {
    const allChunks: Chunk[] = [];
    const graph: CallGraph = new Map();

    console.log("  📄 Parsing code files...");
    for (let i = 0; i < files.length; i++) {
      progress("parse", i + 1, files.length);
      const file = files[i];
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) {
        if (opts.verbose) console.log(`\n    skip (too large): ${file}`);
        continue;
      }

      const source = fs.readFileSync(file, "utf8");
      const relFile = path.relative(projectRoot, file);
      const result = this.parsers.parseFile(file, source);

      const parsedChunks = result.chunks.length > 0 ? result.chunks : chunkPlainText(file, source);

      for (const pc of parsedChunks) {
        allChunks.push({
          id: pc.id,
          symbolId: `${relFile}:${pc.name}`,
          file: relFile,
          name: pc.name,
          content: pc.content,
          startLine: pc.startLine,
          endLine: pc.endLine,
        });
      }

      for (const [name, data] of result.graph) {
        if (!graph.has(name)) graph.set(name, data);
      }
    }

    return { chunks: allChunks, graph };
  }

  private async embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    const results: EmbeddedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      progress("embed", i + 1, chunks.length);
      const vector = await this.embedder.embed(formatForEmbedding(chunks[i], this.parsers));
      results.push({ ...chunks[i], vector });
    }
    return results;
  }
}

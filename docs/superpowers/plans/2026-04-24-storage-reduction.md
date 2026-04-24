# Storage Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `.ferret` DB size ~4× and improve indexing speed by switching to a smaller default embedding model, storing vectors as Float16, and compacting the LanceDB store after each index run.

**Architecture:** Three independent changes to `src/store/lancedb.ts`, `src/projects.ts`, `src/embedding/huggingface.ts`, `src/indexer/indexer.ts`, and `src/ferret.ts`. Implemented in dependency order: storage changes first (no config deps), then config system, then CLI wiring.

**Tech Stack:** TypeScript, `@lancedb/lancedb@0.14`, `apache-arrow` (transitive dep of lancedb), `@huggingface/transformers`, `vitest`

**Build:** `npm run build` (tsc). **Tests:** `npm test` (vitest). **Link:** `npm link` to test CLI locally.

---

### Task 1: Float16 vector storage

Write vectors as Float16 (2 bytes/dim) instead of the inferred Float32 (4 bytes/dim), halving vector storage with negligible precision loss.

**Files:**
- Modify: `src/store/lancedb.ts`

- [ ] **Step 1: Verify apache-arrow is importable**

Run in the project root:
```bash
node -e "import('apache-arrow').then(m => console.log(Object.keys(m).slice(0,5))).catch(e => console.error(e.message))"
```
Expected: prints Arrow type names. If it throws `Cannot find module 'apache-arrow'`, run `npm install apache-arrow` before continuing.

- [ ] **Step 2: Add the Float16 schema to `write()` in `src/store/lancedb.ts`**

Add this import at the top of the file (after existing imports):
```ts
import { Schema, Field, Utf8, Int32, FixedSizeList, Float16 } from "apache-arrow";
```

In the `write()` method, find the `createTable` call for `CHUNKS_TABLE`:
```ts
this._chunksTable = await db.createTable(CHUNKS_TABLE, rows);
```

Replace it with:
```ts
const dim = chunks[0].vector.length;
const chunksSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("symbol_id", new Utf8()),
  new Field("file", new Utf8()),
  new Field("name", new Utf8()),
  new Field("content", new Utf8()),
  new Field("start_line", new Int32()),
  new Field("end_line", new Int32()),
  new Field("vector", new FixedSizeList(dim, new Field("item", new Float16(), false))),
]);
this._chunksTable = await db.createTable(CHUNKS_TABLE, rows, { schema: chunksSchema });
```

- [ ] **Step 3: Build**

```bash
npm run build
```
Expected: exits 0, no TypeScript errors.

- [ ] **Step 4: Smoke test by re-indexing this project**

```bash
ferret index . && ferret stats
```
Expected: "Done!" message, stats show chunk count. Then check DB size:
```bash
du -sh .ferret/db
```
Expected: smaller than the pre-change ~1.1MB (target ~600KB or less before the model change).

- [ ] **Step 5: Commit**

```bash
git add src/store/lancedb.ts
git commit -m "perf: store vectors as Float16 to halve vector storage"
```

---

### Task 2: Post-write compaction

Remove accumulated version manifests and transaction logs after each index run.

**Files:**
- Modify: `src/store/lancedb.ts`

- [ ] **Step 1: Add compaction at the end of `buildFtsIndex()` in `src/store/lancedb.ts`**

Find the `buildFtsIndex()` method:
```ts
async buildFtsIndex(): Promise<void> {
  const table = await this.openChunksTable();
  if (!table) return;
  await table.createIndex("content", {
    config: Index.fts({ withPosition: false }),
    replace: true,
  });
}
```

Replace it with:
```ts
async buildFtsIndex(): Promise<void> {
  const table = await this.openChunksTable();
  if (!table) return;
  await table.createIndex("content", {
    config: Index.fts({ withPosition: false }),
    replace: true,
  });
  await table.optimize({ cleanupOlderThan: new Date() });
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Re-index and verify no extra version files accumulate**

```bash
ferret index . && ls .ferret/db/chunks.lance/_versions/
```
Expected: only a single manifest file (no old versions left over).

- [ ] **Step 4: Commit**

```bash
git add src/store/lancedb.ts
git commit -m "perf: compact LanceDB tables after each index run"
```

---

### Task 3: Model config helpers in `projects.ts`

Add `GlobalConfig`, `readGlobalConfig()`, `writeGlobalConfig()`, and `resolveModel()` to `projects.ts`. Also extend `ProjectConfig` with `model?: string` and export `DEFAULT_EMBEDDING_MODEL`.

**Files:**
- Modify: `src/projects.ts`
- Create: `tests/projects/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/projects/config.test.ts`:
```ts
import { describe, test, expect } from "vitest";
import { resolveModel, DEFAULT_EMBEDDING_MODEL } from "../../src/projects.js";

describe("resolveModel", () => {
  test("flag value takes priority over global config", () => {
    expect(resolveModel("Xenova/flag-model", { model: "Xenova/global-model" })).toBe("Xenova/flag-model");
  });

  test("global config model is used when no flag", () => {
    expect(resolveModel(undefined, { model: "Xenova/all-mpnet-base-v2" })).toBe("Xenova/all-mpnet-base-v2");
  });

  test("falls back to DEFAULT_EMBEDDING_MODEL when global config has no model", () => {
    expect(resolveModel(undefined, {})).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  test("DEFAULT_EMBEDDING_MODEL is a non-empty string", () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBeTypeOf("string");
    expect(DEFAULT_EMBEDDING_MODEL.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- tests/projects/config.test.ts
```
Expected: FAIL — `resolveModel` and `DEFAULT_EMBEDDING_MODEL` not exported from `projects.ts`.

- [ ] **Step 3: Implement the config helpers in `src/projects.ts`**

At the top of `src/projects.ts`, after the existing imports, add:
```ts
export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export interface GlobalConfig {
  model?: string;
}

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".local", "share", "ferret", "config.json");
```

Change the existing `ProjectConfig` interface from:
```ts
export interface ProjectConfig {
  indexedAt: string;
}
```
to:
```ts
export interface ProjectConfig {
  indexedAt: string;
  model?: string;
}
```

After `readProjectConfig()`, add:
```ts
export function readGlobalConfig(): GlobalConfig {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf8")) as GlobalConfig;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  const dir = path.dirname(GLOBAL_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Resolves the embedding model for a new index run.
 * Resolution order: flagValue → globalCfg → DEFAULT_EMBEDDING_MODEL
 * The globalCfg parameter is injectable for testing; omit it to use the real global config.
 */
export function resolveModel(flagValue?: string, globalCfg?: GlobalConfig): string {
  if (flagValue) return flagValue;
  const g = globalCfg ?? readGlobalConfig();
  return g.model ?? DEFAULT_EMBEDDING_MODEL;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test -- tests/projects/config.test.ts
```
Expected: 4 passing tests.

- [ ] **Step 5: Build**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/projects.ts tests/projects/config.test.ts
git commit -m "feat: add model config helpers and GlobalConfig to projects.ts"
```

---

### Task 4: Indexer writes model to project config

Pass the model name through `IndexOptions` so it gets persisted in `.ferret/index-info.json` after indexing.

**Files:**
- Modify: `src/indexer/indexer.ts`
- Modify: `tests/indexer/indexer.test.ts`

- [ ] **Step 1: Write a failing test**

Add this test to `tests/indexer/indexer.test.ts` (inside the `describe("Indexer")` block, after the existing test):
```ts
test("writes model to project config after indexing", async () => {
  const { Indexer } = await import("../../src/indexer/indexer.js");
  const indexer = new Indexer(mockEmbedder, mockStore, {} as ParserRegistry);
  await indexer.index("/tmp", { model: "Xenova/test-model" }).catch(() => {});

  const fs = await import("fs");
  const configPath = "/tmp/.ferret/index-info.json";
  expect(fs.existsSync(configPath)).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  expect(config.model).toBe("Xenova/test-model");
});
```

Also add `sampleChunks` to the `mockStore` to satisfy the full `ChunkStore` interface (TypeScript will catch this):
```ts
const mockStore: ChunkStore = {
  flush: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  buildFtsIndex: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  getSymbol: vi.fn().mockResolvedValue(null),
  getGraphEdges: vi.fn().mockResolvedValue({ calls: [], calledBy: [] }),
  getStats: vi.fn().mockResolvedValue({ chunks: 0, graphNodes: 0 }),
  sampleChunks: vi.fn().mockResolvedValue([]),
  disconnect: vi.fn().mockResolvedValue(undefined),
};
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- tests/indexer/indexer.test.ts
```
Expected: the new test FAILS (config.model is undefined).

- [ ] **Step 3: Update `IndexOptions` and `index()` in `src/indexer/indexer.ts`**

Change the interface:
```ts
export interface IndexOptions {
  verbose?: boolean;
  model?: string;
}
```

In the `index()` method, find:
```ts
const indexedAt = new Date().toISOString();
writeProjectConfig(absPath, { indexedAt });
```

Replace with:
```ts
const indexedAt = new Date().toISOString();
writeProjectConfig(absPath, { indexedAt, model: opts.model });
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Build**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/indexer.ts tests/indexer/indexer.test.ts
git commit -m "feat: persist embedding model name in project config after indexing"
```

---

### Task 5: Wire model into the CLI

Add `--model` to `ferret index`, read model from project config for search/symbol/graph, add `Model` line to `ferret stats`, and add `ferret models` command.

**Files:**
- Modify: `src/ferret.ts`

- [ ] **Step 1: Add `resolveProjectRoot()` helper and update imports in `src/ferret.ts`**

Add to the imports from `./projects.js`:
```ts
import {
  localDbPath,
  resolveProjectFromCwd,
  readRegistry,
  registerProject,
  readProjectConfig,
  resolveModel,
  DEFAULT_EMBEDDING_MODEL,
} from "./projects.js";
```

Add a `resolveProjectRoot()` helper just below `resolveDbPath()`:
```ts
function resolveProjectRoot(explicitProjectPath?: string): string {
  if (explicitProjectPath) return path.resolve(explicitProjectPath);
  const detected = resolveProjectFromCwd();
  if (detected) return detected;
  throw new Error(
    "No indexed project found in the current directory tree.\n" +
      "Run: ferret index <path>\n" +
      "Or specify: --project <path>",
  );
}
```

Update `resolveDbPath()` to delegate:
```ts
function resolveDbPath(explicitProjectPath?: string): string {
  return localDbPath(resolveProjectRoot(explicitProjectPath));
}
```

- [ ] **Step 2: Add `--model` option to `ferret index` and resolve model**

Find the `index` command action. Change:
```ts
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
```

To:
```ts
program
  .command("index <path>")
  .description("Index a codebase")
  .option("-v, --verbose", "Show skipped files")
  .option("--gitignore", "Create .ferret/.gitignore to exclude db/")
  .option("--model <name>", "Embedding model (overrides global config)")
  .action(async (projectPath: string, opts: { verbose?: boolean; gitignore?: boolean; model?: string }) => {
    const absPath = path.resolve(projectPath);
    const model = resolveModel(opts.model);
    const store = new LanceDbStore(localDbPath(absPath));
    const embedder = new HuggingFaceEmbedder(model);
    const indexer = new Indexer(embedder, store, registry);
```

Also update the `indexer.index()` call to pass the model:
```ts
await indexer.index(absPath, { verbose: opts.verbose, model });
```

- [ ] **Step 3: Read project model in `search`, `symbol`, and `graph` commands**

For each of `search`, `symbol`, and `graph` commands: replace the `new HuggingFaceEmbedder()` call (no args) with one that reads the project config model.

In the **search** command action, replace:
```ts
const store = new LanceDbStore(resolveDbPath(opts.project));
const embedder = new HuggingFaceEmbedder();
```
with:
```ts
const projectRoot = resolveProjectRoot(opts.project);
const store = new LanceDbStore(localDbPath(projectRoot));
const model = readProjectConfig(projectRoot)?.model ?? DEFAULT_EMBEDDING_MODEL;
const embedder = new HuggingFaceEmbedder(model);
```

In the **benchmark run** command action, apply the same pattern (it also creates a `HuggingFaceEmbedder()`):
```ts
const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectFromCwd() ?? process.cwd();
const store = new LanceDbStore(localDbPath(projectRoot));
const model = readProjectConfig(projectRoot)?.model ?? DEFAULT_EMBEDDING_MODEL;
const embedder = new HuggingFaceEmbedder(model);
```

The **symbol** and **graph** commands do not create a `HuggingFaceEmbedder` — leave them unchanged.

- [ ] **Step 4: Add `Model` line to `ferret stats`**

Find the stats command action. Replace:
```ts
  const store = new LanceDbStore(resolveDbPath(opts.project));
  try {
    const { chunks, graphNodes } = await store.getStats();
    console.log("\nFerret Stats");
    console.log("──────────────────");
    console.log(`Chunks      : ${chunks}`);
    console.log(`Graph nodes : ${graphNodes}`);
    console.log();
```
with:
```ts
  const projectRoot = resolveProjectRoot(opts.project);
  const store = new LanceDbStore(localDbPath(projectRoot));
  const config = readProjectConfig(projectRoot);
  try {
    const { chunks, graphNodes } = await store.getStats();
    console.log("\nFerret Stats");
    console.log("──────────────────");
    console.log(`Chunks      : ${chunks}`);
    console.log(`Graph nodes : ${graphNodes}`);
    if (config?.model) console.log(`Model       : ${config.model}`);
    console.log();
```

- [ ] **Step 5: Add `ferret models` command**

Add this block before `program.parse()`:
```ts
// ── ferret models ─────────────────────────────────────────────────────────────
program
  .command("models")
  .description("List suggested embedding models")
  .action(() => {
    console.log(
      "\nSuggested models (any @huggingface/transformers-compatible model can be used via --model <name>):\n",
    );
    const cols = "  Model                               Dims  Speed    Quality  Notes";
    const rows = [
      "  Xenova/all-MiniLM-L6-v2 (default)   384   Fast     Good     Best balance of size and quality",
      "  Xenova/all-mpnet-base-v2             768   Slow     Best     Highest quality, 4× larger DB",
      "  Xenova/paraphrase-MiniLM-L3-v2      384   Fastest  Fair     Smallest footprint",
    ];
    console.log(cols);
    for (const row of rows) console.log(row);
    console.log();
  });
```

- [ ] **Step 6: Build**

```bash
npm run build
```
Expected: exits 0, no TypeScript errors.

- [ ] **Step 7: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 8: Smoke test the new CLI surface**

```bash
ferret models
ferret index . --model Xenova/all-MiniLM-L6-v2
ferret stats
ferret search "how does embedding work"
```
Expected: `ferret models` prints the table. `ferret index` runs successfully. `ferret stats` shows `Model: Xenova/all-MiniLM-L6-v2`. `ferret search` returns relevant results.

- [ ] **Step 9: Commit**

```bash
git add src/ferret.ts
git commit -m "feat: add --model flag, ferret models command, and per-project model resolution"
```

---

### Task 6: Change the default embedding model

Update `DEFAULT_MODEL` in `src/embedding/huggingface.ts` to match `DEFAULT_EMBEDDING_MODEL` in `projects.ts` (`Xenova/all-MiniLM-L6-v2`). This makes `new HuggingFaceEmbedder()` (no args) consistent with `resolveModel()` output when no config is set.

**Files:**
- Modify: `src/embedding/huggingface.ts`

- [ ] **Step 1: Update `DEFAULT_MODEL` in `src/embedding/huggingface.ts`**

Change:
```ts
export const DEFAULT_MODEL = "Xenova/all-mpnet-base-v2";
```
to:
```ts
export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
```

- [ ] **Step 2: Build and test**

```bash
npm run build && npm test
```
Expected: exits 0, all tests pass.

- [ ] **Step 3: Re-index and measure final DB size**

```bash
ferret index .
du -sh .ferret/db
```
Expected: DB is ~250–400KB (down from ~1.1MB before this feature). Run `ferret search "how does embedding work"` to confirm search still returns relevant results.

- [ ] **Step 4: Commit**

```bash
git add src/embedding/huggingface.ts
git commit -m "perf: change default embedding model to all-MiniLM-L6-v2 (384-dim)"
```

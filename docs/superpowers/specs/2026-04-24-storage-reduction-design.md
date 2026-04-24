# Storage Reduction Design

**Date:** 2026-04-24

## Goal

Reduce `.ferret` DB size and improve indexing speed through three complementary changes: a configurable embedding model with a smaller default, Float16 vector storage, and post-write compaction. Backwards compatibility is not required (tool is in active development).

## Background

The dominant cost in the DB is vector storage. With the current `all-mpnet-base-v2` model (768-dim Float32), each chunk costs 3,072 bytes in vectors alone — 76% of total DB size. For a 156KB codebase, the DB is ~1.1MB (7× ratio). At scale this compounds significantly.

The three changes together yield ~4× reduction in vector storage:
- 384-dim model → 2× reduction
- Float16 storage → 2× additional reduction
- Compaction → removes accumulated version/transaction overhead

---

## 1. Model Config System

### Config files

**Global config:** `~/.local/share/ferret/config.json`
```json
{ "model": "Xenova/all-MiniLM-L6-v2" }
```

**Per-project config:** `.ferret/config.json` (already exists with `indexedAt`)
```json
{ "indexedAt": "2026-04-24T08:16:00Z", "model": "Xenova/all-MiniLM-L6-v2" }
```

### Resolution order

For **indexing**: `--model` flag → global config → hardcoded default (`Xenova/all-MiniLM-L6-v2`)

For **search/graph/symbol**: project config always wins. Vectors are model-specific — changing the global default after indexing must not break existing projects.

The resolved model name is written to `.ferret/config.json` at the end of every `ferret index` run.

### CLI changes

`ferret index <path> [--model <name>]` — accepts optional model override.

`ferret models` — new command, prints a curated table of suggested models:

```
Suggested models (any @huggingface/transformers-compatible model can be used via --model <name>):

  Model                               Dims  Speed    Quality  Notes
  Xenova/all-MiniLM-L6-v2 (default)   384   Fast     Good     Best balance of size and quality
  Xenova/all-mpnet-base-v2             768   Slow     Best     Highest quality, 4× larger DB
  Xenova/paraphrase-MiniLM-L3-v2      384   Fastest  Fair     Smallest footprint
```

`ferret stats` — gains a `Model` line showing what model was used to index the current project.

### Files affected

- `src/projects.ts` — extend `ProjectConfig` type with `model?: string`; add global config read/write helpers
- `src/ferret.ts` — add `--model` option to `index` command; add `models` command
- `src/indexer/indexer.ts` — accept and pass through resolved model name
- `src/embedding/huggingface.ts` — change `DEFAULT_MODEL` to `Xenova/all-MiniLM-L6-v2`

---

## 2. Float16 Vector Storage

When writing chunks to LanceDB, explicitly construct an Apache Arrow schema with `Float16` for the vector column instead of letting LanceDB infer `Float32`.

The vector dimension is not hardcoded — it's read from `chunks[0].vector.length` at write time, so the schema works for any model.

**Schema construction (pseudocode):**
```ts
const dim = chunks[0].vector.length;
const schema = new Schema([
  new Field('id', new Utf8()),
  new Field('symbol_id', new Utf8()),
  new Field('file', new Utf8()),
  new Field('name', new Utf8()),
  new Field('content', new Utf8()),
  new Field('start_line', new Int32()),
  new Field('end_line', new Int32()),
  new Field('vector', new FixedSizeList(dim, new Field('item', new Float16()))),
]);
```

LanceDB handles Float16/Float32 dtype mismatch between stored vectors and Float32 query vectors internally — no changes needed to `search()`.

**Files affected:** `src/store/lancedb.ts`

---

## 3. Post-Write Compaction

After `buildFtsIndex()` completes, call:

```ts
await this._chunksTable!.optimize({ cleanupOlderThan: new Date() });
```

This removes accumulated version manifests, transaction logs, and fragmented data files. Impact is small for a fresh single index run, but meaningful for projects re-indexed frequently.

**Files affected:** `src/store/lancedb.ts` only — compaction runs at the end of `buildFtsIndex()` in `LanceDbStore`. No new `ChunkStore` interface method needed; compaction is an implementation detail of the Lance storage backend.

---

## Expected Outcomes

| Metric | Before | After |
|---|---|---|
| Vector bytes/chunk (768-dim f32) | 3,072 B | — |
| Vector bytes/chunk (384-dim f16) | 768 B | **4× reduction** |
| DB size for this project | ~1.1 MB | ~350 KB (est.) |
| Embedding speed | baseline | ~2× faster |
| Search quality | all-mpnet (best) | all-MiniLM (good) |

import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import fs from "fs";
import os from "os";
import path from "path";
import type { Chunk, GraphEdges, SearchHit, StoreStats } from "./types.js";

const DB_PATH =
  process.env.MEMORY_DB_PATH ??
  path.join(os.homedir(), ".local", "share", "memory-skill", "db");

const CHUNKS_TABLE = "chunks";
const GRAPH_TABLE = "graph";

let _db: Connection | null = null;
let _chunksTable: Table | null = null;
let _graphTable: Table | null = null;

async function getDb(): Promise<Connection> {
  if (_db) return _db;
  fs.mkdirSync(DB_PATH, { recursive: true });
  _db = await lancedb.connect(DB_PATH);
  return _db;
}

// Exported for backwards-compat with any external callers (memory.ts doesn't use it directly)
export async function getClient(): Promise<Connection> {
  return getDb();
}

async function openChunksTable(): Promise<Table | null> {
  if (_chunksTable) return _chunksTable;
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(CHUNKS_TABLE)) return null;
  _chunksTable = await db.openTable(CHUNKS_TABLE);
  return _chunksTable;
}

async function openGraphTable(): Promise<Table | null> {
  if (_graphTable) return _graphTable;
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(GRAPH_TABLE)) return null;
  _graphTable = await db.openTable(GRAPH_TABLE);
  return _graphTable;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function ensureIndex(): Promise<void> {
  await getDb();
}

export async function upsertChunk(chunk: Chunk & { vector: number[] }): Promise<void> {
  const db = await getDb();
  const row = {
    id: chunk.id,
    file: chunk.file ?? "",
    category: chunk.category ?? "general",
    name: chunk.name ?? "",
    content: chunk.content ?? "",
    tags: (chunk.tags ?? []).join(","),
    start_line: chunk.start_line ?? 0,
    end_line: chunk.end_line ?? 0,
    vector: Array.from(chunk.vector),
  };

  if (!_chunksTable) {
    const names = await db.tableNames();
    if (names.includes(CHUNKS_TABLE)) {
      _chunksTable = await db.openTable(CHUNKS_TABLE);
      await _chunksTable.add([row]);
    } else {
      // createTable inserts the first row as part of creation
      _chunksTable = await db.createTable(CHUNKS_TABLE, [row]);
    }
  } else {
    await _chunksTable.add([row]);
  }
}

export async function search(queryVector: number[], topK = 6): Promise<SearchHit[]> {
  const table = await openChunksTable();
  if (!table) return [];

  const results = await table
    .vectorSearch(new Float32Array(queryVector))
    .distanceType("cosine")
    .limit(topK)
    .toArray();

  return results.map((row) => ({
    id: row.id as string,
    file: row.file as string,
    category: row.category as Chunk["category"],
    name: row.name as string,
    content: row.content as string,
    tags: row.tags ? (row.tags as string).split(",").filter(Boolean) : [],
    start_line: row.start_line as number,
    end_line: row.end_line as number,
    score: 1 - (row._distance as number),
  }));
}

// ── Call graph ────────────────────────────────────────────────────────────────

export async function setGraphEdges(
  fnKey: string,
  { calls = [], calledBy = [] }: GraphEdges,
): Promise<void> {
  const db = await getDb();
  const row = {
    fn_key: fnKey,
    calls: calls.join("|"),
    called_by: calledBy.join("|"),
  };

  if (!_graphTable) {
    const names = await db.tableNames();
    if (names.includes(GRAPH_TABLE)) {
      _graphTable = await db.openTable(GRAPH_TABLE);
    } else {
      _graphTable = await db.createTable(GRAPH_TABLE, [row]);
      return; // Row already inserted by createTable
    }
  }

  await _graphTable
    .mergeInsert("fn_key")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([row]);
}

export async function getGraphEdges(fnKey: string): Promise<GraphEdges> {
  const table = await openGraphTable();
  if (!table) return { calls: [], calledBy: [] };

  const results = await table
    .query()
    .where(`fn_key = '${fnKey.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray();

  if (results.length === 0) return { calls: [], calledBy: [] };
  const row = results[0];
  return {
    calls: row.calls ? (row.calls as string).split("|").filter(Boolean) : [],
    calledBy: row.called_by ? (row.called_by as string).split("|").filter(Boolean) : [],
  };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export async function flushAll(): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(CHUNKS_TABLE)) await db.dropTable(CHUNKS_TABLE);
  if (names.includes(GRAPH_TABLE)) await db.dropTable(GRAPH_TABLE);
  _chunksTable = null;
  _graphTable = null;
}

export async function getStats(): Promise<StoreStats> {
  try {
    const chunksTable = await openChunksTable();
    const graphTable = await openGraphTable();
    return {
      total: chunksTable ? await chunksTable.countRows() : 0,
      graphNodes: graphTable ? await graphTable.countRows() : 0,
    };
  } catch {
    return { total: 0, graphNodes: 0 };
  }
}

export async function getAllByCategory(): Promise<Record<string, number>> {
  const table = await openChunksTable();
  if (!table) return {};

  // Use countRows per category to avoid LanceDB's implicit query limit
  const categories: Chunk["category"][] = ["code", "docs", "git", "general"];
  const counts: Record<string, number> = {};
  for (const cat of categories) {
    const n = await table.countRows(`category = '${cat}'`);
    if (n > 0) counts[cat] = n;
  }
  return counts;
}

export async function disconnect(): Promise<void> {
  _chunksTable = null;
  _graphTable = null;
  _db = null;
}

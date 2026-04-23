import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import fs from "fs";
import type { Chunk, EmbeddedChunk, SearchHit, GraphEdges, StoreStats, CallGraph } from "../types.js";
import type { ChunkStore } from "./types.js";

const CHUNKS_TABLE = "chunks";
const GRAPH_TABLE = "graph";
const RRF_K = 60;

export class LanceDbStore implements ChunkStore {
  private readonly dbPath: string;
  private _db: Connection | null = null;
  private _chunksTable: Table | null = null;
  private _graphTable: Table | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async getDb(): Promise<Connection> {
    if (this._db) return this._db;
    fs.mkdirSync(this.dbPath, { recursive: true });
    this._db = await lancedb.connect(this.dbPath);
    return this._db;
  }

  private async openChunksTable(): Promise<Table | null> {
    if (this._chunksTable) return this._chunksTable;
    const db = await this.getDb();
    const names = await db.tableNames();
    if (!names.includes(CHUNKS_TABLE)) return null;
    this._chunksTable = await db.openTable(CHUNKS_TABLE);
    return this._chunksTable;
  }

  private async openGraphTable(): Promise<Table | null> {
    if (this._graphTable) return this._graphTable;
    const db = await this.getDb();
    const names = await db.tableNames();
    if (!names.includes(GRAPH_TABLE)) return null;
    this._graphTable = await db.openTable(GRAPH_TABLE);
    return this._graphTable;
  }

  async flush(): Promise<void> {
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(CHUNKS_TABLE)) await db.dropTable(CHUNKS_TABLE);
    if (names.includes(GRAPH_TABLE)) await db.dropTable(GRAPH_TABLE);
    this._chunksTable = null;
    this._graphTable = null;
  }

  async write(chunks: EmbeddedChunk[], graph: CallGraph): Promise<void> {
    if (chunks.length === 0) return;
    const db = await this.getDb();

    // ── Write chunks ──────────────────────────────────────────────────────────
    const rows = chunks.map((c) => ({
      id: c.id,
      symbol_id: c.symbolId,
      file: c.file,
      name: c.name,
      content: c.content,
      start_line: c.startLine,
      end_line: c.endLine,
      vector: Array.from(c.vector),
    }));

    const tableNames = await db.tableNames();
    if (tableNames.includes(CHUNKS_TABLE)) {
      this._chunksTable = await db.openTable(CHUNKS_TABLE);
      await this._chunksTable.add(rows);
    } else {
      this._chunksTable = await db.createTable(CHUNKS_TABLE, rows);
    }

    // ── Write graph (invert calledBy here) ───────────────────────────────────
    // The Indexer normalizes graph file paths to relative before calling write(),
    // so graph[name].file matches chunk.file directly.
    // Build name+file → symbolId lookup for resolving callee names.
    const fileNameToSymbolId = new Map<string, string>(); // key: "relFile:name"
    const nameToSymbolId = new Map<string, string>();     // key: name (first occurrence wins)
    for (const chunk of chunks) {
      fileNameToSymbolId.set(`${chunk.file}:${chunk.name}`, chunk.symbolId);
      if (!nameToSymbolId.has(chunk.name)) nameToSymbolId.set(chunk.name, chunk.symbolId);
    }

    function resolveSymbolId(name: string, relFile?: string): string {
      if (relFile) return fileNameToSymbolId.get(`${relFile}:${name}`) ?? nameToSymbolId.get(name) ?? name;
      return nameToSymbolId.get(name) ?? name;
    }

    // Build calledBy inverse map
    const calledByMap = new Map<string, Set<string>>();
    for (const [callerName, { calls, file }] of graph) {
      const callerSymbolId = resolveSymbolId(callerName, file);
      for (const callee of calls) {
        const calleeSymbolId = resolveSymbolId(callee);
        if (!calledByMap.has(calleeSymbolId)) calledByMap.set(calleeSymbolId, new Set());
        calledByMap.get(calleeSymbolId)!.add(callerSymbolId);
      }
    }

    const graphRows: Array<{ symbol_id: string; calls: string; called_by: string }> = [];
    for (const [callerName, { calls, file }] of graph) {
      const callerSymbolId = resolveSymbolId(callerName, file);
      const resolvedCalls = calls.map((c) => resolveSymbolId(c));
      const calledBy = [...(calledByMap.get(callerSymbolId) ?? [])];
      graphRows.push({
        symbol_id: callerSymbolId,
        calls: resolvedCalls.join("|"),
        called_by: calledBy.join("|"),
      });
    }

    if (graphRows.length > 0) {
      if (tableNames.includes(GRAPH_TABLE)) {
        this._graphTable = await db.openTable(GRAPH_TABLE);
        await this._graphTable.add(graphRows);
      } else {
        this._graphTable = await db.createTable(GRAPH_TABLE, graphRows);
      }
    }
  }

  async buildFtsIndex(): Promise<void> {
    const table = await this.openChunksTable();
    if (!table) return;
    await table.createIndex("content", {
      config: Index.fts({ withPosition: false }),
      replace: true,
    });
  }

  private async ftsSearch(query: string, topK: number): Promise<Array<{ id: string; rank: number }>> {
    const table = await this.openChunksTable();
    if (!table) return [];
    try {
      const results = await table
        .query()
        .fullTextSearch(query, { columns: "content" })
        .select(["id"])
        .limit(topK)
        .toArray();
      return results.map((row, i) => ({ id: row.id as string, rank: i + 1 }));
    } catch {
      return [];
    }
  }

  async search(queryVec: number[], query: string, topK = 6): Promise<SearchHit[]> {
    const table = await this.openChunksTable();
    if (!table) return [];

    const fetchK = Math.max(topK * 3, 20);

    const [vectorRows, ftsRanks] = await Promise.all([
      table.vectorSearch(new Float32Array(queryVec)).distanceType("cosine").limit(fetchK).toArray(),
      this.ftsSearch(query, fetchK),
    ]);

    const vectorRankMap = new Map<string, number>(vectorRows.map((row, i) => [row.id as string, i + 1]));
    const ftsRankMap = new Map<string, number>(ftsRanks.map(({ id, rank }) => [id, rank]));

    const allIds = new Set([...vectorRankMap.keys(), ...ftsRankMap.keys()]);
    const rrfScores = new Map<string, number>();
    for (const id of allIds) {
      let score = 0;
      const vRank = vectorRankMap.get(id);
      const fRank = ftsRankMap.get(id);
      if (vRank !== undefined) score += 1 / (RRF_K + vRank);
      if (fRank !== undefined) score += 1 / (RRF_K + fRank);
      rrfScores.set(id, (score * RRF_K) / 2);
    }

    const rowById = new Map<string, Record<string, unknown>>(
      vectorRows.map((r) => [r.id as string, r as Record<string, unknown>]),
    );

    const ftsOnlyIds = [...allIds].filter((id) => !rowById.has(id));
    if (ftsOnlyIds.length > 0) {
      const placeholders = ftsOnlyIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      const extra = await table
        .query()
        .where(`id IN (${placeholders})`)
        .select(["id", "symbol_id", "file", "name", "content", "start_line", "end_line"])
        .toArray();
      for (const row of extra) rowById.set(row.id as string, row as Record<string, unknown>);
    }

    const sorted = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);

    return sorted
      .map(([id, score]) => {
        const row = rowById.get(id);
        if (!row) return null;
        return {
          id,
          symbolId: row.symbol_id as string,
          file: row.file as string,
          name: row.name as string,
          content: row.content as string,
          startLine: row.start_line as number,
          endLine: row.end_line as number,
          score,
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
  }

  async getSymbol(symbolId: string): Promise<Chunk | null> {
    const table = await this.openChunksTable();
    if (!table) return null;
    const results = await table
      .query()
      .where(`symbol_id = '${symbolId.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray();
    if (results.length === 0) return null;
    const row = results[0];
    return {
      id: row.id as string,
      symbolId: row.symbol_id as string,
      file: row.file as string,
      name: row.name as string,
      content: row.content as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
    };
  }

  async getGraphEdges(symbolId: string): Promise<GraphEdges> {
    const table = await this.openGraphTable();
    if (!table) return { calls: [], calledBy: [] };
    const results = await table
      .query()
      .where(`symbol_id = '${symbolId.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray();
    if (results.length === 0) return { calls: [], calledBy: [] };
    const row = results[0];
    return {
      calls: row.calls ? (row.calls as string).split("|").filter(Boolean) : [],
      calledBy: row.called_by ? (row.called_by as string).split("|").filter(Boolean) : [],
    };
  }

  async getStats(): Promise<StoreStats> {
    try {
      const chunksTable = await this.openChunksTable();
      const graphTable = await this.openGraphTable();
      return {
        chunks: chunksTable ? await chunksTable.countRows() : 0,
        graphNodes: graphTable ? await graphTable.countRows() : 0,
      };
    } catch {
      return { chunks: 0, graphNodes: 0 };
    }
  }

  async disconnect(): Promise<void> {
    this._chunksTable = null;
    this._graphTable = null;
    this._db = null;
  }
}

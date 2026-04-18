import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import fs from "fs";
import type { Chunk, GraphEdges, SearchHit, StoreStats } from "./types.js";

const CHUNKS_TABLE = "chunks";
const GRAPH_TABLE = "graph";

export class Store {
  private dbPath: string;
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

  async ensureIndex(): Promise<void> {
    await this.getDb();
  }

  async upsertChunk(chunk: Chunk & { vector: number[] }): Promise<void> {
    const db = await this.getDb();
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

    if (!this._chunksTable) {
      const names = await db.tableNames();
      if (names.includes(CHUNKS_TABLE)) {
        this._chunksTable = await db.openTable(CHUNKS_TABLE);
        await this._chunksTable.add([row]);
      } else {
        this._chunksTable = await db.createTable(CHUNKS_TABLE, [row]);
      }
    } else {
      await this._chunksTable.add([row]);
    }
  }

  async search(queryVector: number[], topK = 6): Promise<SearchHit[]> {
    const table = await this.openChunksTable();
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

  async setGraphEdges(fnKey: string, { calls = [], calledBy = [] }: GraphEdges): Promise<void> {
    const db = await this.getDb();
    const row = {
      fn_key: fnKey,
      calls: calls.join("|"),
      called_by: calledBy.join("|"),
    };

    if (!this._graphTable) {
      const names = await db.tableNames();
      if (names.includes(GRAPH_TABLE)) {
        this._graphTable = await db.openTable(GRAPH_TABLE);
      } else {
        this._graphTable = await db.createTable(GRAPH_TABLE, [row]);
        return;
      }
    }

    await this._graphTable
      .mergeInsert("fn_key")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row]);
  }

  async getGraphEdges(fnKey: string): Promise<GraphEdges> {
    const table = await this.openGraphTable();
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

  async flushAll(): Promise<void> {
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(CHUNKS_TABLE)) await db.dropTable(CHUNKS_TABLE);
    if (names.includes(GRAPH_TABLE)) await db.dropTable(GRAPH_TABLE);
    this._chunksTable = null;
    this._graphTable = null;
  }

  async getStats(): Promise<StoreStats> {
    try {
      const chunksTable = await this.openChunksTable();
      const graphTable = await this.openGraphTable();
      return {
        total: chunksTable ? await chunksTable.countRows() : 0,
        graphNodes: graphTable ? await graphTable.countRows() : 0,
      };
    } catch {
      return { total: 0, graphNodes: 0 };
    }
  }

  async getAllByCategory(): Promise<Record<string, number>> {
    const table = await this.openChunksTable();
    if (!table) return {};

    const categories: Chunk["category"][] = ["code", "docs", "git", "general"];
    const counts: Record<string, number> = {};
    for (const cat of categories) {
      const n = await table.countRows(`category = '${cat}'`);
      if (n > 0) counts[cat] = n;
    }
    return counts;
  }

  async disconnect(): Promise<void> {
    this._chunksTable = null;
    this._graphTable = null;
    this._db = null;
  }
}

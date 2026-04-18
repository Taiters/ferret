import { createClient, SchemaFieldTypes, VectorAlgorithms } from "redis";
import type { Chunk, GraphEdges, SearchHit, StoreStats } from "./types.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const INDEX_NAME = "memory-skill-idx";
const KEY_PREFIX = "mem:";
const GRAPH_PREFIX = "graph:";
const VECTOR_DIM = 384; // all-MiniLM-L6-v2 output dim

type RedisClient = ReturnType<typeof createClient>;
let _client: RedisClient | null = null;

export async function getClient(): Promise<RedisClient> {
  if (_client) return _client;
  _client = createClient({ url: REDIS_URL });
  _client.on("error", (e: Error) => console.error("Redis error:", e));
  await _client.connect();
  return _client;
}

export async function ensureIndex(): Promise<void> {
  const client = await getClient();
  try {
    await client.ft.info(INDEX_NAME);
  } catch {
    await client.ft.create(
      INDEX_NAME,
      {
        id: { type: SchemaFieldTypes.TAG },
        file: { type: SchemaFieldTypes.TAG },
        category: { type: SchemaFieldTypes.TAG },
        name: { type: SchemaFieldTypes.TEXT },
        content: { type: SchemaFieldTypes.TEXT },
        tags: { type: SchemaFieldTypes.TAG, SEPARATOR: "," },
        start_line: { type: SchemaFieldTypes.NUMERIC },
        end_line: { type: SchemaFieldTypes.NUMERIC },
        vector: {
          type: SchemaFieldTypes.VECTOR,
          ALGORITHM: VectorAlgorithms.HNSW,
          TYPE: "FLOAT32",
          DIM: VECTOR_DIM,
          DISTANCE_METRIC: "COSINE",
        },
      },
      { ON: "HASH", PREFIX: KEY_PREFIX },
    );
  }
}

export async function upsertChunk(chunk: Chunk & { vector: number[] }): Promise<void> {
  const client = await getClient();
  const key = `${KEY_PREFIX}${chunk.id}`;
  const vectorBuf = Buffer.from(new Float32Array(chunk.vector).buffer);

  await client.hSet(key, {
    id: chunk.id,
    file: chunk.file ?? "",
    category: chunk.category ?? "general",
    name: chunk.name ?? "",
    content: chunk.content ?? "",
    tags: (chunk.tags ?? []).join(","),
    start_line: chunk.start_line ?? 0,
    end_line: chunk.end_line ?? 0,
    vector: vectorBuf,
  });
}

export async function search(queryVector: number[], topK = 6): Promise<SearchHit[]> {
  const client = await getClient();
  const buf = Buffer.from(new Float32Array(queryVector).buffer);

  const results = await client.ft.search(
    INDEX_NAME,
    `*=>[KNN ${topK} @vector $vec AS score]`,
    {
      PARAMS: { vec: buf },
      SORTBY: { BY: "score" },
      DIALECT: 2,
      RETURN: [
        "id",
        "file",
        "category",
        "name",
        "content",
        "tags",
        "start_line",
        "end_line",
        "score",
      ],
    },
  );

  return results.documents.map((d) => ({
    id: d.value.id as string,
    file: d.value.file as string,
    category: d.value.category as Chunk["category"],
    name: d.value.name as string,
    content: d.value.content as string,
    tags: d.value.tags ? (d.value.tags as string).split(",").filter(Boolean) : [],
    start_line: parseInt(d.value.start_line as string),
    end_line: parseInt(d.value.end_line as string),
    score: 1 - parseFloat(d.value.score as string), // cosine distance → similarity
  }));
}

// ── Call graph ────────────────────────────────────────────────────────────────

export async function setGraphEdges(
  fnKey: string,
  { calls = [], calledBy = [] }: GraphEdges,
): Promise<void> {
  const client = await getClient();
  const key = `${GRAPH_PREFIX}${fnKey}`;
  await client.hSet(key, {
    calls: calls.join("|"),
    calledBy: calledBy.join("|"),
  });
}

export async function getGraphEdges(fnKey: string): Promise<GraphEdges> {
  const client = await getClient();
  const data = await client.hGetAll(`${GRAPH_PREFIX}${fnKey}`);
  if (!data || !data.calls) return { calls: [], calledBy: [] };
  return {
    calls: data.calls.split("|").filter(Boolean),
    calledBy: data.calledBy.split("|").filter(Boolean),
  };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export async function flushAll(): Promise<void> {
  const client = await getClient();
  const keys = await client.keys(`${KEY_PREFIX}*`);
  const gkeys = await client.keys(`${GRAPH_PREFIX}*`);
  const all = [...keys, ...gkeys];
  if (all.length) await client.del(all);
}

export async function getStats(): Promise<StoreStats> {
  const client = await getClient();
  try {
    const info = await client.ft.info(INDEX_NAME);
    const gkeys = await client.keys(`${GRAPH_PREFIX}*`);
    return {
      total: parseInt(info.numDocs as string),
      graphNodes: gkeys.length,
    };
  } catch {
    return { total: 0, graphNodes: 0 };
  }
}

export async function getAllByCategory(): Promise<Record<string, number>> {
  const client = await getClient();
  const keys = await client.keys(`${KEY_PREFIX}*`);
  const counts: Record<string, number> = {};
  for (const k of keys) {
    const cat = await client.hGet(k, "category");
    if (cat) counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}

export async function disconnect(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}

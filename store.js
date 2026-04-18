import { createClient } from "redis";
import { SchemaFieldTypes, VectorAlgorithms } from "redis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INDEX_NAME = "memory-skill-idx";
const KEY_PREFIX = "mem:";
const GRAPH_PREFIX = "graph:";
const VECTOR_DIM = 384; // all-MiniLM-L6-v2 output dim

let _client = null;

export async function getClient() {
  if (_client) return _client;
  _client = createClient({ url: REDIS_URL });
  _client.on("error", (e) => console.error("Redis error:", e));
  await _client.connect();
  return _client;
}

export async function ensureIndex() {
  const client = await getClient();
  try {
    await client.ft.info(INDEX_NAME);
  } catch {
    // Index doesn't exist — create it
    await client.ft.create(
      INDEX_NAME,
      {
        id:         { type: SchemaFieldTypes.TAG },
        file:       { type: SchemaFieldTypes.TAG },
        category:   { type: SchemaFieldTypes.TAG },
        name:       { type: SchemaFieldTypes.TEXT },
        content:    { type: SchemaFieldTypes.TEXT },
        tags:       { type: SchemaFieldTypes.TAG, SEPARATOR: "," },
        start_line: { type: SchemaFieldTypes.NUMERIC },
        end_line:   { type: SchemaFieldTypes.NUMERIC },
        vector: {
          type: SchemaFieldTypes.VECTOR,
          ALGORITHM: VectorAlgorithms.HNSW,
          TYPE: "FLOAT32",
          DIM: VECTOR_DIM,
          DISTANCE_METRIC: "COSINE",
        },
      },
      { ON: "HASH", PREFIX: KEY_PREFIX }
    );
  }
}

export async function upsertChunk(chunk) {
  const client = await getClient();
  const key = `${KEY_PREFIX}${chunk.id}`;

  // Convert float32 vector to Buffer for Redis
  const vectorBuf = Buffer.from(new Float32Array(chunk.vector).buffer);

  await client.hSet(key, {
    id:         chunk.id,
    file:       chunk.file       || "",
    category:   chunk.category   || "general",
    name:       chunk.name       || "",
    content:    chunk.content    || "",
    tags:       (chunk.tags || []).join(","),
    start_line: chunk.start_line ?? 0,
    end_line:   chunk.end_line   ?? 0,
    vector:     vectorBuf,
  });
}

export async function search(queryVector, topK = 6) {
  const client = await getClient();
  const buf = Buffer.from(new Float32Array(queryVector).buffer);

  const results = await client.ft.search(
    INDEX_NAME,
    `*=>[KNN ${topK} @vector $vec AS score]`,
    {
      PARAMS: { vec: buf },
      SORTBY: "score",
      DIALECT: 2,
      RETURN: ["id", "file", "category", "name", "content", "tags", "start_line", "end_line", "score"],
    }
  );

  return results.documents.map((d) => ({
    ...d.value,
    score: 1 - parseFloat(d.value.score), // cosine distance → similarity
    start_line: parseInt(d.value.start_line),
    end_line:   parseInt(d.value.end_line),
    tags: d.value.tags ? d.value.tags.split(",").filter(Boolean) : [],
  }));
}

// ── Call graph ────────────────────────────────────────────────────────────────

export async function setGraphEdges(fnKey, { calls = [], calledBy = [] }) {
  const client = await getClient();
  const key = `${GRAPH_PREFIX}${fnKey}`;
  await client.hSet(key, {
    calls:    calls.join("|"),
    calledBy: calledBy.join("|"),
  });
}

export async function getGraphEdges(fnKey) {
  const client = await getClient();
  const data = await client.hGetAll(`${GRAPH_PREFIX}${fnKey}`);
  if (!data || !data.calls) return { calls: [], calledBy: [] };
  return {
    calls:    data.calls.split("|").filter(Boolean),
    calledBy: data.calledBy.split("|").filter(Boolean),
  };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export async function flushAll() {
  const client = await getClient();
  const keys = await client.keys(`${KEY_PREFIX}*`);
  const gkeys = await client.keys(`${GRAPH_PREFIX}*`);
  const all = [...keys, ...gkeys];
  if (all.length) await client.del(all);
}

export async function getStats() {
  const client = await getClient();
  try {
    const info = await client.ft.info(INDEX_NAME);
    const gkeys = await client.keys(`${GRAPH_PREFIX}*`);
    return {
      total:      parseInt(info.numDocs),
      graphNodes: gkeys.length,
    };
  } catch {
    return { total: 0, graphNodes: 0 };
  }
}

export async function getAllByCategory() {
  const client = await getClient();
  const keys = await client.keys(`${KEY_PREFIX}*`);
  const counts = {};
  for (const k of keys) {
    const cat = await client.hGet(k, "category");
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

export async function disconnect() {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}

import { pipeline, env } from "@xenova/transformers";
import path from "path";
import os from "os";

// Cache model in ~/.cache/memory-skill so it only downloads once
env.cacheDir = path.join(os.homedir(), ".cache", "memory-skill");
env.allowLocalModels = false;

const MODEL = "Xenova/all-MiniLM-L6-v2";
let _embedder = null;

async function getEmbedder() {
  if (_embedder) return _embedder;
  process.stderr.write("Loading embedding model (first run downloads ~25MB)...\n");
  _embedder = await pipeline("feature-extraction", MODEL, { quantized: true });
  process.stderr.write("Model ready.\n");
  return _embedder;
}

/**
 * Embed a single string → Float32Array of length 384
 */
export async function embed(text) {
  const embedder = await getEmbedder();
  // Truncate to ~500 tokens worth of chars to stay within model limits
  const truncated = text.slice(0, 2000);
  const output = await embedder(truncated, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Embed a batch of strings with a small progress indicator
 */
export async function embedBatch(texts, onProgress) {
  const embedder = await getEmbedder();
  const results = [];
  for (let i = 0; i < texts.length; i++) {
    const truncated = texts[i].slice(0, 2000);
    const output = await embedder(truncated, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return results;
}

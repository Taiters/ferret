import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import os from "os";

// Cache model in ~/.cache/memory-skill so it only downloads once
env.cacheDir = path.join(os.homedir(), ".cache", "memory-skill");
env.allowLocalModels = false;

const MODEL = "Xenova/all-MiniLM-L6-v2";
let _embedder: FeatureExtractionPipeline | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (_embedder) return _embedder;
  process.stderr.write("Loading embedding model (first run downloads ~25MB)...\n");
  _embedder = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  process.stderr.write("Model ready.\n");
  return _embedder;
}

/**
 * Embed a single string → number[] of length 384
 */
export async function embed(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const truncated = text.slice(0, 2000);
  const output = await embedder(truncated, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Embed a batch of strings with a progress callback
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (current: number, total: number) => void,
): Promise<number[][]> {
  const embedder = await getEmbedder() as FeatureExtractionPipeline;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const truncated = texts[i].slice(0, 2000);
    const output = await embedder(truncated, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return results;
}

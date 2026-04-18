import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import os from "os";

// Cache model in ~/.cache/memory-skill so it only downloads once
env.cacheDir = path.join(os.homedir(), ".cache", "memory-skill");
env.allowLocalModels = false;

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

const _embedders = new Map<string, FeatureExtractionPipeline>();

async function getEmbedder(model = DEFAULT_MODEL): Promise<FeatureExtractionPipeline> {
  if (_embedders.has(model)) return _embedders.get(model)!;
  process.stderr.write(`Loading embedding model ${model} (first run may download)...\n`);
  const embedder = await pipeline("feature-extraction", model, { dtype: "q8" });
  _embedders.set(model, embedder);
  process.stderr.write("Model ready.\n");
  return embedder;
}

/**
 * Embed a single string → number[] of length 384
 */
export async function embed(text: string, model?: string): Promise<number[]> {
  const embedder = await getEmbedder(model);
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
  model?: string,
): Promise<number[][]> {
  const embedder = await getEmbedder(model);
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const truncated = texts[i].slice(0, 2000);
    const output = await (embedder as FeatureExtractionPipeline)(truncated, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return results;
}

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import os from "os";

// Cache model in ~/.cache/ferret so it only downloads once
env.cacheDir = path.join(os.homedir(), ".cache", "ferret");
env.allowLocalModels = false;

export const DEFAULT_MODEL = "Xenova/all-mpnet-base-v2";

const _embedders = new Map<string, FeatureExtractionPipeline>();
const _maxChars = new Map<string, number>();

// Many models set model_max_length to a sentinel like 1e30; cap at 32k tokens.
const MAX_TOKENS_CAP = 32_768;
const CHARS_PER_TOKEN = 4;

async function getEmbedder(model = DEFAULT_MODEL): Promise<FeatureExtractionPipeline> {
  if (_embedders.has(model)) return _embedders.get(model)!;
  process.stderr.write(`Loading embedding model ${model} (first run may download)...\n`);
  const embedder = await pipeline("feature-extraction", model, { dtype: "q8" });
  _embedders.set(model, embedder);
  const rawMax: number = (embedder as any).tokenizer?.model_max_length ?? MAX_TOKENS_CAP;
  _maxChars.set(model, Math.min(rawMax, MAX_TOKENS_CAP) * CHARS_PER_TOKEN);
  process.stderr.write("Model ready.\n");
  return embedder;
}

function maxCharsFor(model = DEFAULT_MODEL): number {
  return _maxChars.get(model) ?? MAX_TOKENS_CAP * CHARS_PER_TOKEN;
}

/**
 * Embed a single string, truncated to the model's context window.
 */
export async function embed(text: string, model?: string): Promise<number[]> {
  const embedder = await getEmbedder(model);
  const truncated = text.slice(0, maxCharsFor(model));
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
  const limit = maxCharsFor(model);
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const truncated = texts[i].slice(0, limit);
    const output = await (embedder as FeatureExtractionPipeline)(truncated, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return results;
}

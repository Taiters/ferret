import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import os from "os";

// Cache model in ~/.cache/ferret so it only downloads once
env.cacheDir = path.join(os.homedir(), ".cache", "ferret");
env.allowLocalModels = false;

export const DEFAULT_MODEL = "jinaai/jina-embeddings-v2-base-code";
// Some models set model_max_length to a sentinel like 1e30; cap at 32k tokens.
const MAX_TOKENS_CAP = 32_768;
const CHARS_PER_TOKEN = 4;

const _embedders = new Map<string, FeatureExtractionPipeline>();
const _maxChars = new Map<string, number>();

async function getEmbedder(model = DEFAULT_MODEL): Promise<FeatureExtractionPipeline> {
  if (_embedders.has(model)) return _embedders.get(model)!;
  process.stderr.write(`Loading embedding model ${model}...\n`);

  let lastFile = "";
  const embedder = await pipeline("feature-extraction", model, {
    dtype: "q8",
    progress_callback: (event: any) => {
      if (event.status === "progress" && typeof event.progress === "number") {
        const file = (event.name as string).split("/").pop() ?? event.name;
        const pct = event.progress.toFixed(1).padStart(5);
        const mb = event.total ? ` (${(event.total / 1_048_576).toFixed(1)} MB)` : "";
        if (file !== lastFile) {
          if (lastFile) process.stderr.write("\n");
          lastFile = file;
        }
        process.stderr.write(`\r  ${file}${mb} ${pct}%`);
      } else if (event.status === "done" && lastFile) {
        process.stderr.write("\n");
        lastFile = "";
      }
    },
  });

  _embedders.set(model, embedder);
  const rawMax: number = (embedder as any).tokenizer?.model_max_length ?? MAX_TOKENS_CAP;
  const maxTokens = Math.min(rawMax, MAX_TOKENS_CAP);
  _maxChars.set(model, maxTokens * CHARS_PER_TOKEN);
  process.stderr.write(`Model ready. Context: ${maxTokens} tokens (${maxTokens * CHARS_PER_TOKEN} chars)\n`);
  return embedder;
}

function maxCharsFor(model: string): number {
  return _maxChars.get(model) ?? MAX_TOKENS_CAP * CHARS_PER_TOKEN;
}

/**
 * Embed a single string, truncated to the model's context window.
 */
export async function embed(text: string, model = DEFAULT_MODEL): Promise<number[]> {
  const embedder = await getEmbedder(model);
  const output = await embedder(text.slice(0, maxCharsFor(model)), { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Embed a batch of strings with a progress callback.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (current: number, total: number) => void,
  model = DEFAULT_MODEL,
): Promise<number[][]> {
  const embedder = await getEmbedder(model);
  const limit = maxCharsFor(model);
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const output = await (embedder as FeatureExtractionPipeline)(texts[i].slice(0, limit), { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return results;
}

import { pipeline, type TextClassificationPipeline } from "@huggingface/transformers";
import type { SearchHit } from "./types.js";

export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

const _rerankers = new Map<string, TextClassificationPipeline>();

async function getReranker(model = DEFAULT_RERANK_MODEL): Promise<TextClassificationPipeline> {
  if (_rerankers.has(model)) return _rerankers.get(model)!;
  process.stderr.write(`Loading reranker model ${model}...\n`);
  const reranker = await pipeline("text-classification", model, { dtype: "q8" });
  _rerankers.set(model, reranker as TextClassificationPipeline);
  process.stderr.write(`Reranker ready.\n`);
  return reranker as TextClassificationPipeline;
}

/**
 * Re-rank hits using a cross-encoder. Returns hits sorted by cross-encoder
 * score descending. The original RRF score is preserved on each hit.
 */
export async function rerank(query: string, hits: SearchHit[], model = DEFAULT_RERANK_MODEL): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;
  const reranker = await getReranker(model);

  // Cross-encoders in transformers.js expect concatenated strings
  const inputs = hits.map((h) => `${query} [SEP] ${h.content.slice(0, 4000)}`);
  const outputs = await reranker(inputs);

  const scores = (Array.isArray(outputs) ? outputs : [outputs]) as Array<{ label: string; score: number }>;

  return hits
    .map((hit, i) => ({ hit, rerankScore: scores[i]?.score ?? 0 }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .map(({ hit }) => hit);
}

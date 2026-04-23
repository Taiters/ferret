import { pipeline, type TextClassificationPipeline } from "@huggingface/transformers";
import type { SearchHit } from "../types.js";
import type { Ranker } from "./types.js";

export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

export class CrossEncoderRanker implements Ranker {
  private readonly modelName: string;
  private _pipeline: TextClassificationPipeline | null = null;

  constructor(model = DEFAULT_RERANK_MODEL) {
    this.modelName = model;
  }

  private async getPipeline(): Promise<TextClassificationPipeline> {
    if (this._pipeline) return this._pipeline;
    process.stderr.write(`Loading reranker model ${this.modelName}...\n`);
    const p = await pipeline("text-classification", this.modelName, { dtype: "q8" });
    this._pipeline = p as TextClassificationPipeline;
    process.stderr.write(`Reranker ready.\n`);
    return this._pipeline;
  }

  async rank(query: string, hits: SearchHit[]): Promise<SearchHit[]> {
    if (hits.length === 0) return hits;
    const reranker = await this.getPipeline();
    const inputs = hits.map((h) => `${query} [SEP] ${h.content.slice(0, 4000)}`);
    const outputs = await reranker(inputs);
    const scores = (Array.isArray(outputs) ? outputs : [outputs]) as Array<{ label: string; score: number }>;
    return hits
      .map((hit, i) => ({ hit, rerankScore: scores[i]?.score ?? 0 }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .map(({ hit }) => hit);
  }
}

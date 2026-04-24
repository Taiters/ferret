import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import os from "os";
import type { Embedder } from "./types.js";

env.cacheDir = path.join(os.homedir(), ".cache", "ferret");
env.allowLocalModels = false;

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

const MAX_TOKENS_CAP = 32_768;
const CHARS_PER_TOKEN = 4;

export class HuggingFaceEmbedder implements Embedder {
  private readonly modelName: string;
  private _pipeline: FeatureExtractionPipeline | null = null;
  private maxChars = MAX_TOKENS_CAP * CHARS_PER_TOKEN;

  constructor(model = DEFAULT_MODEL) {
    this.modelName = model;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (this._pipeline) return this._pipeline;
    process.stderr.write(`\nLoading embedding model ${this.modelName}...\n`);

    const fileOrder: string[] = [];
    const fileProgress = new Map<string, string>();
    let linesDrawn = 0;

    function redrawProgress() {
      if (fileOrder.length === 0) return;
      if (linesDrawn > 0) process.stderr.write(`\x1b[${linesDrawn}A`);
      for (const f of fileOrder) {
        process.stderr.write(`\r\x1b[2m  ${fileProgress.get(f)!}\x1b[0m\x1b[K\n`);
      }
      linesDrawn = fileOrder.length;
    }

    const embedder = await pipeline("feature-extraction", this.modelName, {
      dtype: "q8",
      progress_callback: (event: any) => {
        if (event.status === "progress" && typeof event.progress === "number") {
          const file = (event.file as string).split("/").pop() ?? event.name;
          const pct = event.progress.toFixed(1).padStart(5);
          const mb = event.total ? ` (${(event.total / 1_048_576).toFixed(1)} MB)` : "";
          if (!fileProgress.has(file)) fileOrder.push(file);
          fileProgress.set(file, `${file}${mb} ${pct}%`);
          redrawProgress();
        }
      },
    });

    this._pipeline = embedder;
    const rawMax: number = (embedder as any).tokenizer?.model_max_length ?? MAX_TOKENS_CAP;
    const maxTokens = Math.min(rawMax, MAX_TOKENS_CAP);
    this.maxChars = maxTokens * CHARS_PER_TOKEN;
    process.stderr.write(`Model ready. Context: ${maxTokens} tokens\n`);
    return this._pipeline;
  }

  async embed(text: string): Promise<number[]> {
    const embedder = await this.getPipeline();
    const output = await embedder(text.slice(0, this.maxChars), {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }
}

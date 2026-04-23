export interface BenchmarkEntry {
  chunkId: string;
  symbolId: string;
  file: string;
  name: string;
  questions: string[];
}

export interface BenchmarkFile {
  generated: string;  // ISO 8601
  model: string;
  entries: BenchmarkEntry[];
}

export interface BenchmarkResults {
  totalQuestions: number;
  recall1: number;
  recall3: number;
  recall5: number;
  mrr: number;
  worstPerformers: Array<{
    symbolId: string;
    found: number;
    total: number;
  }>;
}

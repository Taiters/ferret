import type { SearchHit } from "../types.js";

export interface Ranker {
  rank(query: string, hits: SearchHit[]): Promise<SearchHit[]>;
}

export interface Selector {
  select(hits: SearchHit[], k: number): SearchHit[];
}

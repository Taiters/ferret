import type { SearchHit } from "../types.js";
import type { Selector } from "./types.js";

export class MmrSelector implements Selector {
  select(hits: SearchHit[], k: number): SearchHit[] {
    if (hits.length === 0) return [];
    // Sort descending by score; MMR lambda * score with no vector penalty
    // is equivalent to top-k. Structure retained for future vector diversity.
    return [...hits]
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

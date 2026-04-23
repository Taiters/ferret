import type { Embedder } from "../embedding/types.js";
import type { ChunkStore } from "../store/types.js";
import type { Ranker, Selector } from "../ranking/types.js";
import type { SearchHit } from "../types.js";

export class Searcher {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: ChunkStore,
    private readonly ranker: Ranker,
    private readonly selector: Selector,
  ) {}

  async search(query: string, topK = 6, minScore = 0): Promise<SearchHit[]> {
    const queryVec = await this.embedder.embed(query);
    const candidates = await this.store.search(queryVec, query, topK * 2);
    const filtered = candidates.filter((h) => h.score >= minScore);
    const ranked = await this.ranker.rank(query, filtered);
    return this.selector.select(ranked, topK);
  }
}

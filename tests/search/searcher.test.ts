import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import type { ChunkStore } from "../../src/store/types.js";
import type { Ranker, Selector } from "../../src/ranking/types.js";
import type { SearchHit } from "../../src/types.js";

function makeHit(id: string, score: number): SearchHit {
  return { id, score, symbolId: `file.ts:${id}`, file: "file.ts", name: id, content: "code", startLine: 1, endLine: 5 };
}

const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

const mockStore: Pick<ChunkStore, "search"> = {
  search: vi.fn().mockResolvedValue([makeHit("a", 0.9), makeHit("b", 0.5)]),
};

const mockRanker: Ranker = {
  rank: vi.fn().mockImplementation((_q, hits) => Promise.resolve(hits)),
};

const mockSelector: Selector = {
  select: vi.fn().mockImplementation((hits, k) => hits.slice(0, k)),
};

describe("Searcher", () => {
  beforeEach(() => vi.clearAllMocks());

  test("embeds query, retrieves candidates, ranks and selects", async () => {
    const { Searcher } = await import("../../src/search/searcher.js");
    const searcher = new Searcher(mockEmbedder, mockStore as ChunkStore, mockRanker, mockSelector);
    const results = await searcher.search("some query", 6);

    expect(mockEmbedder.embed).toHaveBeenCalledWith("some query");
    expect(mockStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], "some query", 12);
    expect(mockRanker.rank).toHaveBeenCalled();
    expect(mockSelector.select).toHaveBeenCalledWith(expect.any(Array), 6);
    expect(results).toHaveLength(2);
  });

  test("filters hits below minScore before ranking", async () => {
    const lowScoreStore: Pick<ChunkStore, "search"> = {
      search: vi.fn().mockResolvedValue([makeHit("a", 0.3), makeHit("b", 0.8)]),
    };
    const { Searcher } = await import("../../src/search/searcher.js");
    const searcher = new Searcher(mockEmbedder, lowScoreStore as ChunkStore, mockRanker, mockSelector);
    await searcher.search("query", 6, 0.5);

    // Only hit "b" (score 0.8) should reach the ranker
    const rankCall = (mockRanker.rank as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rankCall[1]).toHaveLength(1);
    expect(rankCall[1][0].id).toBe("b");
  });
});

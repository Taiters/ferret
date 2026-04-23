import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import type { ChunkStore } from "../../src/store/types.js";
import type { ParserRegistry } from "../../src/ingestion/parserRegistry.js";

const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

const mockStore: ChunkStore = {
  flush: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  buildFtsIndex: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  getSymbol: vi.fn().mockResolvedValue(null),
  getGraphEdges: vi.fn().mockResolvedValue({ calls: [], calledBy: [] }),
  getStats: vi.fn().mockResolvedValue({ chunks: 0, graphNodes: 0 }),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

describe("Indexer", () => {
  beforeEach(() => vi.clearAllMocks());

  test("flushes the store before indexing", async () => {
    const { Indexer } = await import("../../src/indexer/indexer.js");
    const indexer = new Indexer(mockEmbedder, mockStore, {} as ParserRegistry);
    await indexer.index("/tmp").catch(() => {});
    expect(mockStore.flush).toHaveBeenCalled();
  });
});

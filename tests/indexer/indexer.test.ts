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
  sampleChunks: vi.fn().mockResolvedValue([]),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

const mockParserRegistry = {
  registeredExtensions: vi.fn().mockReturnValue([]),
  get: vi.fn().mockReturnValue(undefined),
  parseFile: vi.fn().mockReturnValue({ chunks: [], graph: new Map() }),
} as unknown as ParserRegistry;

describe("Indexer", () => {
  beforeEach(() => vi.clearAllMocks());

  test("flushes the store before indexing", async () => {
    const callOrder: string[] = [];
    (mockStore.flush as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("flush");
      return Promise.resolve();
    });
    (mockStore.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("write");
      return Promise.resolve();
    });
    const { Indexer } = await import("../../src/indexer/indexer.js");
    const indexer = new Indexer(mockEmbedder, mockStore, mockParserRegistry);
    await indexer.index("/tmp").catch(() => {});
    expect(mockStore.flush).toHaveBeenCalled();
    expect(callOrder[0]).toBe("flush");
  });

  test("writes model to project config after indexing", async () => {
    const { Indexer } = await import("../../src/indexer/indexer.js");
    const indexer = new Indexer(mockEmbedder, mockStore, mockParserRegistry);
    await indexer.index("/tmp", { model: "Xenova/test-model" }).catch(() => {});

    const fs = await import("fs");
    const configPath = "/tmp/.ferret/index-info.json";
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.model).toBe("Xenova/test-model");
  });
});

import { describe, test, expect } from "vitest";
import { MmrSelector } from "../../src/ranking/mmr.js";
import type { SearchHit } from "../../src/types.js";

function makeHit(id: string, score: number): SearchHit {
  return { id, score, symbolId: `file.ts:${id}`, file: "file.ts", name: id, content: "", startLine: 0, endLine: 0 };
}

describe("MmrSelector", () => {
  test("returns top k hits ordered by score", () => {
    const selector = new MmrSelector();
    const hits = [makeHit("c", 0.5), makeHit("a", 0.9), makeHit("b", 0.7)];
    const result = selector.select(hits, 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  test("returns all hits when k >= hits.length", () => {
    const selector = new MmrSelector();
    const hits = [makeHit("a", 0.9)];
    expect(selector.select(hits, 5)).toHaveLength(1);
  });

  test("returns empty array for empty input", () => {
    const selector = new MmrSelector();
    expect(selector.select([], 5)).toHaveLength(0);
  });
});

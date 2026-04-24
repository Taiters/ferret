import { describe, test, expect } from "vitest";
import { resolveModel, DEFAULT_EMBEDDING_MODEL } from "../../src/projects.js";

describe("resolveModel", () => {
  test("flag value takes priority over global config", () => {
    expect(resolveModel("Xenova/flag-model", { model: "Xenova/global-model" })).toBe("Xenova/flag-model");
  });

  test("global config model is used when no flag", () => {
    expect(resolveModel(undefined, { model: "Xenova/all-mpnet-base-v2" })).toBe("Xenova/all-mpnet-base-v2");
  });

  test("falls back to DEFAULT_EMBEDDING_MODEL when global config has no model", () => {
    expect(resolveModel(undefined, {})).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  test("DEFAULT_EMBEDDING_MODEL is a non-empty string", () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBeTypeOf("string");
    expect(DEFAULT_EMBEDDING_MODEL.length).toBeGreaterThan(0);
  });
});

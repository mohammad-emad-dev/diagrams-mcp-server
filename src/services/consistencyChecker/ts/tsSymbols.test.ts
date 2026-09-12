import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectTsDeclaredSymbols } from "./tsSymbols.js";

describe("tsSymbols stub (Phase 2)", () => {
  it("returns an empty set for any input until Phase 3 fills the visitor", () => {
    assert.deepEqual([...collectTsDeclaredSymbols(undefined)], []);
    assert.deepEqual([...collectTsDeclaredSymbols(null)], []);
    assert.deepEqual([...collectTsDeclaredSymbols({})], []);
  });
});

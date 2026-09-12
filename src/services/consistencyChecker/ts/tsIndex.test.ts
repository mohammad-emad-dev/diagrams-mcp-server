import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTsDeclared } from "./tsIndex.js";

describe("tsIndex stub (Phase 2)", () => {
  it("returns an empty set for any input until Phase 3 wires the union", () => {
    assert.deepEqual([...buildTsDeclared("", "", ".ts")], []);
    assert.deepEqual([...buildTsDeclared("class User {}", "class User {}", ".tsx")], []);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTsAstAvailable, parseTsSource } from "./tsParse.js";

describe("tsParse stub (Phase 2)", () => {
  it("reports compiler availability as a boolean", async () => {
    assert.equal(typeof (await isTsAstAvailable()), "boolean");
  });

  it("returns null for any input until Phase 3 fills the parser", async () => {
    assert.equal(await parseTsSource("user.ts", "export class User {}"), null);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeForMatch } from "./nameNormalize.js";

// The shared contract both the consistency checker and diagrams_diff build
// on: case and separators must not affect a lenient match. If this changes,
// diagram-to-code matching and rename pairing change with it.

describe("normalizeForMatch", () => {
  it("lowercases names", () => {
    assert.equal(normalizeForMatch("UserModel"), "usermodel");
    assert.equal(normalizeForMatch("USERMODEL"), "usermodel");
  });

  it("strips separators between segments", () => {
    for (const separator of ["-", "_", ".", " ", "/", "\\", "::"]) {
      assert.equal(normalizeForMatch(`user${separator}model`), "usermodel");
    }
    assert.equal(normalizeForMatch("a-b_c.d/e\\f"), "abcdef");
  });

  it("drops non-alphanumeric characters entirely", () => {
    assert.equal(normalizeForMatch("User (model)"), "usermodel");
    assert.equal(normalizeForMatch("User$Model!"), "usermodel");
    assert.equal(normalizeForMatch("  padded  "), "padded");
  });

  it("is unaffected by order or repetition of separators", () => {
    assert.equal(normalizeForMatch("user--model"), "usermodel");
    assert.equal(normalizeForMatch("user__model"), "usermodel");
    assert.equal(normalizeForMatch("-user-model-"), "usermodel");
  });

  it("maps names that differ only in case and separators to one form", () => {
    const forms = ["UserModel", "user-model", "user_model", "user.model", "USERMODEL"];
    const normalized = new Set(forms.map(normalizeForMatch));
    assert.deepEqual([...normalized], ["usermodel"]);
  });

  it("returns an empty string for separator-only or numeric-only input", () => {
    assert.equal(normalizeForMatch("---"), "");
    assert.equal(normalizeForMatch("..."), "");
    assert.equal(normalizeForMatch("123"), "123");
    assert.equal(normalizeForMatch(""), "");
  });
});

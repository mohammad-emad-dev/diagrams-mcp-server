import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTsAstAvailable, parseTsSource } from "./tsParse.js";

describe("tsParse", () => {
  it("reports compiler availability as a boolean", async () => {
    assert.equal(typeof (await isTsAstAvailable()), "boolean");
  });

  it("parses valid TS and TSX sources", async () => {
    assert.notEqual(await parseTsSource("user.ts", "export class User {}\n"), null);
    assert.notEqual(
      await parseTsSource("Card.tsx", "export function Card(): null {\n  return null;\n}\n"),
      null,
    );
  });

  it("returns null for syntax errors and non-TS extensions", async () => {
    assert.equal(await parseTsSource("broken.ts", "export class {{{ oops\n"), null);
    assert.equal(await parseTsSource("app.js", "export class User {}\n"), null);
  });
});

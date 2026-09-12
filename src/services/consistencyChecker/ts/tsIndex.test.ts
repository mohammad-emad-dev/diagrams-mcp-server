import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeTsFile } from "./tsIndex.js";

describe("analyzeTsFile", () => {
  it("reports strict with AST names for parseable TS", async () => {
    const result = await analyzeTsFile("export class User {}\n", ".ts", "user.ts");
    assert.equal(result.strict, true);
    assert.ok(result.declared.has("User"));
  });

  it("reports strict with AST names for TSX", async () => {
    const result = await analyzeTsFile(
      "export function Card(): null {\n  return null;\n}\n",
      ".tsx",
      "Card.tsx",
    );
    assert.equal(result.strict, true);
    assert.ok(result.declared.has("Card"));
  });

  it("falls back for syntax errors and non-TS extensions", async () => {
    assert.deepEqual(await analyzeTsFile("export class {{{ oops\n", ".ts", "broken.ts"), {
      declared: new Set<string>(),
      strict: false,
    });
    assert.deepEqual(await analyzeTsFile("export class User {}\n", ".js", "app.js"), {
      declared: new Set<string>(),
      strict: false,
    });
  });
});

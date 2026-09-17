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
      relations: [],
    });
    assert.deepEqual(await analyzeTsFile("export class User {}\n", ".js", "app.js"), {
      declared: new Set<string>(),
      strict: false,
      relations: [],
    });
  });

  it("skips relations unless requested", async () => {
    const result = await analyzeTsFile("export class Dog extends Animal {}\n", ".ts", "dog.ts");
    assert.equal(result.strict, true);
    assert.deepEqual(result.relations, []);
  });

  it("collects extends and implements clauses when requested", async () => {
    const result = await analyzeTsFile(
      [
        "export interface Named { name: string }",
        "export class Base {}",
        "export class Dog extends Base implements Named {}",
        "export interface Puppy extends Named {}",
      ].join("\n") + "\n",
      ".ts",
      "dog.ts",
      { includeRelations: true },
    );
    assert.equal(result.strict, true);
    assert.deepEqual([...result.declared].sort(), ["Base", "Dog", "Named", "Puppy"]);
    assert.deepEqual(result.relations, [
      { from: "Dog", to: "Base", kind: "extends" },
      { from: "Dog", to: "Named", kind: "implements" },
      { from: "Puppy", to: "Named", kind: "extends" },
    ]);
  });

  it("takes the last segment of qualified heritage names", async () => {
    const result = await analyzeTsFile(
      "export class Dog extends Animals.Base implements Types.Named {}\n",
      ".ts",
      "dog.ts",
      { includeRelations: true },
    );
    assert.deepEqual(result.relations, [
      { from: "Dog", to: "Base", kind: "extends" },
      { from: "Dog", to: "Named", kind: "implements" },
    ]);
  });

  it("ignores heritage clauses on anonymous declarations", async () => {
    const result = await analyzeTsFile("export default class extends Base {}\n", ".ts", "anon.ts", {
      includeRelations: true,
    });
    assert.deepEqual(result.relations, []);
  });

  it("reports no relations when the compiler is unavailable", async () => {
    const result = await analyzeTsFile("export class Dog extends Animal {}\n", ".ts", "dog.ts", {
      ts: null,
      includeRelations: true,
    });
    assert.equal(result.strict, false);
    assert.deepEqual(result.relations, []);
  });
});

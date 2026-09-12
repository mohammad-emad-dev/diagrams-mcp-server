import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTsSource } from "./tsParse.js";
import { collectTsDeclaredSymbols } from "./tsSymbols.js";

async function collect(source: string): Promise<string[]> {
  const parsed = await parseTsSource("sample.ts", source);
  assert.notEqual(parsed, null);
  return [...(await collectTsDeclaredSymbols(parsed))].sort();
}

describe("collectTsDeclaredSymbols", () => {
  it("collects classes, interfaces, enums, types, functions, and variables", async () => {
    assert.deepEqual(
      await collect(
        "export class User {}\nexport interface HasId {\n  id: number;\n}\n" +
          "export enum Role {\n  Admin,\n}\nexport type Alias = string;\n" +
          "export function greet(): void {}\nexport const helper = 1;\n",
      ),
      ["Alias", "HasId", "Role", "User", "greet", "helper"],
    );
  });

  it("collects both sides of export aliases and default-exported identifiers", async () => {
    assert.deepEqual(await collect("export { Cart as ShoppingCart };\n"), ["Cart", "ShoppingCart"]);
    assert.deepEqual(await collect("class Internal {}\nexport default Internal;\n"), ["Internal"]);
  });

  it("collects namespace members and ignores property names and export-star", async () => {
    assert.deepEqual(
      await collect(
        'namespace App {\n  export class Session {}\n}\nexport * from "./other";\n' +
          "export interface Order {\n  User: string;\n}\n",
      ),
      ["App", "Order", "Session"],
    );
  });

  it("returns an empty set for missing shapes", async () => {
    assert.deepEqual([...(await collectTsDeclaredSymbols(undefined))], []);
    assert.deepEqual([...(await collectTsDeclaredSymbols(null))], []);
    assert.deepEqual([...(await collectTsDeclaredSymbols({}))], []);
  });
});

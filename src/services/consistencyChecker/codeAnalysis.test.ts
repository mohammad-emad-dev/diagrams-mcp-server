import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDeclaredIdentifiers } from "./codeAnalysis.js";

describe("extractDeclaredIdentifiers", () => {
  it("adds each comma-list alias before its original in insertion order", () => {
    const cases: { source: string; expected: string[] }[] = [
      { source: "export { Foo as Bar }", expected: ["Bar", "Foo"] },
      { source: "export { Foo }", expected: ["Foo"] },
      { source: "export { a as b as c }", expected: ["c", "a"] },
      { source: "export { Foo, Bar as Baz }", expected: ["Foo", "Baz", "Bar"] },
      { source: "export { Foo as Bar, Baz as Bar }", expected: ["Bar", "Foo", "Baz"] },
      { source: "export { as Bar }", expected: [] },
      { source: "export { Foo as 1bad }", expected: ["Foo"] },
      { source: "export { Foo as , Bar }", expected: ["Bar"] },
      { source: "module.exports = { Foo as Bar, Baz }", expected: ["Bar", "Foo", "Baz"] },
    ];
    for (const { source, expected } of cases) {
      assert.deepEqual([...extractDeclaredIdentifiers(source, "js")], expected);
    }
  });
});

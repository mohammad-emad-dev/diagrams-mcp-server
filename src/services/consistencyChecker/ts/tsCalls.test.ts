// AST call collection for TypeScript sequence generation. Uses the real
// compiler only: no mock compiler objects, so the callee-token ordering,
// caller scopes, and deferral rules are proven against actual parsing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectTsCalls } from "./tsCalls.js";
import type { TsCallAnalysis } from "./tsCalls.js";
import { loadTsModule, parseTsSource } from "./tsParse.js";
import type { TsModule } from "./tsParse.js";
import type { CallEdge } from "../sequence/callGraph.js";

async function collect(source: string): Promise<{ analysis: TsCallAnalysis; compiler: TsModule }> {
  const compiler = await loadTsModule();
  assert.notEqual(compiler, null, "TypeScript compiler must be installed for AST tests");
  const parsed = await parseTsSource("sample.ts", source, compiler);
  assert.notEqual(parsed, null, "test source must parse");
  return { analysis: collectTsCalls(parsed, compiler as TsModule), compiler: compiler as TsModule };
}

function edgeSummary(edges: CallEdge[]): Array<[string, string, boolean, number]> {
  return edges.map((edge) => [edge.caller, edge.callee, edge.viaCallback, edge.line]);
}

describe("collectTsCalls", () => {
  it("recognizes static callees through parentheses and TypeScript assertions", async () => {
    const { analysis } = await collect("(charge)();\n(service.pay)!();\n(<() => void>refund)();\n");
    assert.deepEqual(edgeSummary(analysis.edges), [
      ["<module>", "charge", false, 1],
      ["<module>", "pay", false, 2],
      ["<module>", "refund", false, 3],
    ]);
  });

  it("identifies named functions, variable-bound arrows, and class methods as operations", async () => {
    const { analysis } = await collect(
      "export function checkout() {\n  charge();\n}\n" +
        "export const handler = () => {\n  charge();\n};\n" +
        "export const worker = function () {\n  charge();\n};\n" +
        "export class Payment {\n  pay() {\n    charge();\n  }\n  idle() {}\n}\n",
    );

    for (const name of ["checkout", "handler", "worker", "pay", "idle"]) {
      assert.ok(analysis.operations.has(name), `operations must include ${name}`);
    }
    assert.deepEqual(edgeSummary(analysis.edges), [
      ["checkout", "charge", false, 2],
      ["handler", "charge", false, 5],
      ["worker", "charge", false, 8],
      ["pay", "charge", false, 12],
    ]);
  });

  it("restores the top-level caller after a function ends", async () => {
    const { analysis } = await collect("export function foo() {\n  bar();\n}\nbaz();\n");

    assert.ok(analysis.operations.has("foo"));
    assert.deepEqual(edgeSummary(analysis.edges), [
      ["foo", "bar", false, 2],
      ["<module>", "baz", false, 4],
    ]);
  });

  it("defers multiline callbacks while keeping surrounding direct calls sequenced", async () => {
    const { analysis } = await collect(
      "export function schedule() {\n" +
        "  before();\n" +
        "  setTimeout(() => {\n" +
        "    inside();\n" +
        "  }, 10);\n" +
        "  after();\n" +
        "}\n",
    );

    assert.deepEqual(edgeSummary(analysis.edges), [
      ["schedule", "before", false, 2],
      ["schedule", "setTimeout", true, 3],
      ["schedule", "inside", true, 4],
      ["schedule", "after", false, 6],
    ]);
  });

  it("keeps same-line direct calls sequenced next to a deferred wrapper", async () => {
    const { analysis } = await collect(
      "export function run() {\n  foo(); setTimeout(() => bar(), 10); baz();\n}\n",
    );

    assert.deepEqual(edgeSummary(analysis.edges), [
      ["run", "foo", false, 2],
      ["run", "setTimeout", true, 2],
      ["run", "bar", true, 2],
      ["run", "baz", false, 2],
    ]);
  });

  it("orders nested evaluation factory before pay by callee token position", async () => {
    const { analysis } = await collect("export function checkout() {\n  factory().pay();\n}\n");

    assert.deepEqual(edgeSummary(analysis.edges), [
      ["checkout", "factory", false, 2],
      ["checkout", "pay", false, 2],
    ]);
  });

  it("extracts property and static element callees while ignoring dynamic and construction sites", async () => {
    const { analysis } = await collect(
      "export function run() {\n" +
        "  service.pay();\n" +
        '  store["refund"]();\n' +
        "  store[dynamic]();\n" +
        "  getHandler()();\n" +
        "  new Payment();\n" +
        "}\n",
    );

    assert.deepEqual(edgeSummary(analysis.edges), [
      ["run", "pay", false, 2],
      ["run", "refund", false, 3],
      ["run", "getHandler", false, 5],
    ]);
  });

  it("keeps known wrapper calls deferred instead of sequencing scheduling as activity", async () => {
    const { analysis } = await collect(
      "export function after() {\n  Promise.resolve().then(() => charge());\n}\n",
    );

    assert.deepEqual(edgeSummary(analysis.edges), [
      ["after", "resolve", false, 2],
      ["after", "then", true, 2],
      ["after", "charge", true, 2],
    ]);
  });

  it("returns empty results for missing shapes", async () => {
    const compiler = await loadTsModule();
    assert.notEqual(compiler, null);
    assert.deepEqual(collectTsCalls(undefined, compiler as TsModule), {
      edges: [],
      operations: new Set<string>(),
    });
    assert.deepEqual(collectTsCalls(null, compiler as TsModule), {
      edges: [],
      operations: new Set<string>(),
    });
    assert.deepEqual(collectTsCalls({}, compiler as TsModule), {
      edges: [],
      operations: new Set<string>(),
    });
  });
});

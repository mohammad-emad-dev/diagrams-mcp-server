import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectTsCalls } from "./tsCalls.js";
import { loadTsModule, parseTsSource } from "./tsParse.js";

async function analyzeCalls(source: string) {
  const compiler = await loadTsModule();
  assert.ok(compiler, "TypeScript compiler must be installed for AST tests");
  const parsed = await parseTsSource("sample.ts", source, compiler);
  assert.ok(parsed, "Test source must parse");
  return collectTsCalls(parsed, compiler).edges.map((edge) => ({
    caller: edge.caller,
    callee: edge.callee,
    viaCallback: edge.viaCallback,
  }));
}

describe("constructor callback classification", () => {
  for (const scenario of [
    {
      name: "inline arrow",
      source: "function run(){new Task(()=>charge());after();}",
      caller: "run",
    },
    {
      name: "named function",
      source: "function run(){new Promise(function work(){charge();});after();}",
      caller: "work",
    },
  ]) {
    it(`excludes a constructor's ${scenario.name} callback and restores the outer caller`, async () => {
      assert.deepEqual(await analyzeCalls(scenario.source), [
        { caller: scenario.caller, callee: "charge", viaCallback: true },
        { caller: "run", callee: "after", viaCallback: false },
      ]);
    });
  }

  it("classifies object callback properties separately from eager initializers", async () => {
    assert.deepEqual(
      await analyzeCalls(
        "function run(){new Task({handler:()=>charge(), eager:before()});after();}",
      ),
      [
        { caller: "handler", callee: "charge", viaCallback: true },
        { caller: "run", callee: "before", viaCallback: false },
        { caller: "run", callee: "after", viaCallback: false },
      ],
    );
  });

  it("keeps constructor factory calls and eager arguments, including a new without arguments", async () => {
    assert.deepEqual(
      await analyzeCalls(
        "function run(){new (factory())(()=>charge(),before());new Task;after();}",
      ),
      [
        { caller: "run", callee: "factory", viaCallback: false },
        { caller: "run", callee: "charge", viaCallback: true },
        { caller: "run", callee: "before", viaCallback: false },
        { caller: "run", callee: "after", viaCallback: false },
      ],
    );
  });
});

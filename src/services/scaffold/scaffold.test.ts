import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTITY_NAME_CHARS, MAX_SCAFFOLD_SOURCE_BYTES } from "../../constants.js";
import {
  buildScaffold,
  buildScaffoldWithMembers,
  ScaffoldSourceTooLargeError,
} from "./scaffold.js";
import type { DiagramType } from "../../types.js";

async function codeDiagnostics(code: string): Promise<number[]> {
  const ts = await import("typescript");
  const fileName = "scaffold.ts";
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true);
  const host: import("typescript").CompilerHost = {
    getSourceFile: (name) => (name === fileName ? source : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? code : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [fileName],
    {
      noLib: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
    host,
  );
  // Missing globals belong to this minimal host; inspect diagnostics for the generated file.
  return [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ].map((diagnostic) => diagnostic.code);
}

describe("scaffold service", () => {
  const examples: Array<{ type: DiagramType; diagram: string; names: string[] }> = [
    {
      type: "plantuml",
      diagram: "@startuml\nclass B\nclass A\nclass B\n@enduml\n",
      names: ["B", "A"],
    },
    {
      type: "mermaid",
      diagram: "classDiagram\nclass User\nclass Order\n",
      names: ["User", "Order"],
    },
    {
      type: "mermaid",
      diagram:
        "sequenceDiagram\nparticipant Checkout\nparticipant Order\nCheckout->>Order: charge()\n",
      names: ["Checkout", "Order", "charge"],
    },
  ];
  for (const { type, diagram, names } of examples) {
    it(`emits ordered name-only classes from ${type} candidates ${names.join(",")}`, () => {
      const draft = buildScaffold(diagram, type, 30);
      assert.deepEqual(draft.entities, names);
      assert.equal(
        draft.source,
        names.map((name) => `export class ${name} {}`).join("\n\n") + "\n",
      );
      assert.equal(draft.entitiesAvailable, names.length);
      assert.deepEqual(draft.skippedEntities, []);
    });
  }

  it("reports invalid and reserved candidates while emitting compilable TypeScript", async () => {
    const skipped = [
      "class",
      "default",
      "await",
      "yield",
      "eval",
      "arguments",
      "any",
      "unknown",
      "never",
      "number",
      "string",
      "boolean",
      "symbol",
      "object",
      "undefined",
      "bigint",
      "let",
      "interface",
      "implements",
      "static",
      "Bad Name",
      "Bad-Name",
      "3rdParty",
      "é",
      "A".repeat(MAX_ENTITY_NAME_CHARS + 1),
      "Evil;execute()",
    ];
    const valid = ["Class", "_Good", "A".repeat(MAX_ENTITY_NAME_CHARS)];
    const diagram =
      "@startuml\n" +
      [...valid, ...skipped].map((name) => `participant "${name}"`).join("\n") +
      "\n@enduml\n";
    const draft = buildScaffold(diagram, "plantuml", 30);
    assert.deepEqual(draft.entities, valid);
    assert.equal(draft.skippedCount, skipped.length);
    assert.equal(draft.entitiesAvailable + draft.skippedCount, valid.length + skipped.length);
    assert.doesNotMatch(draft.source, /execute|Bad|3rdParty/);
    assert.deepEqual(await codeDiagnostics(draft.source), []);
    assert.ok(
      (await codeDiagnostics("export class any {}\n")).includes(2414),
      "compiler oracle detects semantic forbidden-name errors",
    );
  });

  it("keeps skipped names independent of valid candidates removed by the cap", () => {
    const names = Array.from({ length: 62 }, (_, index) => `Model${index}`);
    const diagram =
      "@startuml\nclass class\n" + names.map((name) => `class ${name}`).join("\n") + "\n@enduml\n";
    for (const limit of [1, 60]) {
      const draft = buildScaffold(diagram, "plantuml", limit);
      assert.deepEqual(draft.entities, names.slice(0, limit));
      assert.equal(draft.entitiesAvailable, 62);
      assert.equal(draft.entitiesCapped, true);
      assert.equal(draft.entityLimit, limit);
      assert.deepEqual(draft.skippedEntities, ["class"]);
      assert.equal(draft.skippedCount, 1);
    }
  });

  it("returns no placeholder for empty or entirely skipped candidates", () => {
    for (const declarations of ["", "class class\n"]) {
      const draft = buildScaffold(`@startuml\n${declarations}@enduml\n`, "plantuml", 30);
      assert.equal(draft.source, "");
      assert.deepEqual(draft.entities, []);
      assert.equal(draft.entitiesAvailable, 0);
      assert.equal(draft.entitiesCapped, false);
      assert.equal(draft.skippedCount, declarations ? 1 : 0);
    }
  });

  it("accepts the exact UTF-8 source byte limit and rejects one byte more", () => {
    const prefix = "@startuml\nclass A\n' ";
    const suffix = "\n@enduml\n";
    const padding = MAX_SCAFFOLD_SOURCE_BYTES - Buffer.byteLength(prefix + suffix, "utf8");
    const diagram = prefix + "é".repeat(Math.floor(padding / 2)) + " ".repeat(padding % 2) + suffix;
    assert.equal(Buffer.byteLength(diagram, "utf8"), MAX_SCAFFOLD_SOURCE_BYTES);
    assert.ok(diagram.length < MAX_SCAFFOLD_SOURCE_BYTES);
    for (const build of [buildScaffold, buildScaffoldWithMembers]) {
      assert.deepEqual(build(diagram, "plantuml", 30).entities, ["A"]);
      assert.throws(() => build(diagram + "x", "plantuml", 30), ScaffoldSourceTooLargeError);
    }
  });
});

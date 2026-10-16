import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { DiagramType } from "../../types.js";
import { buildScaffoldWithRelations, buildScaffoldWithTypes } from "./scaffold.js";

function diagram(type: DiagramType): string {
  return [
    type === "plantuml" ? "@startuml" : "classDiagram",
    "Order --> Customer : customer",
    'Order --> "*" Item : items',
    'Item --> "0..*" Order : orders',
    'Customer --> "1..*" Order : history',
    "Order --> Order : self",
    "class Order {",
    "id: string",
    "submit()",
    "}",
    "class Customer",
    "class Item {}",
    type === "plantuml" ? "@enduml" : "",
  ].join("\n");
}

async function diagnosticCodes(code: string): Promise<number[]> {
  const ts = await import("typescript");
  const fileName = path.resolve("scaffold-relations.generated.ts").replace(/\\/g, "/");
  const options = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) =>
    name.replace(/\\/g, "/") === fileName
      ? ts.createSourceFile(name, code, options.target, true)
      : readSource(name, ...args);
  const program = ts.createProgram([fileName], options, host);
  assert.ok(program.getSourceFiles().some((source) => /lib\..*\.d\.ts$/.test(source.fileName)));
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);
}

describe("scaffold named relationship fields", () => {
  it("emits labeled scalar and array fields after body members in both dialects", () => {
    for (const type of ["plantuml", "mermaid"] as const) {
      const draft = buildScaffoldWithRelations(diagram(type), type, 30);
      assert.equal(
        draft.source,
        "export class Order {\n  id!: string;\n" +
          '  submit(..._args: unknown[]): unknown { throw "Not implemented"; }\n' +
          "  customer!: Customer;\n  items!: Item[];\n  self!: Order;\n}\n\n" +
          "export class Customer {\n  history!: Order[];\n}\n\n" +
          "export class Item {\n  orders!: Order[];\n}\n",
        type,
      );
      assert.equal(draft.relationsIncluded, 5);
      assert.equal(draft.relationsSkipped, 0);
      assert.equal(draft.relationsCapped, false);
      assert.equal(draft.relationLimit, 300);
      assert.equal(draft.membersIncluded, 7);
      assert.equal(draft.typedFields, 6);
      assert.equal(draft.unresolvedFields, 0);
      assert.equal(draft.membersCapped, false);
      assert.doesNotMatch(
        buildScaffoldWithTypes(diagram(type), type, 30).source,
        /customer!:|items!:|self!:|history!:|orders!:/,
      );
    }
  });

  it("filters declarations and scopes before accepting candidates and counting skips", () => {
    const rejected = [
      "Owner --> Missing : absent",
      "Actor --> Target : actor",
      "Owner --> Alias : alias",
      "Owner --> Hidden : hidden",
      "Owner --> NoteOnly : noteTarget",
      "Owner --> CommentOnly : commentTarget",
      "Owner --> Generic : generic",
      "Owner --> Target : constructor",
      "Owner --> Target : prototype",
      `Owner --> Target : ${"A".repeat(61)}`,
    ];
    const source = [
      "@startuml",
      "class Owner {}",
      "class Target {}",
      "participant Actor",
      'class "Display" as Alias {}',
      "class Generic<T> {}",
      "namespace Nested {",
      "class Hidden {}",
      "Owner --> Target : nested",
      "}",
      "class Container {",
      "Owner --> Target : body",
      "}",
      "note right of Owner",
      "class NoteOnly",
      "Owner --> Target : noted",
      "end note",
      "/'",
      "class CommentOnly",
      "Owner --> Target : blocked",
      "'/",
      "' Owner --> Target : apostrophe",
      "%% Owner --> Target : commented",
      "Owner --> Target : valid",
      ...rejected,
      "Owner ..> Target : dependency",
      "Owner <-- Target : reversed",
      'Owner --> "1" Target : one',
      'Owner "1" --> Target : left',
      "Owner --> Target",
      "Owner --> Target : bad-role",
      "Owner --> Target : injected();",
      "@enduml",
    ].join("\n");
    const draft = buildScaffoldWithRelations(source, "plantuml", 60);
    assert.equal(draft.relationsIncluded, 1);
    assert.equal(draft.relationsSkipped, rejected.length);
    assert.equal(draft.relationsCapped, false);
    assert.match(draft.source, /valid!: Target;/);
    assert.doesNotMatch(
      draft.source,
      /(?:nested|body|noted|blocked|apostrophe|commented|injected)!:/,
    );
    const sequence = buildScaffoldWithRelations(
      "sequenceDiagram\nparticipant Owner\nparticipant Target\nOwner --> Target : field",
      "mermaid",
      30,
    );
    assert.equal(sequence.relationsIncluded, 0);
    assert.equal(sequence.relationsSkipped, 0);
  });

  it("lets body members and first accepted roles win before class cap accounting", () => {
    const body = Array.from({ length: 28 }, (_, index) => `f${index}: string`).join("\n");
    const prefix =
      "@startuml\nOwner --> Target : keep\nOwner --> Target : linked\nOwner --> Alternate : linked\nOwner --> Target : f0\n";
    const declarations = `class Owner {\n${body}\nkeep()\n}\nclass Target\nclass Alternate\n@enduml`;
    const exact = buildScaffoldWithRelations(prefix + declarations, "plantuml", 30);
    assert.equal(exact.membersIncluded, 30);
    assert.equal(exact.relationsIncluded, 1);
    assert.equal(exact.relationsSkipped, 3);
    assert.equal(exact.relationsCapped, false);
    assert.equal(exact.membersCapped, false);
    assert.match(
      exact.source,
      /keep\(\.\.\._args: unknown\[\]\): unknown \{ throw "Not implemented"; \}\n  linked!: Target;/,
    );
    assert.doesNotMatch(exact.source, /linked!: Alternate/);
    const over = buildScaffoldWithRelations(
      prefix + "Owner --> Target : other\n" + declarations,
      "plantuml",
      30,
    );
    assert.equal(over.relationsIncluded, 1);
    assert.equal(over.relationsSkipped, 4);
    assert.equal(over.relationsCapped, true);
    assert.equal(over.membersCapped, true);
    assert.equal(over.typedFields, 29);
    assert.doesNotMatch(over.source, /other!:/);
    const excluded = buildScaffoldWithRelations(prefix + declarations, "plantuml", 1);
    assert.deepEqual(excluded.entities, ["Owner"]);
    assert.equal(excluded.entitiesCapped, true);
    assert.equal(excluded.relationsIncluded, 0);
    assert.equal(excluded.relationsSkipped, 4);
    assert.equal(excluded.relationsCapped, false);
    assert.equal(excluded.membersCapped, false);
  });

  it("counts beyond the global cap without confusing duplicates with cap refusals", () => {
    const declarations =
      Array.from({ length: 11 }, (_, index) => `class Owner${index}`).join("\n") +
      "\nclass Target\n";
    const edges = Array.from({ length: 11 }, (_, owner) =>
      Array.from({ length: 30 }, (_, role) => `Owner${owner} --> Target : r${role}`).join("\n"),
    );
    const prefix = "classDiagram\n" + declarations;
    const exact = buildScaffoldWithRelations(
      prefix + edges.slice(0, 10).join("\n") + "\nOwner0 --> Target : r0\nOwner0 --> Target : r29",
      "mermaid",
      60,
    );
    assert.equal(exact.relationsIncluded, 300);
    assert.equal(exact.relationsSkipped, 2);
    assert.equal(exact.relationsCapped, false);
    assert.equal(exact.membersCapped, false);
    const over = buildScaffoldWithRelations(prefix + edges.join("\n"), "mermaid", 60);
    assert.equal(over.relationsIncluded, 300);
    assert.equal(over.relationsSkipped, 30);
    assert.equal(over.relationsCapped, true);
    assert.equal(over.membersCapped, false);
    assert.equal(over.membersIncluded, 300);
    assert.equal(over.typedFields, 300);
    assert.match(over.source, /export class Owner10 \{\}/);
  });

  it("compiles self and mutual references, arrays and keyword-like property names", async () => {
    const source =
      diagram("plantuml").replace("@enduml", "") +
      "\nclass Error {}\nclass globalThis {}\nError --> globalThis : class\nglobalThis --> Error : static\n@enduml";
    const draft = buildScaffoldWithRelations(source, "plantuml", 60);
    assert.match(draft.source, /class!: globalThis;/);
    assert.match(draft.source, /static!: Error;/);
    assert.deepEqual(await diagnosticCodes(draft.source), []);
    assert.ok((await diagnosticCodes("export class Broken { ref!: Missing; }")).includes(2304));
  });
});

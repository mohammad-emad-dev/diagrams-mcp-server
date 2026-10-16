import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildScaffold, buildScaffoldWithMembers } from "./scaffold.js";
import type { DiagramType } from "../../types.js";

const examples: Array<{ type: DiagramType; diagram: string; name: string }> = [
  {
    type: "plantuml",
    name: "Account",
    diagram:
      "@startuml\nclass Account {\n+id: Long\n-Money amount\n#String describe(id): String\n~refresh()\n}\n@enduml\n",
  },
  {
    type: "mermaid",
    name: "Cart",
    diagram:
      "%% comment\nclassDiagram\nclass Cart {\n+id: Long\n-Money amount\n#describe(id) String\n~refresh()\n}\n",
  },
];

async function diagnosticCodes(code: string): Promise<number[]> {
  const ts = await import("typescript");
  const fileName = path.resolve("scaffold-members.generated.ts").replace(/\\/g, "/");
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

describe("scaffold member drafts", () => {
  it("emits unknown fields and throwing methods for the supported dialect forms", () => {
    for (const { type, diagram, name } of examples) {
      const draft = buildScaffoldWithMembers(diagram, type, 30);
      assert.equal(
        draft.source,
        `export class ${name} {\n` +
          "  id: unknown;\n  amount: unknown;\n" +
          '  describe(..._args: unknown[]): unknown { throw "Not implemented"; }\n' +
          '  refresh(..._args: unknown[]): unknown { throw "Not implemented"; }\n}\n',
        type,
      );
      assert.equal(draft.membersIncluded, 4);
      assert.equal(draft.membersCapped, false);
      assert.equal(draft.memberLimit, 30);
      assert.equal(buildScaffold(diagram, type, 30).source, `export class ${name} {}\n`);
    }
  });

  it("keeps notes, comments and unsupported nested blocks out of member drafts", () => {
    const diagram = [
      "@startuml",
      "class Vault {",
      "+name: string",
      "name()",
      "constructor()",
      "prototype()",
      "bad; execute()",
      "assigned = source",
      'quoted: "source"',
      "broken)",
      "function(x):",
      "note right",
      "secret: Injected",
      "}",
      "end note",
      "' comment: Injected",
      "%% otherComment: Injected",
      "/'",
      "blockComment: Injected",
      "}",
      "'/",
      "audit() {",
      "internal: Injected",
      "}",
      "+fetch(key): void",
      "}",
      'class "Display" as Vault {',
      "aliasMember: Injected",
      "class Vault {",
      "nested: Injected",
      "}",
      "}",
      "class Vault<T> {",
      "genericMember: Injected",
      "}",
      "class Vault {",
      "name: duplicate",
      "last: int",
      "}",
      "@enduml",
    ].join("\n");
    const draft = buildScaffoldWithMembers(diagram, "plantuml", 30);
    assert.match(draft.source, /name: unknown;/);
    assert.match(draft.source, /fetch\(\.\.\._args: unknown\[\]\)/);
    assert.match(draft.source, /last: unknown;/);
    assert.equal(draft.membersIncluded, 3);
    assert.doesNotMatch(
      draft.source,
      /Injected|secret|Comment|constructor|prototype|aliasMember|nested|genericMember|internal|audit|broken|function\(/,
    );
    assert.equal(draft.source.match(/name: unknown/g)?.length, 1);
    assert.doesNotMatch(draft.source, /name\(/);
  });

  it("counts caps only for unique members of emitted classes, across duplicate blocks", () => {
    const fields = Array.from({ length: 30 }, (_, index) => `f${index}: T`).join("\n");
    const prefix = `@startuml\nclass First {\n${fields}\n}\nclass First {\nf0()\nf29: T\n}\n`;
    const excluded = `class Excluded {\n${fields}\nextra: T\n}\n@enduml`;
    const exact = buildScaffoldWithMembers(prefix + excluded, "plantuml", 1);
    assert.equal(exact.membersIncluded, 30);
    assert.equal(
      exact.membersCapped,
      false,
      "duplicates and an excluded class cannot trigger the cap",
    );
    const over = buildScaffoldWithMembers(
      prefix + "class First {\nover: T\n}\n" + excluded,
      "plantuml",
      1,
    );
    assert.equal(over.membersIncluded, 30);
    assert.equal(over.membersCapped, true);
    assert.doesNotMatch(over.source, /over:|Excluded|extra:/);
    const both = buildScaffoldWithMembers(prefix + excluded, "plantuml", 2);
    assert.equal(both.membersIncluded, 60);
    assert.equal(both.membersCapped, true);
  });

  it("does not attach members from other diagram kinds or unsupported class declarations", () => {
    for (const diagram of [
      "sequenceDiagram\nparticipant Item\nclass Item {\nid: int\n}\n",
      'classDiagram\nclass Item\nclass "Label" as Item {\nid: int\n}\n',
    ]) {
      const draft = buildScaffoldWithMembers(diagram, "mermaid", 30);
      assert.equal(draft.membersIncluded, 0);
      assert.doesNotMatch(draft.source, /id:/);
    }
    const inline = buildScaffoldWithMembers(
      "classDiagram\nclass Item {\nvalue: int %% ignored: int\n}\n",
      "mermaid",
      30,
    );
    assert.equal(inline.membersIncluded, 1);
    assert.match(inline.source, /value: unknown/);
  });

  it("compiles stub output even when class and member names resemble built-ins or keywords", async () => {
    const builtIns = buildScaffoldWithMembers(
      "@startuml\nclass Error {}\nclass globalThis {}\nclass Subject {\nstatic: bool\ndelete: int\nfunction()\n__proto__: int\n}\n@enduml",
      "plantuml",
      30,
    );
    const code =
      examples
        .map(({ diagram, type }) => buildScaffoldWithMembers(diagram, type, 30).source)
        .join("\n") + builtIns.source;
    assert.deepEqual(await diagnosticCodes(code), []);
    assert.ok(
      (await diagnosticCodes("export class Dup { name: unknown; name: unknown; }")).includes(2300),
    );
  });
});

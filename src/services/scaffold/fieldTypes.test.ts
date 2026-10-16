import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildScaffold, buildScaffoldWithMembers, buildScaffoldWithTypes } from "./scaffold.js";

const primitivesDiagram =
  "@startuml\nclass Order {\n+id: string\n-total: number\n~paid: boolean\n+bigint version\n+customer: Customer\n+items: Item[]\n+tags: string[]\n+plain\n-Money amount\n+describe(id): string\n}\nclass Customer {}\nclass Item {}\n@enduml\n";

const cartDiagram =
  "classDiagram\nclass Cart {\n+sku: string\n+qty: number\nowner: User\nlines: Line[]\nlabels: string[]\nrefresh()\n}\nclass User {}\nclass Line {}\n";

const fallbackDiagram =
  '@startuml\nclass Packet {\nname: string\nbyte: string\nbytes: string\nalias: String\ncount: integer\nflag: booleanish\nmaybe: any\nnothing: null\nundef: undefined\nblank: void\nboxed: List<string>\neither: string|number\nqualified: meta.Tag\nnested: Token[][]\nhandler: Function\npadded :  string\nspaced: str ing\nquoted: "secret"\nassigned = source\nrun();\nrecord: { id: string }\n}\nclass Token {}\n@enduml\n';

const ledgerDiagram =
  "@startuml\nclass Ledger {\nself: Ledger\npeer: Entry\nfar: Batch\n}\nclass Entry {\nback: Ledger\n}\nclass Batch {\npeer: Entry\n}\n@enduml\n";

const archiveFields = Array.from({ length: 29 }, (_, index) => `f${index}: string`);

const archiveDiagram = `@startuml\nclass Archive {\n${archiveFields.join("\n")}\ndup: string\nover: number\ndup: boolean\nmethod(): string\n}\nclass Excluded {\n${archiveFields.join("\n")}\nextra: string\n}\n@enduml\n`;

const soloDiagram =
  "@startuml\nclass Solo {\na: string\na: number\nb: Thing\nb: string\nc: Missing\nrun(): Thing\n}\nclass Solo {\na: boolean\n}\nclass Thing {}\n@enduml\n";

const builtInsDiagram =
  "@startuml\nclass Error {\nmessage: string\nstack: text\n}\nclass globalThis {\nscope: string\n}\nclass Subject {\nown: Subject\nother: globalThis\nliteral: string\ndelete: number\nstatic: string\nnew: boolean\n__proto__: Subject\nfunction()\n}\n@enduml\n";

async function diagnosticCodes(code: string): Promise<number[]> {
  const ts = await import("typescript");
  const fileName = path.resolve("scaffold-field-types.generated.ts").replace(/\\/g, "/");
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

describe("typed scaffold field types", () => {
  it("emits scalars, emitted-class references and single arrays in both dialects", () => {
    const order = buildScaffoldWithTypes(primitivesDiagram, "plantuml", 30);
    assert.equal(
      order.source,
      "export class Order {\n  id!: string;\n  total!: number;\n  paid!: boolean;\n  version!: bigint;\n  customer!: Customer;\n  items!: Item[];\n  tags!: string[];\n  plain: unknown;\n  amount: unknown;\n" +
        '  describe(..._args: unknown[]): unknown { throw "Not implemented"; }\n' +
        "}\n\nexport class Customer {}\n\nexport class Item {}\n",
    );
    assert.equal(order.typedFields, 7);
    assert.equal(order.unresolvedFields, 2);
    assert.equal(order.membersIncluded, 10);
    assert.equal(order.membersCapped, false);
    assert.equal(order.memberLimit, 30);

    const cart = buildScaffoldWithTypes(cartDiagram, "mermaid", 30);
    assert.equal(
      cart.source,
      "export class Cart {\n  sku!: string;\n  qty!: number;\n  owner!: User;\n  lines!: Line[];\n  labels!: string[];\n" +
        '  refresh(..._args: unknown[]): unknown { throw "Not implemented"; }\n' +
        "}\n\nexport class User {}\n\nexport class Line {}\n",
    );
    assert.equal(cart.typedFields, 5);
    assert.equal(cart.unresolvedFields, 0);
    assert.equal(cart.membersIncluded, 6);

    // Name-only and unknown-typed modes keep their existing source shape.
    assert.equal(
      buildScaffold(primitivesDiagram, "plantuml", 30).source,
      "export class Order {}\n\nexport class Customer {}\n\nexport class Item {}\n",
    );
    const unknown = buildScaffoldWithMembers(primitivesDiagram, "plantuml", 30);
    assert.equal(unknown.membersIncluded, 10);
    assert.equal(unknown.source.match(/: unknown;/g)?.length, 9);
    assert.doesNotMatch(unknown.source, /!:/);
  });

  it("falls back to unknown for every unsupported label and skipped line", () => {
    const packet = buildScaffoldWithTypes(fallbackDiagram, "plantuml", 30);
    assert.equal(packet.typedFields, 4);
    assert.equal(packet.unresolvedFields, 13);
    assert.equal(packet.membersIncluded, 17);
    assert.equal(packet.membersCapped, false);
    for (const typed of [
      "  name!: string;",
      "  byte!: string;",
      "  bytes!: string;",
      "  padded!: string;",
    ]) {
      assert.ok(packet.source.includes(typed), typed);
    }
    assert.equal(packet.source.match(/: unknown;/g)?.length, 13);
    // Rejected labels never leak, and lines the parser skips produce no member.
    assert.doesNotMatch(
      packet.source,
      /String|integer|booleanish|\bany\b|\bnull\b|undefined|\bvoid\b|List<|\|number|meta\.Tag|Token\[\[\]|Function|str ing|secret|assigned|run\(|record/,
    );
    const longestName = "A".repeat(60);
    const boundary = buildScaffoldWithTypes(
      `@startuml\nclass Boundaries {\nvalid: ${longestName}[]\ntooLong: ${longestName}[]x\nhuge: ${"A".repeat(100_000)}\n}\nclass ${longestName} {}\n@enduml`,
      "plantuml",
      30,
    );
    assert.equal(boundary.typedFields, 1);
    assert.equal(boundary.unresolvedFields, 2);
    assert.ok(boundary.source.includes(`valid!: ${longestName}[];`));
    assert.match(boundary.source, /tooLong: unknown;\n  huge: unknown;/);
  });

  it("resolves references only to emitted classes, so cap-dropped ones fall back", () => {
    const ledger = buildScaffoldWithTypes(ledgerDiagram, "plantuml", 2);
    assert.deepEqual(ledger.entities, ["Ledger", "Entry"]);
    assert.equal(ledger.entitiesAvailable, 3);
    assert.equal(ledger.entitiesCapped, true);
    assert.equal(
      ledger.source,
      "export class Ledger {\n  self!: Ledger;\n  peer!: Entry;\n  far: unknown;\n}\n\nexport class Entry {\n  back!: Ledger;\n}\n",
    );
    assert.equal(ledger.typedFields, 3);
    assert.equal(ledger.unresolvedFields, 1);
    assert.equal(ledger.membersIncluded, 4);
  });

  it("counts typed and unresolved fields under the member cap with first duplicate winning", () => {
    const archive = buildScaffoldWithTypes(archiveDiagram, "plantuml", 1);
    assert.equal(archive.membersIncluded, 30);
    assert.equal(archive.membersCapped, true);
    assert.equal(archive.memberLimit, 30);
    assert.equal(archive.typedFields, 30);
    assert.equal(archive.unresolvedFields, 0);
    assert.equal(archive.source.match(/dup!: string;/g)?.length, 1);
    // Over-cap, duplicate and method lines are all excluded from the counts.
    assert.doesNotMatch(archive.source, /over:|dup!: boolean|method\(|extra:|Excluded/);

    const solo = buildScaffoldWithTypes(soloDiagram, "plantuml", 30);
    assert.equal(
      solo.source,
      "export class Solo {\n  a!: string;\n  b!: Thing;\n  c: unknown;\n" +
        '  run(..._args: unknown[]): unknown { throw "Not implemented"; }\n' +
        "}\n\nexport class Thing {}\n",
    );
    assert.equal(solo.typedFields, 2);
    assert.equal(solo.unresolvedFields, 1);
    assert.equal(solo.membersIncluded, 4);
    assert.equal(solo.membersCapped, false);
  });

  it("compiles typed drafts against a strict TypeScript oracle", async () => {
    const code = [
      buildScaffoldWithTypes(primitivesDiagram, "plantuml", 30),
      buildScaffoldWithTypes(cartDiagram, "mermaid", 30),
      buildScaffoldWithTypes(fallbackDiagram, "plantuml", 30),
      buildScaffoldWithTypes(ledgerDiagram, "plantuml", 2),
      buildScaffoldWithTypes(archiveDiagram, "plantuml", 1),
      buildScaffoldWithTypes(soloDiagram, "plantuml", 30),
      buildScaffoldWithTypes(builtInsDiagram, "plantuml", 30),
    ]
      .map((draft) => draft.source)
      .join("\n");
    const builtIns = buildScaffoldWithTypes(builtInsDiagram, "plantuml", 30);
    assert.match(builtIns.source, /other!: globalThis;/);
    assert.match(builtIns.source, /stack: unknown;/);
    assert.equal(builtIns.typedFields, 9);
    assert.equal(builtIns.unresolvedFields, 1);
    const classNamedString = buildScaffoldWithTypes(
      "@startuml\nclass String {}\nclass Box {\nvalue: String\n}\n@enduml",
      "plantuml",
      30,
    );
    assert.match(classNamedString.source, /value!: String;/);
    assert.equal(classNamedString.typedFields, 1);
    assert.deepEqual(await diagnosticCodes(code + classNamedString.source), []);
    assert.ok(
      (await diagnosticCodes("export class Dup { name!: string; name!: string; }")).includes(2300),
    );
  });
});

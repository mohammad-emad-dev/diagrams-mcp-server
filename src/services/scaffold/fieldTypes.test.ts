import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MAX_ENTITY_NAME_CHARS } from "../../constants.js";
import { buildScaffold, buildScaffoldWithMembers, buildScaffoldWithTypes } from "./scaffold.js";

const primitivesDiagram =
  "@startuml\nclass Order {\n+id: string\n-total: number\n~paid: boolean\n+bigint version\n+customer: Customer\n+items: Item[]\n+tags: string[]\n+plain\n-Money amount\n+describe(id): string\n}\nclass Customer {}\nclass Item {}\n@enduml\n";

const cartDiagram =
  "classDiagram\nclass Cart {\n+sku: string\n+qty: number\nowner: User\nlines: Line[]\nlabels: string[]\nrefresh()\n}\nclass User {}\nclass Line {}\n";

const fallbackDiagram =
  '@startuml\nclass Packet {\nname: string\nbyte: string\nbytes: string\nalias: String\ncount: integer\nflag: booleanish\nmaybe: any\nnothing: null\nundef: undefined\nblank: void\nboxed: List<string>\neither: string|number\nqualified: meta.Tag\nnested: Token[][]\nhandler: Function\npadded :  string\nspaced: str ing\nquoted: "secret"\nassigned = source\nrun();\nrecord: { id: string }\n}\nclass Token {}\n@enduml\n';

const arrayWrapperCases = [
  { name: "strings", label: "Array<string>", expected: "string[]" },
  { name: "numbers", label: "Array<number>", expected: "number[]" },
  { name: "booleans", label: "ReadonlyArray<boolean>", expected: "readonly boolean[]" },
  { name: "bigints", label: "ReadonlyArray<bigint>", expected: "readonly bigint[]" },
  { name: "users", label: "Array<WrapperUser>", expected: "WrapperUser[]" },
  {
    name: "readonlyUsers",
    label: "ReadonlyArray<WrapperUser>",
    expected: "readonly WrapperUser[]",
  },
  { name: "nullableUsers", label: "Array<WrapperUser> | null", expected: "WrapperUser[] | null" },
  {
    name: "nullableUsersReverse",
    label: "null | Array<WrapperUser>",
    expected: "WrapperUser[] | null",
  },
  {
    name: "nullableReadonlyUsers",
    label: "ReadonlyArray<WrapperUser> | null",
    expected: "readonly WrapperUser[] | null",
  },
  {
    name: "nullableReadonlyReverse",
    label: "null | ReadonlyArray<WrapperUser>",
    expected: "readonly WrapperUser[] | null",
  },
] as const;

const arrayWrapperFields = arrayWrapperCases
  .map(({ name, label }) => `${name}: ${label}`)
  .join("\n");
const arrayWrapperPlantUmlDiagram = `@startuml\nclass Owner {\n${arrayWrapperFields}\n}\nclass WrapperUser {}\n@enduml\n`;
const arrayWrapperMermaidDiagram = `classDiagram\nclass Owner {\n${arrayWrapperFields}\n}\nclass WrapperUser {}\n`;

const ledgerDiagram =
  "@startuml\nclass Ledger {\nself: Ledger\npeer: Entry\nfar: Batch\nfarNullable: null | Batch\nfarArray: Array<Batch>\nfarReadonlyNullable: null | ReadonlyArray<Batch>\n}\nclass Entry {\nback: Ledger\n}\nclass Batch {\npeer: Entry\n}\n@enduml\n";

const invalidNullableFields = `bareNull: null
duplicateBareNull: null | null
bareUndefined: undefined
undefinedArm: undefined | null
extraArms: string | null | number
duplicateArms: string | string
duplicateNull: string | null | null
parenthesized: (string) | null
generic: List<string> | null
nestedArray: string[][] | null
missingClass: Missing | null
innerWhitespace: str ing | null
arrayWhitespace: string [] | null
unknownArm: unknown | null`;

const nullablePlantUmlDiagram = `@startuml
class Purchase {
title:  string   |   null
buyer: null|BuyerRecord
pieces: ProductPiece[] | null
tags: null | string[]
${invalidNullableFields}
}
class BuyerRecord {}
class ProductPiece {}
@enduml
`;

const nullableMermaidDiagram = `classDiagram
class BasketRecord {
title:  string   |   null
owner: null|MemberRecord
lines: CartPiece[] | null
labels: null | string[]
${invalidNullableFields}
}
class MemberRecord {}
class CartPiece {}
`;

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
      `@startuml\nclass Boundaries {\nvalid: ${longestName}[]\nvalidNullable: ${longestName}[] | null\nvalidNullableReverse: null | ${longestName}[]\ntooLong: ${longestName}[]x\ntooLongIdentifier: ${"A".repeat(61)}\nhuge: ${"A".repeat(100_000)}\n}\nclass ${longestName} {}\n@enduml`,
      "plantuml",
      30,
    );
    assert.equal(boundary.typedFields, 3);
    assert.equal(boundary.unresolvedFields, 3);
    assert.ok(boundary.source.includes(`valid!: ${longestName}[];`));
    assert.ok(boundary.source.includes(`validNullable!: ${longestName}[] | null;`));
    assert.ok(boundary.source.includes(`validNullableReverse!: ${longestName}[] | null;`));
    assert.match(
      boundary.source,
      /tooLong: unknown;\n  tooLongIdentifier: unknown;\n  huge: unknown;/,
    );
  });

  it("emits strict array wrappers and nullable arms in both dialects", () => {
    const expectedTypedFields = arrayWrapperCases
      .map(({ name, expected }) => `  ${name}!: ${expected};`)
      .join("\n");
    const expectedUnknownFields = arrayWrapperCases
      .map(({ name }) => `  ${name}: unknown;`)
      .join("\n");
    const diagrams = [
      { source: arrayWrapperPlantUmlDiagram, type: "plantuml" as const },
      { source: arrayWrapperMermaidDiagram, type: "mermaid" as const },
    ];

    for (const diagram of diagrams) {
      const typed = buildScaffoldWithTypes(diagram.source, diagram.type, 30);
      assert.equal(
        typed.source,
        `export class Owner {\n${expectedTypedFields}\n}\n\nexport class WrapperUser {}\n`,
      );
      assert.equal(typed.typedFields, arrayWrapperCases.length);
      assert.equal(typed.unresolvedFields, 0);
      assert.equal(typed.membersIncluded, arrayWrapperCases.length);

      const defaultDraft = buildScaffold(diagram.source, diagram.type, 30);
      assert.equal(defaultDraft.source, "export class Owner {}\n\nexport class WrapperUser {}\n");
      const memberDraft = buildScaffoldWithMembers(diagram.source, diagram.type, 30);
      assert.equal(
        memberDraft.source,
        `export class Owner {\n${expectedUnknownFields}\n}\n\nexport class WrapperUser {}\n`,
      );
      assert.equal(memberDraft.membersIncluded, arrayWrapperCases.length);
      assert.doesNotMatch(memberDraft.source, /!:|Array<|ReadonlyArray<|\| null/);
    }
  });

  it("rejects malformed, nested, unsupported, and unselected wrapper elements", () => {
    const malformedLabels = [
      ["spaceBeforeOpen", "Array <string>"],
      ["spaceAfterOpen", "Array< string>"],
      ["spaceBeforeClose", "ReadonlyArray<string >"],
      ["nestedGeneric", "Array<Array<string>>"],
      ["nestedReadonly", "ReadonlyArray<ReadonlyArray<WrapperUser>>"],
      ["nestedArray", "Array<string[]>"],
      ["arrayOfReadonly", "Array<ReadonlyArray<WrapperUser>>"],
      ["arraySuffix", "Array<string>[]"],
      ["readonlySuffix", "ReadonlyArray<WrapperUser>[]"],
      ["unionInside", "Array<string | null>"],
      ["qualified", "ReadonlyArray<meta.User>"],
      ["otherConstructor", "Set<string>"],
      ["anyElement", "Array<any>"],
      ["unknownElement", "ReadonlyArray<unknown>"],
      ["nullElement", "Array<null>"],
      ["undefinedElement", "ReadonlyArray<undefined>"],
      ["missingClass", "Array<Missing>"],
    ] as const;
    const fields = malformedLabels.map(([name, label]) => `${name}: ${label}`).join("\n");
    const diagrams = [
      {
        source: `@startuml\nclass Owner {\n${fields}\n}\nclass WrapperUser {}\n@enduml`,
        type: "plantuml" as const,
      },
      {
        source: `classDiagram\nclass Owner {\n${fields}\n}\nclass WrapperUser {}`,
        type: "mermaid" as const,
      },
    ];
    const expectedFields = malformedLabels.map(([name]) => `  ${name}: unknown;`).join("\n");

    for (const diagram of diagrams) {
      const typed = buildScaffoldWithTypes(diagram.source, diagram.type, 30);
      assert.equal(
        typed.source,
        `export class Owner {\n${expectedFields}\n}\n\nexport class WrapperUser {}\n`,
      );
      assert.equal(typed.typedFields, 0);
      assert.equal(typed.unresolvedFields, malformedLabels.length);
      assert.equal(typed.membersIncluded, malformedLabels.length);

      const defaultDraft = buildScaffold(diagram.source, diagram.type, 30);
      assert.equal(defaultDraft.source, "export class Owner {}\n\nexport class WrapperUser {}\n");
      const memberDraft = buildScaffoldWithMembers(diagram.source, diagram.type, 30);
      assert.equal(memberDraft.membersIncluded, malformedLabels.length);
      assert.equal(memberDraft.source.match(/: unknown;/g)?.length, malformedLabels.length);
      assert.doesNotMatch(memberDraft.source, /Array<|ReadonlyArray<|meta\.User|Missing/);
    }
  });

  it("canonicalizes one null arm and rejects other unions in both dialects", () => {
    const expectedSources = [
      "export class Purchase {\n" +
        "  title!: string | null;\n" +
        "  buyer!: BuyerRecord | null;\n" +
        "  pieces!: ProductPiece[] | null;\n" +
        "  tags!: string[] | null;\n" +
        "  bareNull: unknown;\n" +
        "  duplicateBareNull: unknown;\n" +
        "  bareUndefined: unknown;\n" +
        "  undefinedArm: unknown;\n" +
        "  extraArms: unknown;\n" +
        "  duplicateArms: unknown;\n" +
        "  duplicateNull: unknown;\n" +
        "  generic: unknown;\n" +
        "  nestedArray: unknown;\n" +
        "  missingClass: unknown;\n" +
        "  innerWhitespace: unknown;\n" +
        "  arrayWhitespace: unknown;\n" +
        "  unknownArm: unknown;\n" +
        "}\n\nexport class BuyerRecord {}\n\nexport class ProductPiece {}\n",
      "export class BasketRecord {\n" +
        "  title!: string | null;\n" +
        "  owner!: MemberRecord | null;\n" +
        "  lines!: CartPiece[] | null;\n" +
        "  labels!: string[] | null;\n" +
        "  bareNull: unknown;\n" +
        "  duplicateBareNull: unknown;\n" +
        "  bareUndefined: unknown;\n" +
        "  undefinedArm: unknown;\n" +
        "  extraArms: unknown;\n" +
        "  duplicateArms: unknown;\n" +
        "  duplicateNull: unknown;\n" +
        "  generic: unknown;\n" +
        "  nestedArray: unknown;\n" +
        "  missingClass: unknown;\n" +
        "  innerWhitespace: unknown;\n" +
        "  arrayWhitespace: unknown;\n" +
        "  unknownArm: unknown;\n" +
        "}\n\nexport class MemberRecord {}\n\nexport class CartPiece {}\n",
    ];
    const expectedDefaultSources = [
      "export class Purchase {}\n\nexport class BuyerRecord {}\n\nexport class ProductPiece {}\n",
      "export class BasketRecord {}\n\nexport class MemberRecord {}\n\nexport class CartPiece {}\n",
    ];
    const diagrams = [
      { source: nullablePlantUmlDiagram, type: "plantuml" as const },
      { source: nullableMermaidDiagram, type: "mermaid" as const },
    ];

    for (const [index, diagram] of diagrams.entries()) {
      const typed = buildScaffoldWithTypes(diagram.source, diagram.type, 30);
      assert.equal(typed.source, expectedSources[index]);
      assert.equal(typed.typedFields, 4);
      assert.equal(typed.unresolvedFields, 13);
      assert.equal(typed.membersIncluded, 17);

      const defaultDraft = buildScaffold(diagram.source, diagram.type, 30);
      assert.equal(defaultDraft.source, expectedDefaultSources[index]);
      const memberDraft = buildScaffoldWithMembers(diagram.source, diagram.type, 30);
      assert.equal(memberDraft.membersIncluded, 17);
      assert.equal(memberDraft.source.match(/: unknown;/g)?.length, 17);
      assert.doesNotMatch(memberDraft.source, /!:|\| null|Missing|List</);
    }
  });

  it("rejects empty nullable arms and enforces label and atom boundaries", () => {
    const longestName = "A".repeat(60);
    const tooLongName = "B".repeat(MAX_ENTITY_NAME_CHARS + 1);
    const cases: Array<[string, string, string | undefined]> = [
      ["emptyRight", "string |", undefined],
      ["emptyLeft", "| string", undefined],
      ["multipleArms", "string || null", undefined],
      ["bothEmpty", "|", undefined],
      ["nullArrayBefore", "null[] | string", undefined],
      ["nullArrayAfter", "string | null[]", undefined],
      ["simpleNullable", "string[] | null", "string[] | null"],
      ["longNullable", `${longestName}[] | null`, `${longestName}[] | null`],
      ["extraNullableWhitespace", `${longestName}[]  | null`, `${longestName}[] | null`],
      ["extraWhitespaceAt82", `${longestName}[]${" ".repeat(14)}| null`, `${longestName}[] | null`],
      ["readonlyAt82", `ReadonlyArray<${longestName}> | null`, `readonly ${longestName}[] | null`],
      ["readonlyAt83", `ReadonlyArray<${longestName}>  | null`, undefined],
      ["base60", longestName, longestName],
      ["base61", tooLongName, undefined],
      ["atom62", `${longestName}[]`, `${longestName}[]`],
      ["atom63", `${longestName}[]x`, undefined],
      ["wrapper60", `Array<${longestName}>`, `${longestName}[]`],
      ["wrapper61", `Array<${tooLongName}>`, undefined],
    ];
    const fields = cases.map(([name, label]) => `${name}: ${label}`).join("\n");
    const diagram = `@startuml\nclass Limits {\n${fields}\n}\nclass ${longestName} {}\nclass ${tooLongName} {}\n@enduml`;
    const limits = buildScaffoldWithTypes(diagram, "plantuml", 30);
    const expectedFields = cases
      .map(([name, , expected]) => `  ${name}${expected ? `!: ${expected}` : ": unknown"};`)
      .join("\n");

    assert.equal(
      limits.source,
      `export class Limits {\n${expectedFields}\n}\n\nexport class ${longestName} {}\n`,
    );
    assert.equal(
      limits.typedFields,
      cases.filter(([, , expected]) => expected !== undefined).length,
    );
    assert.equal(limits.unresolvedFields, cases.length - limits.typedFields);
    assert.equal(limits.membersIncluded, cases.length);
    assert.equal(limits.entitiesAvailable, 2);
    assert.deepEqual(limits.entities, ["Limits", longestName]);
    assert.deepEqual(limits.skippedEntities, [tooLongName]);
  });

  it("resolves references only to emitted classes, so cap-dropped ones fall back", () => {
    const ledger = buildScaffoldWithTypes(ledgerDiagram, "plantuml", 2);
    assert.deepEqual(ledger.entities, ["Ledger", "Entry"]);
    assert.equal(ledger.entitiesAvailable, 3);
    assert.equal(ledger.entitiesCapped, true);
    assert.equal(
      ledger.source,
      "export class Ledger {\n  self!: Ledger;\n  peer!: Entry;\n  far: unknown;\n  farNullable: unknown;\n  farArray: unknown;\n  farReadonlyNullable: unknown;\n}\n\nexport class Entry {\n  back!: Ledger;\n}\n",
    );
    assert.equal(ledger.typedFields, 3);
    assert.equal(ledger.unresolvedFields, 4);
    assert.equal(ledger.membersIncluded, 7);
    assert.doesNotMatch(ledger.source, /Batch/);
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
      buildScaffoldWithTypes(arrayWrapperPlantUmlDiagram, "plantuml", 30),
      buildScaffoldWithTypes(fallbackDiagram, "plantuml", 30),
      buildScaffoldWithTypes(ledgerDiagram, "plantuml", 2),
      buildScaffoldWithTypes(archiveDiagram, "plantuml", 1),
      buildScaffoldWithTypes(soloDiagram, "plantuml", 30),
      buildScaffoldWithTypes(builtInsDiagram, "plantuml", 30),
      buildScaffoldWithTypes(nullablePlantUmlDiagram, "plantuml", 30),
      buildScaffoldWithTypes(nullableMermaidDiagram, "mermaid", 30),
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

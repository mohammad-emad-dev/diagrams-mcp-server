// Golden sequence output for diagrams_generate_sequence. The tmp codebase is
// fixed, so these assertions lock the ordered messages array, the participant
// order, and the emitted source text; any drift in the shared call-graph or
// declaration stack shows up here as a changed golden, not a silent miss.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSequence } from "./sequence.js";
import type { SequenceMessage } from "./sequence.js";
import { validateDiagramSource } from "../diagramValidator.js";

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }
}

// The caller imports the callee, but the AST deliberately ignores import
// specifiers when collecting declarations, so "charge" resolves to payment.ts
// (its declarer), not back to checkout.ts as a self-message.
const CALLER =
  "import { charge } from './payment.js';\n\nexport function checkout() {\n  charge();\n}\n";
const CALLEE = "export function charge() {\n  return 1;\n}\n";

// The callback sits in a multiline arrow argument. The AST defers any call
// inside an inline function/arrow argument even when the wrapper and the
// call are on different lines; the wrapper itself stays deferred so
// scheduling is never sequenced as activity.
const SCHEDULER =
  "export function schedule() {\n  setTimeout(() => {\n    charge();\n  }, 10);\n}\n";

// A cross-file method call: Payment.pay is a class method, not a top-level
// function, so only the AST operation set knows this file declares "pay".
// The heuristic union (class names only) leaves it unresolved.
const METHOD_CALLER = "export function checkout() {\n  service.pay();\n}\n";
const METHOD_CALLEE = "export class Payment {\n  pay() {\n    return 1;\n  }\n  idle() {}\n}\n";

// An object-literal operation: the callee file exports an object whose
// identifier property holds an arrow function. Only the AST operation set
// knows this file declares "pay"; the heuristic union sees only "service".
// The definition itself holds no call, so it must not emit a message.
const OBJECT_CALLER = "export function checkout() {\n  service.pay();\n}\n";
const OBJECT_CALLEE = "export const service = {\n  pay: () => {\n    return 1;\n  },\n};\n";

// Same ownership through a quoted static bare-identifier property: "pay"
// holds an arrow function, so the AST still declares "pay".
const QUOTED_OBJECT_CALLEE =
  'export const service = {\n  "pay": () => {\n    return 1;\n  },\n};\n';

// Same ownership through a quoted static class property initializer: "pay"
// holds an arrow function, so the AST still declares "pay".
const QUOTED_CLASS_CALLEE = 'export class Service {\n  "pay" = () => {\n    return 1;\n  };\n}\n';

// A multiline callback object: charge() sits inside an inline arrow held by
// an object property passed as a call argument. Argument deferral keeps
// charge out of the messages even though the wrapper spans lines; the
// surrounding before()/after() direct calls stay sequenced.
const CALLBACK_OBJECT_CALLER =
  "export function checkout() {\n" +
  "  before();\n" +
  "  register({\n" +
  "    handler: () => {\n" +
  "      charge();\n" +
  "    },\n" +
  "  });\n" +
  "  after();\n" +
  "}\n";
const CALLBACK_OBJECT_CALLEE =
  "export function before() {\n  return 1;\n}\n" +
  "export function charge() {\n  return 2;\n}\n" +
  "export function after() {\n  return 3;\n}\n" +
  "export function register(input: unknown) {\n  return input;\n}\n";

describe("sequence goldens", () => {
  let tmpRoot: string;
  let callbackRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-goldens-"));
    callbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-callback-"));
    await writeFiles(tmpRoot, { "checkout.ts": CALLER, "payment.ts": CALLEE });
    await writeFiles(callbackRoot, { "scheduler.ts": SCHEDULER, "payment.ts": CALLEE });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(callbackRoot, { recursive: true, force: true });
  });

  it("sequences a caller-to-callee pair into an exact message and source", async () => {
    const result = await collectSequence(tmpRoot, { format: "puml" });

    assert.deepEqual(result.participants, ["checkout", "payment"]);
    assert.equal(result.participantsAvailable, 2);
    assert.equal(result.participantsDropped, 0);
    assert.deepEqual(result.messages, [
      { from: "checkout", to: "payment", message: "charge", line: 4, via_callback: false },
    ]);
    assert.equal(result.messagesAvailable, 1);
    assert.equal(result.messagesDropped, 0);
    assert.equal(result.deferredCount, 0);
    assert.deepEqual(result.unresolvedCallees, []);
    assert.equal(result.filesScanned, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.scanWarning, null);
    // Every emitted source must clear the gate diagrams_create enforces.
    validateDiagramSource(result.source, "plantuml");
    assert.equal(
      result.source,
      [
        "@startuml",
        "participant checkout",
        "participant payment",
        "checkout -> payment : charge",
        "@enduml",
        "",
      ].join("\n"),
    );
  });

  it("emits the same conversation as validated Mermaid", async () => {
    const result = await collectSequence(tmpRoot, { format: "mermaid" });

    assert.deepEqual(result.participants, ["checkout", "payment"]);
    assert.deepEqual(result.messages, [
      { from: "checkout", to: "payment", message: "charge", line: 4, via_callback: false },
    ]);
    validateDiagramSource(result.source, "mermaid");
    assert.equal(
      result.source,
      [
        "sequenceDiagram",
        "participant checkout",
        "participant payment",
        "checkout->>payment: charge",
        "",
      ].join("\n"),
    );
  });

  it("counts a callback-only call as deferred and sequences nothing", async () => {
    const result = await collectSequence(callbackRoot, { format: "puml" });

    assert.deepEqual(result.messages, []);
    assert.equal(result.messagesAvailable, 0);
    // The wrapper and the call inside its multiline arrow are both deferred;
    // nothing is sequenced, so no participant is declared.
    assert.equal(result.deferredCount, 2);
    assert.deepEqual(result.participants, []);
    assert.equal(result.participantsAvailable, 0);
    validateDiagramSource(result.source, "plantuml");
    assert.equal(result.source, "@startuml\n@enduml\n");
  });

  it("counts the same multiline callback as deferred in Mermaid", async () => {
    const result = await collectSequence(callbackRoot, { format: "mermaid" });

    assert.deepEqual(result.messages, []);
    assert.equal(result.deferredCount, 2);
    assert.deepEqual(result.participants, []);
    validateDiagramSource(result.source, "mermaid");
    assert.equal(result.source, "sequenceDiagram\n");
  });

  for (const format of ["puml", "mermaid"] as const) {
    it(`resolves a cross-file method call via AST operations (${format})`, async () => {
      const scope = path.join(tmpRoot, `method-${format}`);
      await writeFiles(scope, { "checkout.ts": METHOD_CALLER, "payment.ts": METHOD_CALLEE });
      const result = await collectSequence(scope, { format });

      assert.deepEqual(result.participants, ["checkout", "payment"]);
      assert.deepEqual(result.messages, [
        { from: "checkout", to: "payment", message: "pay", line: 2, via_callback: false },
      ]);
      assert.equal(result.deferredCount, 0);
      assert.deepEqual(result.unresolvedCallees, []);
      validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
    });
  }

  const objectCalleeCases: Array<{ name: string; slug: string; callee: string }> = [
    { name: "object-literal identifier property", slug: "identifier", callee: OBJECT_CALLEE },
    { name: "object-literal quoted property", slug: "quoted", callee: QUOTED_OBJECT_CALLEE },
    { name: "quoted class property initializer", slug: "class", callee: QUOTED_CLASS_CALLEE },
  ];

  for (const { name, slug, callee } of objectCalleeCases) {
    for (const format of ["puml", "mermaid"] as const) {
      it(`resolves ${name} via AST ownership (${format})`, async () => {
        const scope = path.join(tmpRoot, `object-${slug}-${format}`);
        await writeFiles(scope, { "checkout.ts": OBJECT_CALLER, "payment.ts": callee });
        const result = await collectSequence(scope, { format });

        assert.deepEqual(result.participants, ["checkout", "payment"]);
        assert.deepEqual(result.messages, [
          { from: "checkout", to: "payment", message: "pay", line: 2, via_callback: false },
        ]);
        // The definition holds no call, so only the caller emits; nothing
        // deferred and nothing unresolved.
        assert.equal(result.messagesAvailable, 1);
        assert.equal(result.messagesDropped, 0);
        assert.equal(result.deferredCount, 0);
        assert.deepEqual(result.unresolvedCallees, []);
        assert.equal(result.filesScanned, 2);
        validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
      });
    }
  }

  for (const format of ["puml", "mermaid"] as const) {
    it(`defers a multiline callback object while sequencing surrounding calls (${format})`, async () => {
      const scope = path.join(tmpRoot, `callback-object-${format}`);
      await writeFiles(scope, {
        "checkout.ts": CALLBACK_OBJECT_CALLER,
        "payment.ts": CALLBACK_OBJECT_CALLEE,
      });
      const result = await collectSequence(scope, { format });

      assert.deepEqual(result.participants, ["checkout", "payment"]);
      assert.deepEqual(result.messages, [
        { from: "checkout", to: "payment", message: "before", line: 2, via_callback: false },
        { from: "checkout", to: "payment", message: "register", line: 3, via_callback: false },
        { from: "checkout", to: "payment", message: "after", line: 8, via_callback: false },
      ]);
      // charge() sits inside an inline arrow held by an object property
      // passed as a call argument, so it is deferred, never sequenced.
      assert.ok(
        result.messages.every((message) => message.message !== "charge"),
        "callback object charge must not emit sequential activity",
      );
      assert.equal(result.deferredCount, 1);
      assert.deepEqual(result.unresolvedCallees, []);
      assert.equal(result.filesScanned, 2);
      validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
    });
  }

  it("leaves object-literal pay unresolved when the compiler is missing", async () => {
    const scope = path.join(tmpRoot, "object-fallback");
    await writeFiles(scope, { "checkout.ts": OBJECT_CALLER, "payment.ts": OBJECT_CALLEE });
    const result = await collectSequence(scope, {
      format: "puml",
      deps: { loadTsModule: async () => null },
    });

    // Without the compiler the heuristic union sees only "service", never
    // the property-held "pay", so the single service.pay() site is unresolved
    // and no participant is declared.
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.unresolvedCallees, ["pay"]);
    assert.deepEqual(result.participants, []);
    assert.equal(result.deferredCount, 0);
    assert.equal(result.filesScanned, 2);
  });

  it("falls back to the heuristic when the object-literal callee is unparseable", async () => {
    const scope = path.join(tmpRoot, "object-parse-error");
    await writeFiles(scope, {
      "checkout.ts": OBJECT_CALLER,
      "payment.ts": "export const service = {\n  pay: () => {\n    return 1;\n",
    });
    const result = await collectSequence(scope, { format: "puml" });

    // A parse failure keeps the heuristic fallback for that file: "service"
    // is declared, "pay" is not, so the call stays unresolved instead of
    // throwing or inventing a participant.
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.unresolvedCallees, ["pay"]);
    assert.deepEqual(result.participants, []);
    assert.equal(result.filesScanned, 2);
    validateDiagramSource(result.source, "plantuml");
  });

  it("leaves the method call unresolved when the compiler is missing", async () => {
    const scope = path.join(tmpRoot, "method-fallback");
    await writeFiles(scope, { "checkout.ts": METHOD_CALLER, "payment.ts": METHOD_CALLEE });
    const result = await collectSequence(scope, {
      format: "puml",
      deps: { loadTsModule: async () => null },
    });

    assert.deepEqual(result.messages, []);
    // Without the compiler the regex path mistakes the method definitions
    // themselves for call sites, so both names surface as unresolved; with
    // the AST only the real service.pay() site exists and it resolves.
    assert.deepEqual(result.unresolvedCallees, ["pay", "idle"]);
    assert.deepEqual(result.participants, []);
  });

  it("keeps function calls sequenced when the compiler is missing", async () => {
    const result = await collectSequence(tmpRoot, {
      format: "puml",
      deps: { loadTsModule: async () => null },
    });

    assert.deepEqual(result.participants, ["checkout", "payment"]);
    assert.deepEqual(result.messages, [
      { from: "checkout", to: "payment", message: "charge", line: 4, via_callback: false },
    ]);
  });

  const resolutionCases: Array<{
    name: string;
    files: Record<string, string>;
    participants: string[];
    messages: SequenceMessage[];
    unresolved: string[];
  }> = [
    {
      name: "an earlier folded declaration wins over a later exact-case declaration",
      files: {
        "a_first.ts": "export function CHARGE() {}\n",
        "b_second.ts": "export function charge() {}\n",
        "z_caller.ts": "export function checkout() {\n  charge();\n}\n",
      },
      participants: ["z_caller", "a_first"],
      messages: [
        { from: "z_caller", to: "a_first", message: "charge", line: 2, via_callback: false },
      ],
      unresolved: [],
    },
    {
      name: "same-basename files merge before competing operation declarations resolve",
      files: {
        "a/payment.ts": "export function CHARGE() {}\n",
        "b/other.ts": "export function late() {}\n",
        "c/payment.ts": "export function LATE() {}\n",
        "z/caller.ts": "export function checkout() {\n  charge();\n  late();\n}\n",
      },
      participants: ["caller", "payment"],
      messages: [
        { from: "caller", to: "payment", message: "charge", line: 2, via_callback: false },
        { from: "caller", to: "payment", message: "late", line: 3, via_callback: false },
      ],
      unresolved: [],
    },
    {
      name: "a top-level caller uses its file while unresolved callees stay excluded",
      files: {
        "a_payment.ts": "export function charge() {}\n",
        "z_entry.ts": "charge();\nabsent();\n",
      },
      participants: ["z_entry", "a_payment"],
      messages: [
        { from: "z_entry", to: "a_payment", message: "charge", line: 1, via_callback: false },
      ],
      unresolved: ["absent"],
    },
  ];

  for (const scenario of resolutionCases) {
    for (const format of ["puml", "mermaid"] as const) {
      it(`${scenario.name} (${format})`, async () => {
        const scope = path.join(tmpRoot, "resolution");
        await writeFiles(scope, scenario.files);
        const result = await collectSequence(scope, { format });

        assert.deepEqual(result.participants, scenario.participants);
        assert.deepEqual(result.messages, scenario.messages);
        assert.deepEqual(result.unresolvedCallees, scenario.unresolved);
        assert.equal(result.messagesAvailable, scenario.messages.length);
        assert.equal(result.messagesDropped, 0);
        assert.equal(result.filesScanned, Object.keys(scenario.files).length);
        const declarations = scenario.participants.map((name) => `participant ${name}`);
        const messages = scenario.messages.map(({ from, to, message }) =>
          format === "puml" ? `${from} -> ${to} : ${message}` : `${from}->>${to}: ${message}`,
        );
        assert.equal(
          result.source,
          (format === "puml"
            ? ["@startuml", ...declarations, ...messages, "@enduml", ""]
            : ["sequenceDiagram", ...declarations, ...messages, ""]
          ).join("\n"),
        );
      });
    }
  }
});

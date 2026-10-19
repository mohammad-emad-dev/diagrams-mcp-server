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
import type { SequenceCalleeEvidence, SequenceMessage } from "./sequence.js";
import { MAX_SEQUENCE_EVIDENCE_CANDIDATES } from "./sequence.js";
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

const CAP_EXCLUSION_FILES = {
  "a_charge.ts": "export function charge() {}\n",
  "b_charge.ts": "export function CHARGE() {}\n",
  "c_ping.ts": "export function ping() {}\n",
  "z_caller.ts":
    "export function checkout() {\n  ping();\n  charge();\n  setTimeout(() => { CHARGE(); }, 0);\n}\n",
};

/**
 * Build one expected evidence entry: the trailing fields are the same for
 * every entry, so only the interesting part lives in the scenario table.
 */
function evidenceEntry(
  callee: string,
  selected_participant: string,
  candidate_participants: string[],
  overrides?: { candidates_available?: number; candidates_capped?: boolean },
): SequenceCalleeEvidence {
  return {
    callee,
    selected_participant,
    candidate_participants,
    candidates_available: overrides?.candidates_available ?? candidate_participants.length,
    candidates_capped: overrides?.candidates_capped ?? false,
    candidate_limit: MAX_SEQUENCE_EVIDENCE_CANDIDATES,
    resolution_basis: "case-insensitive-declaration",
  };
}

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

  for (const format of ["puml", "mermaid"] as const) {
    it(`returns an empty ambiguity list for an empty scope (${format})`, async () => {
      const emptyScope = path.join(tmpRoot, "empty");
      await fs.mkdir(emptyScope);
      const result = await collectSequence(emptyScope, { format });

      assert.deepEqual(result.ambiguousCallees, []);
      assert.deepEqual(result.calleeEvidence, []);
      assert.deepEqual(result.participants, []);
      assert.deepEqual(result.messages, []);
      assert.equal(result.filesScanned, 0);
      assert.equal(result.tsAstAvailable, false);
      validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
    });
  }

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

  it("keeps a real self-call when the participant cap drops the external target", async () => {
    const scope = path.join(tmpRoot, "self-cap");
    await writeFiles(scope, {
      "a_first.ts": "export function checkout() {}\n",
      "payment.ts": "export function charge() {}\n",
      "z_second.ts":
        "export function checkout() {\n  charge();\n  helper();\n  absent();\n}\nexport function helper() {}\n",
    });
    for (const format of ["puml", "mermaid"] as const) {
      for (const deps of [undefined, { loadTsModule: async () => null }]) {
        const result = await collectSequence(scope, {
          format,
          deps,
          maxParticipants: 1,
          maxMessages: 1,
        });
        assert.deepEqual(result.participants, ["z_second"]);
        assert.deepEqual(result.messages, [
          { from: "z_second", to: "z_second", message: "helper", line: 3, via_callback: false },
        ]);
        assert.equal(result.participantsAvailable, 2);
        assert.equal(result.participantsDropped, 1);
        assert.equal(result.messagesAvailable, 2);
        assert.equal(result.messagesDropped, 1);
        assert.deepEqual(result.unresolvedCallees, ["absent"]);
        validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
      }
    }
  });

  const resolutionCases: Array<{
    name: string;
    files: Record<string, string>;
    participants: string[];
    messages: SequenceMessage[];
    unresolved: string[];
    ambiguous: string[];
    evidence: SequenceCalleeEvidence[];
    maxParticipants?: number;
    maxMessages?: number;
    messagesAvailable?: number;
    messagesDropped?: number;
    participantsAvailable?: number;
    participantsDropped?: number;
    deferredCount?: number;
  }> = [
    {
      name: "same-line recursive calls survive declaration filtering in source order",
      files: {
        "worker.ts":
          "export function retry() { retry(); other(); retry(); }\nexport function other() {}\n",
      },
      participants: ["worker"],
      messages: [
        { from: "worker", to: "worker", message: "retry", line: 1, via_callback: false },
        { from: "worker", to: "worker", message: "other", line: 1, via_callback: false },
        { from: "worker", to: "worker", message: "retry", line: 1, via_callback: false },
      ],
      unresolved: [],
      ambiguous: [],
      evidence: [
        evidenceEntry("retry", "worker", ["worker"]),
        evidenceEntry("other", "worker", ["worker"]),
      ],
      maxParticipants: 1,
    },
    {
      name: "an earlier folded declaration wins over a later exact-case declaration",
      files: {
        "a_first.ts": "export function CHARGE() {}\n",
        "b_second.ts": "export function charge() {}\n",
        "z_caller.ts": "export function checkout() {\n  charge();\n  CHARGE();\n  charge();\n}\n",
      },
      participants: ["z_caller", "a_first"],
      messages: [
        { from: "z_caller", to: "a_first", message: "charge", line: 2, via_callback: false },
        { from: "z_caller", to: "a_first", message: "CHARGE", line: 3, via_callback: false },
        { from: "z_caller", to: "a_first", message: "charge", line: 4, via_callback: false },
      ],
      unresolved: [],
      ambiguous: ["charge", "CHARGE"],
      // One entry per exact spelling; both fold to the same two declarers,
      // and b_second is a candidate although it never becomes a participant.
      evidence: [
        evidenceEntry("charge", "a_first", ["a_first", "b_second"], { candidates_available: 2 }),
        evidenceEntry("CHARGE", "a_first", ["a_first", "b_second"], { candidates_available: 2 }),
      ],
    },
    {
      name: "same-basename files merge before competing operation declarations resolve",
      files: {
        "a/payment.ts": "export function CHARGE() {}\n",
        "b/other.ts": "export function late() {}\n",
        "c/payment.ts": "export function LATE() {}\n",
        "e/payment.ts": "export function charge() {}\n",
        "z/caller.ts": "export function checkout() {\n  charge();\n  late();\n}\n",
      },
      participants: ["caller", "payment"],
      messages: [
        { from: "caller", to: "payment", message: "charge", line: 2, via_callback: false },
        { from: "caller", to: "payment", message: "late", line: 3, via_callback: false },
      ],
      unresolved: [],
      ambiguous: ["late"],
      // The three payment basenames merged into one candidate, so "charge"
      // has a single declarer while "late" has two, registry order first.
      evidence: [
        evidenceEntry("charge", "payment", ["payment"]),
        evidenceEntry("late", "payment", ["payment", "other"], { candidates_available: 2 }),
      ],
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
      ambiguous: [],
      // The unresolved "absent" call contributes no evidence entry.
      evidence: [evidenceEntry("charge", "a_payment", ["a_payment"])],
    },
    {
      // The sender ownership fix: checkout is declared in an earlier file,
      // and the later file's inner call to charge() must be sent by the
      // later file, not by the participant that first declared checkout.
      name: "a later duplicate caller sends from its own file",
      files: {
        "a_first.ts": "export function checkout() {}\n",
        "payment.ts": "export function charge() {}\n",
        "z_second.ts": "export function checkout() {\n  charge();\n}\n",
      },
      participants: ["z_second", "payment"],
      messages: [
        { from: "z_second", to: "payment", message: "charge", line: 2, via_callback: false },
      ],
      unresolved: [],
      ambiguous: [],
      evidence: [evidenceEntry("charge", "payment", ["payment"])],
    },
    {
      // Case-folded collision: CHECKOUT folds to checkout, so the earlier
      // exact-case declarer must not become the sender of the later call.
      name: "a same-fold caller name still sends from its own file",
      files: {
        "a_first.ts": "export function checkout() {}\n",
        "payment.ts": "export function charge() {}\n",
        "z_second.ts": "export function CHECKOUT() {\n  charge();\n}\n",
      },
      participants: ["z_second", "payment"],
      messages: [
        { from: "z_second", to: "payment", message: "charge", line: 2, via_callback: false },
      ],
      unresolved: [],
      ambiguous: [],
      evidence: [evidenceEntry("charge", "payment", ["payment"])],
    },
    {
      name: "participant-capped calls and deferred calls do not report ambiguity",
      files: CAP_EXCLUSION_FILES,
      participants: ["z_caller", "c_ping"],
      messages: [{ from: "z_caller", to: "c_ping", message: "ping", line: 2, via_callback: false }],
      unresolved: [],
      ambiguous: [],
      // The charge message died with the a_charge participant cap, and the
      // deferred CHARGE call was never a candidate: neither leaves evidence.
      evidence: [evidenceEntry("ping", "c_ping", ["c_ping"])],
      maxParticipants: 2,
      messagesAvailable: 2,
      messagesDropped: 1,
      participantsAvailable: 3,
      participantsDropped: 1,
      deferredCount: 2,
    },
    {
      name: "message-capped calls and deferred calls do not report ambiguity",
      files: CAP_EXCLUSION_FILES,
      participants: ["z_caller", "c_ping", "a_charge"],
      messages: [{ from: "z_caller", to: "c_ping", message: "ping", line: 2, via_callback: false }],
      unresolved: [],
      ambiguous: [],
      // The charge message died with the message cap; evidence stays bounded
      // to what was actually emitted.
      evidence: [evidenceEntry("ping", "c_ping", ["c_ping"])],
      maxMessages: 1,
      messagesAvailable: 2,
      messagesDropped: 1,
      participantsAvailable: 3,
      participantsDropped: 0,
      deferredCount: 2,
    },
    {
      name: "participant and message caps together leave evidence only for emitted messages",
      files: CAP_EXCLUSION_FILES,
      participants: ["z_caller", "c_ping"],
      messages: [{ from: "z_caller", to: "c_ping", message: "ping", line: 2, via_callback: false }],
      unresolved: [],
      ambiguous: [],
      // Both caps fired: a_charge lost its participant box and the message
      // cap would have cut the second message anyway. Only ping has evidence.
      evidence: [evidenceEntry("ping", "c_ping", ["c_ping"])],
      maxParticipants: 2,
      maxMessages: 1,
      messagesAvailable: 2,
      messagesDropped: 1,
      participantsAvailable: 3,
      participantsDropped: 1,
      deferredCount: 2,
    },
  ];

  for (const scenario of resolutionCases) {
    for (const format of ["puml", "mermaid"] as const) {
      for (const deps of [undefined, { loadTsModule: async () => null }]) {
        it(`${scenario.name} (${format} ${deps ? "fallback" : "compiler"})`, async () => {
          const scope = path.join(tmpRoot, "resolution");
          await writeFiles(scope, scenario.files);
          const result = await collectSequence(scope, {
            format,
            deps,
            maxParticipants: scenario.maxParticipants,
            maxMessages: scenario.maxMessages,
          });

          assert.deepEqual(result.participants, scenario.participants);
          assert.deepEqual(result.messages, scenario.messages);
          assert.deepEqual(result.unresolvedCallees, scenario.unresolved);
          assert.deepEqual(result.ambiguousCallees, scenario.ambiguous);
          assert.deepEqual(result.calleeEvidence, scenario.evidence);
          assert.equal(
            result.participantsAvailable,
            scenario.participantsAvailable ?? scenario.participants.length,
          );
          assert.equal(result.participantsDropped, scenario.participantsDropped ?? 0);
          assert.equal(
            result.messagesAvailable,
            scenario.messagesAvailable ?? scenario.messages.length,
          );
          assert.equal(result.messagesDropped, scenario.messagesDropped ?? 0);
          assert.equal(result.deferredCount, scenario.deferredCount ?? 0);
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
  }
});

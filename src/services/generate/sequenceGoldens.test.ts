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

// The only call sits inside an arrow function. extractCallEdges flags a call
// as deferred from its own line, so the arrow must be on the call's line for
// the deferral to register; the message is then counted, never sequenced.
const SCHEDULER =
  "export function schedule() {\n  const done = () => charge();\n  return done;\n}\n";

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
    assert.equal(result.deferredCount, 1);
    // Nothing was sequenced, so no participant is declared; the empty diagram
    // is still valid source a caller can hand to diagrams_create.
    assert.deepEqual(result.participants, []);
    assert.equal(result.participantsAvailable, 0);
    validateDiagramSource(result.source, "plantuml");
    assert.equal(result.source, "@startuml\n@enduml\n");
  });
});

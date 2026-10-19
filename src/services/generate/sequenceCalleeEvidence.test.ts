// Focused tests for the callee_evidence field on sequence results: how the
// first-declaring-participant choice is explained per emitted message
// spelling. Real files in temporary scopes, the same fixture pattern as the
// golden tests — internal helpers are never mocked, and the fallback seam is
// the public deps option.

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

/** Deps that report no compiler, exercising the regex union fallback. */
const NO_COMPILER = { loadTsModule: async () => null };

const CALLER = "export function checkout() {\n  charge();\n}\n";
const CALLEE = "export function charge() {\n  return 1;\n}\n";

describe("sequence callee evidence", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-evidence-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reports evidence for a single unambiguous callee in both dialects", async () => {
    for (const format of ["puml", "mermaid"] as const) {
      const scope = path.join(tmpRoot, `single-${format}`);
      await writeFiles(scope, { "checkout.ts": CALLER, "payment.ts": CALLEE });
      const result = await collectSequence(scope, { format });

      // One participant declaring the callee is still evidence: the entry
      // exists so a reader can see the choice was unambiguous.
      assert.deepEqual(result.calleeEvidence, [
        {
          callee: "charge",
          selected_participant: "payment",
          candidate_participants: ["payment"],
          candidates_available: 1,
          candidates_capped: false,
          candidate_limit: 20,
          resolution_basis: "case-insensitive-declaration",
        },
      ]);
      validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
    }
  });

  it("keeps evidence names logical while Mermaid sanitizes the emitted lists", async () => {
    const scope = path.join(tmpRoot, "logical-names");
    await writeFiles(scope, { "checkout.ts": CALLER, "my-payment.ts": CALLEE });

    for (const format of ["puml", "mermaid"] as const) {
      const result = await collectSequence(scope, { format });

      // The evidence always carries the logical basename the registry
      // resolved, in every dialect.
      assert.deepEqual(result.calleeEvidence, [
        {
          callee: "charge",
          selected_participant: "my-payment",
          candidate_participants: ["my-payment"],
          candidates_available: 1,
          candidates_capped: false,
          candidate_limit: 20,
          resolution_basis: "case-insensitive-declaration",
        },
      ]);
      if (format === "mermaid") {
        // The emitted lists carry the sanitized identifier instead; the
        // evidence deliberately does not, so it stays comparable across
        // dialects.
        assert.deepEqual(result.participants, ["checkout", "my_payment"]);
        assert.deepEqual(
          result.messages.map((message) => message.to),
          ["my_payment"],
        );
      } else {
        assert.deepEqual(result.participants, ["checkout", "my-payment"]);
      }
      validateDiagramSource(result.source, format === "puml" ? "plantuml" : "mermaid");
    }
  });

  it("truncates candidate lists at twenty and reports the exact count", async () => {
    const scope = path.join(tmpRoot, "truncated");
    const files: Record<string, string> = {};
    for (let index = 1; index <= 21; index += 1) {
      files[`d${String(index).padStart(2, "0")}_declarer.ts`] = "export function shared() {}\n";
    }
    files["z_caller.ts"] = "export function checkout() {\n  shared();\n}\n";
    await writeFiles(scope, files);

    for (const deps of [undefined, NO_COMPILER]) {
      const result = await collectSequence(scope, { format: "puml", deps });

      // The conversation has two parties, but every declarer in the scope
      // is a candidate: the candidate list is pre-cap registry evidence.
      assert.equal(result.participantsAvailable, 2);
      assert.deepEqual(result.participants, ["z_caller", "d01_declarer"]);
      assert.equal(result.calleeEvidence.length, 1);
      const [entry] = result.calleeEvidence;
      assert.equal(entry.callee, "shared");
      assert.equal(entry.selected_participant, "d01_declarer");
      assert.equal(entry.candidates_available, 21);
      assert.equal(entry.candidates_capped, true);
      assert.equal(entry.candidate_limit, 20);
      const expected = Array.from(
        { length: 20 },
        (_, index) => `d${String(index + 1).padStart(2, "0")}_declarer`,
      );
      assert.deepEqual(entry.candidate_participants, expected);
      assert.ok(!entry.candidate_participants.includes("d21_declarer"));
      validateDiagramSource(result.source, "plantuml");
    }
  });

  it("produces no entries for a scope with no emitted messages", async () => {
    const scope = path.join(tmpRoot, "empty");
    await fs.mkdir(scope);
    const result = await collectSequence(scope, { format: "puml" });

    assert.deepEqual(result.calleeEvidence, []);
  });
});

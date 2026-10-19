import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSequence } from "./sequence.js";

it("counts each merged declaration participant once despite case-colliding operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-evidence-collision-"));
  try {
    const files = {
      "a-first.ts": "export function charge() {}\n",
      "nested/payment.ts": "export function Charge() {}\nexport function charge() {}\n",
      "other/payment.ts": "export function CHARGE() {}\n",
      "z-caller.ts": "export function start() {\ncharge();\nCHARGE();\nCharge();\ncharge();\n}\n",
    };
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    for (const deps of [undefined, { loadTsModule: async () => null }]) {
      const result = await collectSequence(root, { maxMessages: 2, deps });
      assert.deepEqual(
        result.calleeEvidence.map((entry) => entry.callee),
        ["charge", "CHARGE"],
      );
      for (const evidence of result.calleeEvidence) {
        assert.deepEqual(evidence.candidate_participants, ["a-first", "payment"]);
        assert.equal(evidence.candidates_available, 2);
        assert.equal(evidence.selected_participant, "a-first");
      }
      const capped = await collectSequence(root, { maxParticipants: 1, deps });
      assert.deepEqual(capped.messages, []);
      assert.deepEqual(capped.calleeEvidence, []);
    }
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("sequence-evidence-collision-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

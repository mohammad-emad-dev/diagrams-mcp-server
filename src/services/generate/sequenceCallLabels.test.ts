import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSequence } from "./sequence.js";
import { extractMessageCalls, extractOrderedMessageCalls } from "../consistencyChecker/entities.js";

for (const format of ["puml", "mermaid"] as const) {
  describe(`generated call labels (${format})`, () => {
    let root: string;
    const deps = { loadTsModule: async () => null };
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-call-labels-"));
      await fs.writeFile(
        path.join(root, "checkout.js"),
        "export function checkout() {\n  charge();\n  charge();\n}\n",
      );
      await fs.writeFile(path.join(root, "payment.js"), "export function charge() {}\n");
    });
    afterEach(async () => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("sequence-call-labels-"));
      await fs.rm(root, { recursive: true, force: true });
    });

    it("makes repeated calls recognizable without changing default output or collected metadata", async () => {
      const baseline = await collectSequence(root, { format, deps });
      const disabled = await collectSequence(root, { format, deps, includeCallParentheses: false });
      assert.deepEqual(disabled, baseline);
      assert.deepEqual(extractMessageCalls(baseline.source), []);
      const enabled = await collectSequence(root, { format, deps, includeCallParentheses: true });
      const { source: defaultSource, ...defaultMetadata } = baseline;
      const { source: enabledSource, ...enabledMetadata } = enabled;
      assert.notEqual(enabledSource, defaultSource);
      assert.deepEqual(enabledMetadata, defaultMetadata);
      assert.deepEqual(
        enabled.messages.map((message) => message.message),
        ["charge", "charge"],
      );
      assert.deepEqual(extractMessageCalls(enabledSource), ["charge"]);
      assert.deepEqual(extractOrderedMessageCalls(enabledSource, 10), {
        calls: ["charge", "charge"],
        exceeded: false,
      });
    });

    it("applies message caps before formatting call labels", async () => {
      const bounded = await collectSequence(root, {
        format,
        deps,
        maxMessages: 1,
        includeCallParentheses: true,
      });
      assert.deepEqual(
        bounded.messages.map((message) => message.message),
        ["charge"],
      );
      assert.equal(bounded.messagesAvailable, 2);
      assert.equal(bounded.messagesDropped, 1);
      assert.deepEqual(extractOrderedMessageCalls(bounded.source, 10), {
        calls: ["charge"],
        exceeded: false,
      });
    });
  });
}

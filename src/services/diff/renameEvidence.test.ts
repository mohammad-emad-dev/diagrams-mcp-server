import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIFF_ORDER_CALLS } from "../../constants.js";
import { diffDiagrams } from "./diffDiagram.js";
import { CallOrderLimitError } from "./callOrder.js";

describe("rename message-call evidence", () => {
  it("counts repeated exact labels across dialects without changing rename pairing", () => {
    const a = {
      source:
        "@startuml\nclass process_order\nA -> B: process_order()\nA -> B: process_order(2)\n' A -> B: process_order()\n@enduml",
      type: "plantuml" as const,
    };
    const b = {
      source: "sequenceDiagram\nA->>B: ProcessOrder(3)\n%% A->>B: ProcessOrder()\n",
      type: "mermaid" as const,
    };
    const baseline = diffDiagrams(a, b);
    const enabled = diffDiagrams(a, b, { includeRenameEvidence: true });
    const { rename_evidence: evidence, ...unchanged } = enabled;
    assert.deepEqual(unchanged, baseline);
    assert.equal(Object.hasOwn(enabled, "call_order"), false);
    assert.deepEqual(evidence?.pairs, [
      {
        from: "process_order",
        to: "ProcessOrder",
        a_from_calls: 2,
        a_to_calls: 0,
        b_from_calls: 0,
        b_to_calls: 1,
        confidence: "heuristic",
      },
    ]);
    assert.equal(evidence?.basis, "diagram-message-call-labels");
    assert.equal(evidence?.pairs_capped, false);
  });

  it("bounds evidence pairs without dropping renames and reports zero call evidence", () => {
    const side = (separator: string) => ({
      source:
        "classDiagram\n" +
        Array.from({ length: 101 }, (_, i) => `class Item${separator}${i}\n`).join(""),
      type: "mermaid" as const,
    });
    const result = diffDiagrams(side("_"), side(""), { includeRenameEvidence: true });
    assert.equal(result.renamed.length, 101);
    assert.equal(result.rename_evidence?.pairs.length, 100);
    assert.equal(result.rename_evidence?.pairs_available, 101);
    assert.equal(result.rename_evidence?.pairs_capped, true);
    assert.equal(result.rename_evidence?.pairs[99].from, "Item_99");
    assert.equal(result.rename_evidence?.pairs[99].a_from_calls, 0);
    const empty = diffDiagrams(side("_"), side("_"), { includeRenameEvidence: true });
    assert.deepEqual(empty.rename_evidence?.pairs, []);
    assert.equal(empty.is_same, true);
  });

  for (const side of ["a", "b"] as const) {
    it(`refuses side ${side} above the call cap even when only evidence is requested`, () => {
      const empty = { source: "sequenceDiagram\n", type: "mermaid" as const };
      const full = {
        ...empty,
        source: empty.source + "A->>B: execute()\n".repeat(MAX_DIFF_ORDER_CALLS),
      };
      assert.doesNotThrow(() => diffDiagrams(full, empty, { includeRenameEvidence: true }));
      const oversized = { ...full, source: full.source + "A->>B: execute()\n" };
      assert.throws(
        () =>
          diffDiagrams(side === "a" ? oversized : empty, side === "b" ? oversized : empty, {
            includeRenameEvidence: true,
          }),
        (error: unknown) => error instanceof CallOrderLimitError && error.side === side,
      );
      assert.doesNotThrow(() => diffDiagrams(oversized, empty));
    });
  }
});

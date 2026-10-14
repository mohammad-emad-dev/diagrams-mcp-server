// Golden diff results for diagrams_diff. Each pair is fixed source text, so
// these assertions lock the exact added/removed/renamed arrays: a future
// regression in entity extraction or rename pairing shows up here as a
// changed golden, not as a silently wrong report.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIFF_ORDER_CALLS } from "../../constants.js";
import { diffDiagrams } from "./diffDiagram.js";
import type { DiffSide } from "./diffDiagram.js";
import { CallOrderLimitError } from "./callOrder.js";

// Renames only pair when the shared normalizer agrees on both names, so the
// golden pairs are chosen from forms the extractors really produce: a
// case-only rename (User -> USER) and a display-name-to-identifier rename
// ("Payment Gateway" -> PaymentGateway). "User" vs "Account" would NOT pair —
// similarity is not identity — and the negative case is covered in the tool
// unit tests.
const PLANTUML_CLASS_A =
  "@startuml\nclass User {\n  +id: int\n}\nclass Order {\n  +total: Money\n}\n@enduml\n";
const PLANTUML_CLASS_B =
  "@startuml\nclass USER {\n  +id: int\n}\nclass Order {\n  +total: Money\n}\nclass Invoice {\n  +total: Money\n}\n@enduml\n";

const PLANTUML_PARTICIPANT_RENAME_A =
  "@startuml\nparticipant " + '"Payment Gateway"' + "\nclass Order\n@enduml\n";
const PLANTUML_PARTICIPANT_RENAME_B =
  "@startuml\nparticipant PaymentGateway\nclass Order\n@enduml\n";

const MERMAID_CLASS_A = "classDiagram\nclass User\nclass Order\n";
const MERMAID_CLASS_B = "classDiagram\nclass Order\nclass Cart\n";

const PLANTUML_SEQUENCE_A =
  "@startuml\nparticipant Customer\nparticipant OrderService\nCustomer -> OrderService: place(order)\n@enduml\n";
const PLANTUML_SEQUENCE_B =
  "@startuml\nparticipant Customer\nparticipant PaymentGateway\nCustomer -> PaymentGateway: charge(card)\nOrderService -> PaymentGateway: refund(id)\n@enduml\n";

// Only "place" is a message call on side a, so it is shared, not added.
const MERMAID_SEQUENCE_A =
  "sequenceDiagram\nparticipant Customer\nCustomer->>OrderService: place(order)\n";
const MERMAID_SEQUENCE_B =
  "sequenceDiagram\nparticipant Customer\nparticipant OrderService\nCustomer->>OrderService: place(order)\nCustomer->>OrderService: cancel(order)\n";

// Reordering only: same declarations, different order. No renames, is_same.
const PLANTUML_REORDER_A = "@startuml\nclass Widget\nclass Gadget\nclass Doohickey\n@enduml\n";
const PLANTUML_REORDER_B = "@startuml\nclass Doohickey\nclass Widget\nclass Gadget\n@enduml\n";

// Same recognized call set in a different order: the entity-set diff stays
// empty, only the optional call-order comparison sees the change.
const PLANTUML_ORDER_A =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: place(order)\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "@enduml\n";
const PLANTUML_ORDER_B =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "Customer -> OrderService: place(order)\n" +
  "@enduml\n";
const MERMAID_ORDER_A =
  "sequenceDiagram\nparticipant Customer\nparticipant OrderService\n" +
  "Customer->>OrderService: place(order)\n" +
  "Customer->>OrderService: cancel(order)\n";
const PLANTUML_REPEAT_A =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: place(order)\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "Customer -> OrderService: place(order)\n" +
  "@enduml\n";
const PLANTUML_REPEAT_B =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: place(order)\n" +
  "Customer -> OrderService: place(order)\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "@enduml\n";

/** Large sequence source with exactly `count` recognized `aa` calls. */
function repeatOrderSource(count: number): string {
  const lines = new Array<string>(count).fill("A -> B: aa(x)");
  return `@startuml\nparticipant A\nparticipant B\n${lines.join("\n")}\n@enduml\n`;
}

describe("diff goldens", () => {
  for (const scenario of [
    {
      name: "pairs colliding names in order and preserves surplus removed names",
      previous: ["User_Account", "User__Account", "User___Account", "Keep"],
      next: ["userAccount", "user_account", "Keep"],
      renamed: [
        { from: "User_Account", to: "userAccount", confidence: "heuristic" },
        { from: "User__Account", to: "user_account", confidence: "heuristic" },
      ],
      added: [],
      removed: [{ name: "User___Account" }],
    },
    {
      name: "consumes each colliding candidate once and preserves surplus added names",
      previous: ["User__Account", "User_Account", "Keep"],
      next: ["user_account", "userAccount", "user__account", "Keep"],
      renamed: [
        { from: "User__Account", to: "user_account", confidence: "heuristic" },
        { from: "User_Account", to: "userAccount", confidence: "heuristic" },
      ],
      added: [{ name: "user__account" }],
      removed: [],
    },
    {
      name: "never pairs separator-only names while pairing a valid normalized key",
      previous: ["_", "__", "Alpha"],
      next: ["___", "____", "ALPHA"],
      renamed: [{ from: "Alpha", to: "ALPHA", confidence: "heuristic" }],
      added: [{ name: "___" }, { name: "____" }],
      removed: [{ name: "_" }, { name: "__" }],
    },
  ]) {
    it(scenario.name, () => {
      const diagram = (names: string[]): DiffSide => ({
        source: `@startuml\n${names.map((name) => `class ${name}`).join("\n")}\n@enduml`,
        type: "plantuml",
      });
      const compared = diffDiagrams(diagram(scenario.previous), diagram(scenario.next));
      assert.deepEqual(compared.renamed, scenario.renamed);
      assert.deepEqual(compared.added, scenario.added);
      assert.deepEqual(compared.removed, scenario.removed);
    });
  }

  it("diffs a PlantUML class pair into exact added/removed/renamed arrays", () => {
    const result = diffDiagrams(
      { source: PLANTUML_CLASS_A, type: "plantuml" },
      { source: PLANTUML_CLASS_B, type: "plantuml" },
    );

    assert.deepEqual(result.added, [{ name: "Invoice" }]);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.renamed, [{ from: "User", to: "USER", confidence: "heuristic" }]);
    assert.deepEqual(result.unchanged, ["Order"]);
    assert.equal(result.unchanged_count, 1);
    assert.equal(result.is_same, false);
    // A class diagram reports no sequence fields, and they are never null.
    assert.deepEqual(result.participants_added, []);
    assert.deepEqual(result.participants_removed, []);
    assert.deepEqual(result.calls_added, []);
    assert.deepEqual(result.calls_removed, []);
  });

  it("pairs a display name with its identifier form as a rename", () => {
    const result = diffDiagrams(
      { source: PLANTUML_PARTICIPANT_RENAME_A, type: "plantuml" },
      { source: PLANTUML_PARTICIPANT_RENAME_B, type: "plantuml" },
    );

    assert.deepEqual(result.renamed, [
      { from: "Payment Gateway", to: "PaymentGateway", confidence: "heuristic" },
    ]);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.unchanged, ["Order"]);
    // The sequence-side fields are raw set differences: the same swap shows
    // up here too, because pairing applies to the entity lists only.
    assert.deepEqual(result.participants_added, ["PaymentGateway"]);
    assert.deepEqual(result.participants_removed, ["Payment Gateway"]);
    assert.equal(result.is_same, false);
  });

  it("diffs a Mermaid class pair into exact added/removed arrays", () => {
    const result = diffDiagrams(
      { source: MERMAID_CLASS_A, type: "mermaid" },
      { source: MERMAID_CLASS_B, type: "mermaid" },
    );

    assert.deepEqual(result.added, [{ name: "Cart" }]);
    assert.deepEqual(result.removed, [{ name: "User" }]);
    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.unchanged, ["Order"]);
    assert.equal(result.unchanged_count, 1);
    assert.equal(result.is_same, false);
    assert.deepEqual(result.participants_added, []);
    assert.deepEqual(result.calls_added, []);
  });

  it("diffs a PlantUML sequence pair into participants and calls", () => {
    const result = diffDiagrams(
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
      { source: PLANTUML_SEQUENCE_B, type: "plantuml" },
    );

    assert.deepEqual(result.participants_added, ["PaymentGateway"]);
    assert.deepEqual(result.participants_removed, ["OrderService"]);
    assert.deepEqual(result.calls_added, ["charge", "refund"]);
    assert.deepEqual(result.calls_removed, ["place"]);
    assert.equal(result.is_same, false);
  });

  it("diffs a Mermaid sequence pair into participants and calls", () => {
    const result = diffDiagrams(
      { source: MERMAID_SEQUENCE_A, type: "mermaid" },
      { source: MERMAID_SEQUENCE_B, type: "mermaid" },
    );

    assert.deepEqual(result.participants_added, ["OrderService"]);
    assert.deepEqual(result.participants_removed, []);
    assert.deepEqual(result.calls_added, ["cancel"]);
    assert.deepEqual(result.calls_removed, []);
    assert.equal(result.is_same, false);
  });

  it("reports zero renames and is_same for a pure reordering", () => {
    const result = diffDiagrams(
      { source: PLANTUML_REORDER_A, type: "plantuml" },
      { source: PLANTUML_REORDER_B, type: "plantuml" },
    );

    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.unchanged, ["Widget", "Gadget", "Doohickey"]);
    assert.equal(result.unchanged_count, 3);
    assert.equal(result.is_same, true);
  });

  it("swaps added and removed when the two sides are exchanged", () => {
    const a: DiffSide = { source: PLANTUML_CLASS_A, type: "plantuml" };
    const b: DiffSide = { source: PLANTUML_CLASS_B, type: "plantuml" };

    const forward = diffDiagrams(a, b);
    const backward = diffDiagrams(b, a);

    assert.deepEqual(backward.added, forward.removed);
    assert.deepEqual(backward.removed, forward.added);
    assert.deepEqual(
      backward.renamed.map((entry) => ({ from: entry.to, to: entry.from })),
      forward.renamed.map((entry) => ({ from: entry.from, to: entry.to })),
    );
    assert.deepEqual(backward.unchanged, forward.unchanged);
    assert.equal(backward.is_same, forward.is_same);
  });

  it("reports identical sources as is_same with empty sequence fields", () => {
    const result = diffDiagrams(
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
    );

    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.participants_added, []);
    assert.deepEqual(result.participants_removed, []);
    assert.deepEqual(result.calls_added, []);
    assert.deepEqual(result.calls_removed, []);
    assert.equal(result.is_same, true);
  });

  it("omits call_order by default even for sequence pairs", () => {
    const identical = diffDiagrams(
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
    );
    assert.equal("call_order" in identical, false);

    const reordered = diffDiagrams(
      { source: PLANTUML_ORDER_A, type: "plantuml" },
      { source: PLANTUML_ORDER_B, type: "plantuml" },
    );
    assert.equal("call_order" in reordered, false);
    // Without the option a pure call reorder looks identical: same sets.
    assert.deepEqual(reordered.added, []);
    assert.deepEqual(reordered.removed, []);
    assert.deepEqual(reordered.renamed, []);
    assert.deepEqual(reordered.calls_added, []);
    assert.deepEqual(reordered.calls_removed, []);
    assert.equal(reordered.is_same, true);
  });

  it("reports a reordered call set as changed and not same", () => {
    const result = diffDiagrams(
      { source: PLANTUML_ORDER_A, type: "plantuml" },
      { source: PLANTUML_ORDER_B, type: "plantuml" },
      { compareCallOrder: true },
    );

    assert.deepEqual(result.call_order, {
      a: ["place", "cancel"],
      b: ["cancel", "place"],
      changed: true,
    });
    assert.equal(result.is_same, false);
    // The entity-set diffs are untouched: same sets, only the order moved.
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.calls_added, []);
    assert.deepEqual(result.calls_removed, []);
  });

  it("keeps is_same true when the call order matches", () => {
    const result = diffDiagrams(
      { source: PLANTUML_ORDER_A, type: "plantuml" },
      { source: PLANTUML_ORDER_A, type: "plantuml" },
      { compareCallOrder: true },
    );

    assert.deepEqual(result.call_order, {
      a: ["place", "cancel"],
      b: ["place", "cancel"],
      changed: false,
    });
    assert.equal(result.is_same, true);
  });

  it("matches the same call order across PlantUML and Mermaid", () => {
    const result = diffDiagrams(
      { source: PLANTUML_ORDER_A, type: "plantuml" },
      { source: MERMAID_ORDER_A, type: "mermaid" },
      { compareCallOrder: true },
    );

    assert.deepEqual(result.call_order?.a, ["place", "cancel"]);
    assert.deepEqual(result.call_order?.b, ["place", "cancel"]);
    assert.equal(result.call_order?.changed, false);
    assert.equal(result.is_same, true);
  });

  it("counts call repetitions positionally in the diff order", () => {
    const result = diffDiagrams(
      { source: PLANTUML_REPEAT_A, type: "plantuml" },
      { source: PLANTUML_REPEAT_B, type: "plantuml" },
      { compareCallOrder: true },
    );

    assert.deepEqual(result.call_order?.a, ["place", "cancel", "place"]);
    assert.deepEqual(result.call_order?.b, ["place", "place", "cancel"]);
    assert.equal(result.call_order?.changed, true);
    assert.equal(result.is_same, false);
    assert.deepEqual(result.calls_added, []);
    assert.deepEqual(result.calls_removed, []);
  });

  it("ignores argument differences in the diff call order", () => {
    const argued =
      "@startuml\nparticipant Customer\nparticipant OrderService\n" +
      "Customer -> OrderService: place(cart)\n" +
      "Customer -> OrderService: cancel(other)\n" +
      "@enduml\n";
    const result = diffDiagrams(
      { source: PLANTUML_ORDER_A, type: "plantuml" },
      { source: argued, type: "plantuml" },
      { compareCallOrder: true },
    );

    assert.deepEqual(result.call_order?.a, ["place", "cancel"]);
    assert.deepEqual(result.call_order?.b, ["place", "cancel"]);
    assert.equal(result.call_order?.changed, false);
    assert.equal(result.is_same, true);
  });

  it("keeps entity-set diffs unchanged when call order is enabled", () => {
    const without = diffDiagrams(
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
      { source: PLANTUML_SEQUENCE_B, type: "plantuml" },
    );
    const withOrder = diffDiagrams(
      { source: PLANTUML_SEQUENCE_A, type: "plantuml" },
      { source: PLANTUML_SEQUENCE_B, type: "plantuml" },
      { compareCallOrder: true },
    );

    assert.deepEqual(withOrder.added, without.added);
    assert.deepEqual(withOrder.removed, without.removed);
    assert.deepEqual(withOrder.renamed, without.renamed);
    assert.deepEqual(withOrder.call_order, {
      a: ["place"],
      b: ["charge", "refund"],
      changed: true,
    });
    assert.equal(withOrder.is_same, false);
  });

  it("accepts exactly the cap in the diff call order", () => {
    const source = repeatOrderSource(MAX_DIFF_ORDER_CALLS);
    const result = diffDiagrams(
      { source, type: "plantuml" },
      { source, type: "plantuml" },
      { compareCallOrder: true },
    );
    assert.equal(result.call_order?.changed, false);
    assert.equal(result.call_order?.a.length, MAX_DIFF_ORDER_CALLS);
    assert.equal(result.is_same, true);
  });

  it("rejects cap plus one in the diff call order naming the side", () => {
    const over = repeatOrderSource(MAX_DIFF_ORDER_CALLS + 1);
    const small = "@startuml\nparticipant A\nparticipant B\nA -> B: aa(x)\n@enduml\n";

    assert.throws(
      () =>
        diffDiagrams(
          { source: over, type: "plantuml" },
          { source: small, type: "plantuml" },
          {
            compareCallOrder: true,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CallOrderLimitError);
        assert.equal(err.side, "a");
        assert.equal(
          err.message,
          `Call order on side 'a' exceeds the limit of ${MAX_DIFF_ORDER_CALLS} calls.`,
        );
        return true;
      },
    );
    assert.throws(
      () =>
        diffDiagrams(
          { source: small, type: "plantuml" },
          { source: over, type: "plantuml" },
          {
            compareCallOrder: true,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CallOrderLimitError);
        assert.equal(err.side, "b");
        assert.equal(
          err.message,
          `Call order on side 'b' exceeds the limit of ${MAX_DIFF_ORDER_CALLS} calls.`,
        );
        return true;
      },
    );
  });
});

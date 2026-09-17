// Golden diff results for diagrams_diff. Each pair is fixed source text, so
// these assertions lock the exact added/removed/renamed arrays: a future
// regression in entity extraction or rename pairing shows up here as a
// changed golden, not as a silently wrong report.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffDiagrams } from "./diffDiagram.js";
import type { DiffSide } from "./diffDiagram.js";

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

describe("diff goldens", () => {
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
});

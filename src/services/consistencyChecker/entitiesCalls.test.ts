// Single-character message-call grammar. Locks the shared extractor to
// recognize valid one-letter operations (`f()`, `g()`, `_()`) in both
// dialects while preserving identifier start rules, paren requirement,
// plain-label exclusion, deduplication versus ordered repetition, and
// extraction bounds.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEntities,
  extractMermaidParticipants,
  extractMessageCalls,
  extractOrderedMessageCalls,
  extractPlantUmlParticipants,
} from "./entities.js";

const PLANTUML_SINGLE =
  "@startuml\nparticipant A\nparticipant B\nA -> B: f(x)\nA -> B: g(y)\nA -> B: _(z)\n@enduml\n";

const MERMAID_SINGLE =
  "sequenceDiagram\nparticipant A\nparticipant B\nA->>B: f(x)\nA->>B: g(y)\nA->>B: _(z)\n";

describe("single-character message calls", () => {
  it("recognizes one-letter and lone-underscore operations in PlantUML", () => {
    assert.deepEqual([...extractMessageCalls(PLANTUML_SINGLE)].sort(), ["_", "f", "g"]);
    const ordered = extractOrderedMessageCalls(PLANTUML_SINGLE, 10);
    assert.deepEqual(ordered.calls, ["f", "g", "_"]);
    assert.equal(ordered.exceeded, false);
  });

  it("recognizes one-letter and lone-underscore operations in Mermaid", () => {
    assert.deepEqual([...extractMessageCalls(MERMAID_SINGLE)].sort(), ["_", "f", "g"]);
    const ordered = extractOrderedMessageCalls(MERMAID_SINGLE, 10);
    assert.deepEqual(ordered.calls, ["f", "g", "_"]);
    assert.equal(ordered.exceeded, false);
  });

  it("mixes long and short names in extraction order", () => {
    const plantUml =
      "@startuml\nA -> B: charge(card)\nA -> B: f(x)\nA -> B: cancel(id)\nA -> B: g(y)\n@enduml\n";
    const ordered = extractOrderedMessageCalls(plantUml, 10);
    assert.deepEqual(ordered.calls, ["charge", "f", "cancel", "g"]);
    assert.equal(ordered.exceeded, false);
    assert.deepEqual([...extractMessageCalls(plantUml)].sort(), ["cancel", "charge", "f", "g"]);

    const mermaid =
      "sequenceDiagram\nA->>B: charge(card)\nA->>B: f(x)\nA->>B: cancel(id)\nA->>B: g(y)\n";
    const mermaidOrdered = extractOrderedMessageCalls(mermaid, 10);
    assert.deepEqual(mermaidOrdered.calls, ["charge", "f", "cancel", "g"]);
    assert.equal(mermaidOrdered.exceeded, false);
  });

  it("dedupes repeated names while the ordered extractor keeps repetitions", () => {
    const plantUml = "@startuml\nA -> B: f(x)\nA -> B: g(y)\nA -> B: f(z)\n@enduml\n";
    assert.deepEqual([...extractMessageCalls(plantUml)].sort(), ["f", "g"]);
    const ordered = extractOrderedMessageCalls(plantUml, 10);
    assert.deepEqual(ordered.calls, ["f", "g", "f"]);
    assert.equal(ordered.exceeded, false);

    const mermaid = "sequenceDiagram\nA->>B: f(x)\nA->>B: g(y)\nA->>B: f(z)\n";
    assert.deepEqual([...extractMessageCalls(mermaid)].sort(), ["f", "g"]);
    const mermaidOrdered = extractOrderedMessageCalls(mermaid, 10);
    assert.deepEqual(mermaidOrdered.calls, ["f", "g", "f"]);
    assert.equal(mermaidOrdered.exceeded, false);
  });

  it("keeps class and participant extraction alongside one-letter calls", () => {
    const plantUml =
      "@startuml\nclass Order\nparticipant Customer\nparticipant OrderService\n" +
      "Customer -> OrderService: f(order)\n@enduml\n";
    const entities = extractEntities(plantUml, "plantuml");
    assert.ok(entities.includes("Order"));
    assert.ok(entities.includes("Customer"));
    assert.ok(entities.includes("OrderService"));
    assert.ok(entities.includes("f"));
    assert.deepEqual(extractPlantUmlParticipants(plantUml).sort(), ["Customer", "OrderService"]);

    const mermaid =
      "sequenceDiagram\nparticipant Customer\nparticipant OrderService\nCustomer->>OrderService: f(order)\n";
    const mermaidEntities = extractEntities(mermaid, "mermaid");
    assert.ok(mermaidEntities.includes("Customer"));
    assert.ok(mermaidEntities.includes("OrderService"));
    assert.ok(mermaidEntities.includes("f"));
    assert.deepEqual(extractMermaidParticipants(mermaid).sort(), ["Customer", "OrderService"]);

    const mermaidClass = "classDiagram\nclass Order\n";
    assert.ok(extractEntities(mermaidClass, "mermaid").includes("Order"));
  });

  it("ignores numeric-start names, missing parens, and plain labels", () => {
    const plantUml =
      "@startuml\nA -> B: hello world\nA -> B: f\nA -> B: 1bad(x)\nA -> B: 9(x)\n" +
      "A -> B: charge(card)\n@enduml\n";
    assert.deepEqual(extractMessageCalls(plantUml), ["charge"]);
    const ordered = extractOrderedMessageCalls(plantUml, 10);
    assert.deepEqual(ordered.calls, ["charge"]);
    assert.equal(ordered.exceeded, false);

    const mermaid = "sequenceDiagram\nA->>B: hello world\nA->>B: f\nA->>B: 1bad(x)\nA->>B: g(x)\n";
    assert.deepEqual(extractMessageCalls(mermaid), ["g"]);
    const mermaidOrdered = extractOrderedMessageCalls(mermaid, 10);
    assert.deepEqual(mermaidOrdered.calls, ["g"]);
    assert.equal(mermaidOrdered.exceeded, false);
  });

  it("allows digits only after a valid start while keeping start rules", () => {
    const source = "@startuml\nA -> B: f1(x)\nA -> B: _a2(y)\nA -> B: F(z)\n@enduml\n";
    assert.deepEqual([...extractMessageCalls(source)].sort(), ["F", "_a2", "f1"]);
    const ordered = extractOrderedMessageCalls(source, 10);
    assert.deepEqual(ordered.calls, ["f1", "_a2", "F"]);
    assert.equal(ordered.exceeded, false);
  });

  it("bounds single-character calls without building a full match array", () => {
    const source = "@startuml\nA -> B: f(x)\nA -> B: g(y)\nA -> B: f(z)\n@enduml\n";
    const bounded = extractOrderedMessageCalls(source, 2);
    assert.deepEqual(bounded.calls, ["f", "g"]);
    assert.equal(bounded.exceeded, true);
  });

  it("leaves no regex state across repeated parser invocations", () => {
    const first = extractOrderedMessageCalls(PLANTUML_SINGLE, 10);
    const names = extractMessageCalls(PLANTUML_SINGLE);
    const second = extractOrderedMessageCalls(PLANTUML_SINGLE, 10);
    assert.deepEqual(first, second);
    assert.deepEqual([...names].sort(), ["_", "f", "g"]);

    const mermaidFirst = extractOrderedMessageCalls(MERMAID_SINGLE, 10);
    const mermaidSecond = extractOrderedMessageCalls(MERMAID_SINGLE, 10);
    assert.deepEqual(mermaidFirst, mermaidSecond);
  });
});

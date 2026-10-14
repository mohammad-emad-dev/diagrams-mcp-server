// Bounded recognized-message-call order comparison. Locks the ordered
// extractor (order plus repetitions through the shared grammar) and the
// positional comparator: reordered sets flag changed, repetitions count,
// cross-dialect order matches, and over-cap input rejects with a typed error
// naming the side and the ceiling.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIFF_ORDER_CALLS } from "../../constants.js";
import { extractMessageCalls, extractOrderedMessageCalls } from "../consistencyChecker/entities.js";
import { CallOrderLimitError, compareCallOrder } from "./callOrder.js";

const PLANTUML_ORDERED =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: place(order)\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "@enduml\n";

const PLANTUML_REORDERED =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "Customer -> OrderService: place(order)\n" +
  "@enduml\n";

const PLANTUML_REPEATED =
  "@startuml\nparticipant Customer\nparticipant OrderService\n" +
  "Customer -> OrderService: place(order)\n" +
  "Customer -> OrderService: cancel(order)\n" +
  "Customer -> OrderService: place(order)\n" +
  "@enduml\n";

const MERMAID_ORDERED =
  "sequenceDiagram\nparticipant Customer\nparticipant OrderService\n" +
  "Customer->>OrderService: place(order)\n" +
  "Customer->>OrderService: cancel(order)\n";

function repeatCallSource(count: number): string {
  const lines = new Array<string>(count).fill("A -> B: aa(x)");
  return `@startuml\nparticipant A\nparticipant B\n${lines.join("\n")}\n@enduml\n`;
}

/** Run a comparison expected to throw and return its message. */
function captureLimitMessage(sourceA: string, sourceB: string): string {
  try {
    compareCallOrder(sourceA, sourceB);
  } catch (err: unknown) {
    assert.ok(err instanceof CallOrderLimitError);
    return err.message;
  }
  assert.fail("expected CallOrderLimitError");
}

describe("call order", () => {
  it("retains extraction order with repetitions through the shared grammar", () => {
    const { calls, exceeded } = extractOrderedMessageCalls(PLANTUML_REPEATED, MAX_DIFF_ORDER_CALLS);
    assert.deepEqual(calls, ["place", "cancel", "place"]);
    assert.equal(exceeded, false);
  });

  it("ignores plain labels and single-character names like the shared grammar", () => {
    const source = "@startuml\nA -> B: hello world\nA -> B: a(x)\nA -> B: charge(card)\n@enduml\n";
    const { calls, exceeded } = extractOrderedMessageCalls(source, MAX_DIFF_ORDER_CALLS);
    assert.deepEqual(calls, ["charge"]);
    assert.equal(exceeded, false);
    assert.deepEqual(extractMessageCalls(source), ["charge"]);
  });

  it("does not represent argument differences in the ordered names", () => {
    const first = extractOrderedMessageCalls(
      "@startuml\nA -> B: place(order)\nA -> B: cancel(id)\n@enduml\n",
      MAX_DIFF_ORDER_CALLS,
    );
    const second = extractOrderedMessageCalls(
      "@startuml\nA -> B: place(cart)\nA -> B: cancel(other)\n@enduml\n",
      MAX_DIFF_ORDER_CALLS,
    );
    assert.deepEqual(first.calls, ["place", "cancel"]);
    assert.deepEqual(second.calls, ["place", "cancel"]);
    const compared = compareCallOrder(
      "@startuml\nA -> B: place(order)\n@enduml\n",
      "@startuml\nA -> B: place(cart)\n@enduml\n",
    );
    assert.equal(compared.changed, false);
    assert.deepEqual(compared.a, ["place"]);
    assert.deepEqual(compared.b, ["place"]);
  });

  it("flags a reordered set as changed with both orders", () => {
    const compared = compareCallOrder(PLANTUML_ORDERED, PLANTUML_REORDERED);
    assert.deepEqual(compared.a, ["place", "cancel"]);
    assert.deepEqual(compared.b, ["cancel", "place"]);
    assert.equal(compared.changed, true);
  });

  it("counts repetitions positionally instead of as sets", () => {
    const repeated = compareCallOrder(PLANTUML_ORDERED, PLANTUML_REPEATED);
    assert.equal(repeated.changed, true);

    const swappedRepeat = compareCallOrder(
      "@startuml\nA -> B: place(x)\nA -> B: cancel(x)\nA -> B: place(x)\n@enduml\n",
      "@startuml\nA -> B: place(x)\nA -> B: place(x)\nA -> B: cancel(x)\n@enduml\n",
    );
    assert.deepEqual(swappedRepeat.a, ["place", "cancel", "place"]);
    assert.deepEqual(swappedRepeat.b, ["place", "place", "cancel"]);
    assert.equal(swappedRepeat.changed, true);
  });

  it("matches the same order across PlantUML and Mermaid", () => {
    const compared = compareCallOrder(PLANTUML_ORDERED, MERMAID_ORDERED);
    assert.deepEqual(compared.a, ["place", "cancel"]);
    assert.deepEqual(compared.b, ["place", "cancel"]);
    assert.equal(compared.changed, false);
  });

  it("stops early past a small limit without building a full match array", () => {
    const { calls, exceeded } = extractOrderedMessageCalls(PLANTUML_REPEATED, 2);
    assert.deepEqual(calls, ["place", "cancel"]);
    assert.equal(exceeded, true);
  });

  it("accepts exactly the cap without error", () => {
    const source = repeatCallSource(MAX_DIFF_ORDER_CALLS);
    const { calls, exceeded } = extractOrderedMessageCalls(source, MAX_DIFF_ORDER_CALLS);
    assert.equal(exceeded, false);
    assert.equal(calls.length, MAX_DIFF_ORDER_CALLS);
    const compared = compareCallOrder(source, source);
    assert.equal(compared.changed, false);
    assert.equal(compared.a.length, MAX_DIFF_ORDER_CALLS);
  });

  it("rejects cap plus one on side a with a deterministic typed error", () => {
    const over = repeatCallSource(MAX_DIFF_ORDER_CALLS + 1);
    const small = "@startuml\nA -> B: aa(x)\n@enduml\n";

    const extracted = extractOrderedMessageCalls(over, MAX_DIFF_ORDER_CALLS);
    assert.equal(extracted.exceeded, true);
    assert.equal(extracted.calls.length, MAX_DIFF_ORDER_CALLS);

    assert.throws(
      () => compareCallOrder(over, small),
      (err: unknown) => {
        assert.ok(err instanceof CallOrderLimitError);
        assert.equal(err.side, "a");
        assert.equal(err.limit, MAX_DIFF_ORDER_CALLS);
        assert.equal(
          err.message,
          `Call order on side 'a' exceeds the limit of ${MAX_DIFF_ORDER_CALLS} calls.`,
        );
        assert.ok(!err.message.includes("A -> B"));
        return true;
      },
    );

    const first = captureLimitMessage(over, small);
    const second = captureLimitMessage(over, small);
    assert.equal(first, second);
  });

  it("rejects cap plus one on side b with a deterministic typed error", () => {
    const small = "@startuml\nA -> B: aa(x)\n@enduml\n";
    const over = repeatCallSource(MAX_DIFF_ORDER_CALLS + 1);

    assert.throws(
      () => compareCallOrder(small, over),
      (err: unknown) => {
        assert.ok(err instanceof CallOrderLimitError);
        assert.equal(err.side, "b");
        assert.equal(err.limit, MAX_DIFF_ORDER_CALLS);
        assert.equal(
          err.message,
          `Call order on side 'b' exceeds the limit of ${MAX_DIFF_ORDER_CALLS} calls.`,
        );
        assert.ok(!err.message.includes("A -> B"));
        return true;
      },
    );
  });

  it("leaves no regex state across repeated parser invocations", () => {
    const first = extractOrderedMessageCalls(PLANTUML_ORDERED, MAX_DIFF_ORDER_CALLS);
    const setNames = extractMessageCalls(PLANTUML_ORDERED);
    const second = extractOrderedMessageCalls(PLANTUML_ORDERED, MAX_DIFF_ORDER_CALLS);
    assert.deepEqual(first, second);
    assert.deepEqual([...setNames].sort(), ["cancel", "place"]);

    const forward = compareCallOrder(PLANTUML_ORDERED, PLANTUML_REORDERED);
    const repeat = compareCallOrder(PLANTUML_ORDERED, PLANTUML_REORDERED);
    assert.deepEqual(forward, repeat);
  });
});

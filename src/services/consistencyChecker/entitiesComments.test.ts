// Regression: commented message text previously became real call names.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIFF_ORDER_CALLS } from "../../constants.js";
import { extractMessageCalls, extractOrderedMessageCalls } from "./entities.js";

describe("message-call comments", () => {
  const cases = [
    { name: "indented apostrophe line", source: "  ' A -> B: ghost()\nA -> B: f()", calls: ["f"] },
    { name: "tab-indented Mermaid line", source: "\t%% A->>B: ghost()\nA->>B: f()", calls: ["f"] },
    {
      name: "multiline block",
      source: "A -> B: f()\n /'\nA -> B: ghost()\n'/\nA -> B: g()",
      calls: ["f", "g"],
    },
    {
      name: "same-line block and trailing call",
      source: "/' A -> B: ghost() '/ A -> B: f()",
      calls: ["f"],
    },
    {
      name: "multiline block and trailing call",
      source: "/'\nA -> B: ghost()\n'/ A -> B: f()",
      calls: ["f"],
    },
    {
      name: "consecutive blocks",
      source: "/' : ghost() '/ /' : hidden() '/ A -> B: f()",
      calls: ["f"],
    },
    {
      name: "unclosed block through EOF",
      source: "A -> B: f()\n/'\nA -> B: ghost()",
      calls: ["f"],
    },
    {
      name: "comment markers inside message text",
      source: 'A -> B: f("%% /\'")\nA -> B: g("\'")',
      calls: ["f", "g"],
    },
  ];
  for (const scenario of cases) {
    it(`ignores comments and keeps live calls: ${scenario.name}`, () => {
      for (const source of [scenario.source, scenario.source.replaceAll("\n", "\r\n")]) {
        assert.deepEqual(extractMessageCalls(source), scenario.calls);
        assert.deepEqual(extractOrderedMessageCalls(source, 10), {
          calls: scenario.calls,
          exceeded: false,
        });
      }
    });
  }

  it("counts only live repeated calls toward the cap", () => {
    const comments = "' A -> B: ghost()\n%% A->>B: hidden()\n".repeat(MAX_DIFF_ORDER_CALLS);
    const source = `${comments}/'\n${"A -> B: blocked()\n".repeat(MAX_DIFF_ORDER_CALLS)}'/\nA -> B: f()\nA -> B: g()\nA -> B: f()`;
    assert.deepEqual(extractMessageCalls(source), ["f", "g"]);
    assert.deepEqual(extractOrderedMessageCalls(source, 3), {
      calls: ["f", "g", "f"],
      exceeded: false,
    });
    assert.deepEqual(extractOrderedMessageCalls(source, 2), { calls: ["f", "g"], exceeded: true });
  });

  it("keeps scanner state local after early exits and unclosed blocks", () => {
    const source = "/'\n: ghost()\n'/\nA -> B: f()\nA -> B: g()";
    assert.deepEqual(extractOrderedMessageCalls(source, 1), { calls: ["f"], exceeded: true });
    assert.deepEqual(extractMessageCalls("/'\nA -> B: ghost()"), []);
    assert.deepEqual(extractMessageCalls(source), ["f", "g"]);
    assert.deepEqual(extractOrderedMessageCalls(source, 2), { calls: ["f", "g"], exceeded: false });
  });
});

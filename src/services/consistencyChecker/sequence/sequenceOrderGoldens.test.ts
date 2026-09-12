import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCallEdges } from "./callGraph.js";
import { mapParticipants } from "./participantMapping.js";
import { compareMessageOrder } from "./sequenceOrder.js";

const MAPPED = [
  { participant: "Customer", mapsTo: "Customer" },
  { participant: "Shop", mapsTo: "Shop" },
];

describe("ordering goldens (contract pin, Phase 2)", () => {
  it("pins the unwired state: stubs return empty", () => {
    assert.deepEqual(extractCallEdges("login();\n"), []);
    assert.deepEqual(mapParticipants(["Shop"], new Set(["Shop"])), []);
    assert.deepEqual(compareMessageOrder(["login"], [], MAPPED), []);
  });

  it.skip("happy path: identical order is a match", () => {
    const findings = compareMessageOrder(
      ["login", "checkout"],
      [
        { caller: "run", callee: "login", line: 2, viaCallback: false },
        { caller: "run", callee: "checkout", line: 3, viaCallback: false },
      ],
      MAPPED,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "match");
  });

  it.skip("true divergence: same calls in a different order", () => {
    const findings = compareMessageOrder(
      ["login", "checkout"],
      [
        { caller: "run", callee: "checkout", line: 2, viaCallback: false },
        { caller: "run", callee: "login", line: 3, viaCallback: false },
      ],
      MAPPED,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "divergence");
    assert.match(findings[0].detail, /checkout/);
  });

  it.skip("callback-delivered calls are notes, not divergences", () => {
    const findings = compareMessageOrder(
      ["notify"],
      [{ caller: "<callback>", callee: "notify", line: 5, viaCallback: true }],
      MAPPED,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "callback-note");
  });

  it.skip("all-null mappings skip ordering as unevaluable", () => {
    const findings = compareMessageOrder(
      ["charge"],
      [{ caller: "run", callee: "refund", line: 2, viaCallback: false }],
      [{ participant: "Courier", mapsTo: null }],
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "unmapped-skip");
  });

  it.skip("participant mapping resolves names and nulls the unknown", () => {
    assert.deepEqual(mapParticipants(["Shop", "Courier"], new Set(["Shop"])), [
      { participant: "Shop", mapsTo: "Shop" },
      { participant: "Courier", mapsTo: null },
    ]);
  });
});

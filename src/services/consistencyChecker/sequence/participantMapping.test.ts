import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapParticipants } from "./participantMapping.js";

const cases: Array<{
  name: string;
  participants: string[];
  declared: string[];
  expected: Array<{ participant: string; mapsTo: string | null }>;
}> = [
  {
    name: "a participant without any declarations stays unmapped",
    participants: ["Shop"],
    declared: [],
    expected: [{ participant: "Shop", mapsTo: null }],
  },
  {
    name: "exact match beats an earlier folded-only declaration",
    participants: ["Alice"],
    declared: ["ALICE", "Alice"],
    expected: [{ participant: "Alice", mapsTo: "Alice" }],
  },
  {
    name: "folded collision keeps the first inserted declaration",
    participants: ["aLiCe"],
    declared: ["Alice", "alice", "ALICE"],
    expected: [{ participant: "aLiCe", mapsTo: "Alice" }],
  },
  {
    name: "unicode identifiers fold by String.toLowerCase semantics",
    participants: ["Σ", "K", "İ"],
    declared: ["σ", "k", "i̇"],
    expected: [
      { participant: "Σ", mapsTo: "σ" },
      { participant: "K", mapsTo: "k" },
      { participant: "İ", mapsTo: "i̇" },
    ],
  },
  {
    name: "empty-string identifiers resolve rather than being skipped",
    participants: ["", "fOO"],
    declared: ["", "Foo"],
    expected: [
      { participant: "", mapsTo: "" },
      { participant: "fOO", mapsTo: "Foo" },
    ],
  },
  {
    name: "empty participant list yields no mappings",
    participants: [],
    declared: ["Shop"],
    expected: [],
  },
  {
    name: "duplicate participants map independently",
    participants: ["Shop", "Shop"],
    declared: ["Shop"],
    expected: [
      { participant: "Shop", mapsTo: "Shop" },
      { participant: "Shop", mapsTo: "Shop" },
    ],
  },
];

describe("mapParticipants", () => {
  for (const { name, participants, declared, expected } of cases) {
    it(name, () => {
      assert.deepEqual(mapParticipants(participants, new Set(declared)), expected);
    });
  }

  it("honours a mutated declared set across calls", () => {
    const declared = new Set(["Shop"]);

    assert.deepEqual(mapParticipants(["SHOP"], declared), [
      { participant: "SHOP", mapsTo: "Shop" },
    ]);

    declared.delete("Shop");
    declared.add("Courier");

    assert.deepEqual(mapParticipants(["SHOP", "COURIER"], declared), [
      { participant: "SHOP", mapsTo: null },
      { participant: "COURIER", mapsTo: "Courier" },
    ]);
  });
});

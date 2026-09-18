// Golden skeleton output for diagrams_template. The input is fixed, so these
// assertions lock the exact emitted source per (template, format) pair: any
// cosmetic drift in a skeleton shows up here as a failing golden, and every
// golden is re-checked against the same syntax gate diagrams_create applies.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitSkeleton } from "./skeletons.js";
import type { SkeletonInput, TemplateKind } from "./skeletons.js";
import { validateDiagramSource } from "../diagramValidator.js";

// Two entities is the smallest interesting skeleton: it proves the per-entity
// line is emitted in input order and that a relation/message hint can follow.
const INPUT: SkeletonInput = { title: "Demo", entities: ["User", "Order"] };

const CLASS_PUML = [
  "@startuml",
  "title Demo",
  "class User",
  "class Order",
  "' TODO: members and relations, e.g. User --> Order : owns",
  "@enduml",
  "",
].join("\n");

const CLASS_MERMAID = [
  "%% title: Demo",
  "classDiagram",
  "class User",
  "class Order",
  "%% TODO: members and relations, e.g. User --> Order : owns",
  "",
].join("\n");

const SEQUENCE_PUML = [
  "@startuml",
  "title Demo",
  "participant User",
  "participant Order",
  "' TODO: messages, e.g. User -> Order : placeOrder",
  "@enduml",
  "",
].join("\n");

const SEQUENCE_MERMAID = [
  "%% title: Demo",
  "sequenceDiagram",
  "participant User",
  "participant Order",
  "%% TODO: messages, e.g. User->>Order: placeOrder",
  "",
].join("\n");

// PlantUML has no built-in C4 context shape without the C4-PlantUML stdlib,
// which this local-first server never fetches, so the PlantUML skeleton stays
// self-contained with plain rectangles. Mermaid ships C4 natively, so its
// skeleton uses real C4 syntax behind the C4Context starter.
const C4_CONTEXT_PUML = [
  "@startuml",
  "title Demo",
  "rectangle User",
  "rectangle Order",
  "' TODO: connect external actors and systems, e.g. User --> Order : uses",
  "@enduml",
  "",
].join("\n");

const C4_CONTEXT_MERMAID = [
  "%% title: Demo",
  "C4Context",
  'System(User, "User")',
  'System(Order, "Order")',
  '%% TODO: connect actors and systems, e.g. Rel(User, Order, "uses")',
  "",
].join("\n");

const GOLDENS: Array<{
  name: string;
  kind: TemplateKind;
  format: "puml" | "mermaid";
  expected: string;
}> = [
  { name: "class puml", kind: "class", format: "puml", expected: CLASS_PUML },
  { name: "class mermaid", kind: "class", format: "mermaid", expected: CLASS_MERMAID },
  { name: "sequence puml", kind: "sequence", format: "puml", expected: SEQUENCE_PUML },
  {
    name: "sequence mermaid",
    kind: "sequence",
    format: "mermaid",
    expected: SEQUENCE_MERMAID,
  },
  {
    name: "c4_context puml",
    kind: "c4_context",
    format: "puml",
    expected: C4_CONTEXT_PUML,
  },
  {
    name: "c4_context mermaid",
    kind: "c4_context",
    format: "mermaid",
    expected: C4_CONTEXT_MERMAID,
  },
];

describe("template goldens", () => {
  for (const golden of GOLDENS) {
    it(`emits the locked ${golden.name} skeleton`, () => {
      const source = emitSkeleton(golden.kind, golden.format, INPUT);

      // Every skeleton must clear the exact gate diagrams_create enforces, so
      // a template output can always be handed straight to that tool.
      validateDiagramSource(source, golden.format === "puml" ? "plantuml" : "mermaid");
      assert.equal(source, golden.expected);
    });
  }

  it("omits the title line entirely when no title is given", () => {
    // A whitespace-free diagram must never carry an empty title line; the
    // title key is absent, so nothing is emitted for it.
    const source = emitSkeleton("class", "puml", { entities: ["User"] });
    assert.equal(
      source,
      [
        "@startuml",
        "class User",
        "' TODO: members and relations, e.g. User --> Order : owns",
        "@enduml",
        "",
      ].join("\n"),
    );
  });
});

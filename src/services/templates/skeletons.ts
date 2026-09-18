// Starter-template skeletons for diagrams_template. Six pure emitters — one
// per template kind per dialect — with no filesystem, no state, and no
// options beyond a title and the entity names the caller supplies: the same
// input always yields byte-identical source, and every emitted source passes
// the shared syntax validator (asserted by the golden tests, never assumed at
// runtime).
//
// The set is fixed at three templates here in source, not as data on disk: a
// fourth template is a deliberate schema change, and the published payload
// keeps shipping only dist/, README.md, and LICENSE, so no template file can
// go missing at install time.
//
// PlantUML has no built-in C4 context shape without the C4-PlantUML stdlib,
// which this local-first server never fetches (rendering is a local CLI and
// remote fetches stay opt-in), so the PlantUML C4 skeleton stays
// self-contained with plain rectangles that render standalone. Mermaid ships
// C4 natively, so its skeleton uses real C4 syntax behind the C4Context
// starter that the shared validator recognizes.

import type { DiagramType } from "../../types.js";

export type TemplateKind = "class" | "sequence" | "c4_context";

export interface SkeletonInput {
  /** Optional diagram title; normalized to one line, or absent. */
  title?: string;
  /** Already-validated entity names, in the order they should appear. */
  entities: string[];
}

/** All template kinds, in the order the tool documents them. */
export const TEMPLATE_KINDS: readonly TemplateKind[] = ["class", "sequence", "c4_context"];

/**
 * A title as one trimmed line: internal whitespace runs collapse so an
 * emitted title stays on a single line and control characters cannot break
 * the skeleton. What this returns is exactly what the source and the
 * structured output report. Null means "no title line", never an empty one.
 * Exported so the tool reports the same title it hands the emitter, instead
 * of the raw argument it was given.
 */
export function normalizeTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  const single = title.replace(/\s+/g, " ").trim();
  return single.length > 0 ? single : null;
}

/** PlantUML title line, or null when there is no title to emit. */
function pumlTitle(title: string | null): string | null {
  return title === null ? null : `title ${title}`;
}

/** Mermaid title comment, or null when there is no title to emit. */
function mermaidTitle(title: string | null): string | null {
  return title === null ? null : `%% title: ${title}`;
}

/** Join the present lines, dropping the ones a missing title left null. */
function joinLines(lines: Array<string | null>): string {
  return `${lines.filter((line): line is string => line !== null).join("\n")}\n`;
}

// One TODO hint per skeleton: it points at where the agent fills in the
// diagram, and stays inert in both dialects (a `'` line in PlantUML, `%%` in
// Mermaid), so it can never affect the syntax gate or the rendered result.
const CLASS_HINT_PUML = "' TODO: members and relations, e.g. User --> Order : owns";
const CLASS_HINT_MERMAID = "%% TODO: members and relations, e.g. User --> Order : owns";
const SEQUENCE_HINT_PUML = "' TODO: messages, e.g. User -> Order : placeOrder";
const SEQUENCE_HINT_MERMAID = "%% TODO: messages, e.g. User->>Order: placeOrder";
const C4_HINT_PUML = "' TODO: connect external actors and systems, e.g. User --> Order : uses";
const C4_HINT_MERMAID = '%% TODO: connect actors and systems, e.g. Rel(User, Order, "uses")';

/** PlantUML class skeleton: one box per entity, then a relation hint. */
export function emitClassPlantUml(input: SkeletonInput): string {
  return joinLines([
    "@startuml",
    pumlTitle(normalizeTitle(input.title)),
    ...input.entities.map((name) => `class ${name}`),
    CLASS_HINT_PUML,
    "@enduml",
  ]);
}

/** Mermaid class skeleton: one box per entity, then a relation hint. */
export function emitClassMermaid(input: SkeletonInput): string {
  return joinLines([
    mermaidTitle(normalizeTitle(input.title)),
    "classDiagram",
    ...input.entities.map((name) => `class ${name}`),
    CLASS_HINT_MERMAID,
  ]);
}

/** PlantUML sequence skeleton: one participant per entity, then a message hint. */
export function emitSequencePlantUml(input: SkeletonInput): string {
  return joinLines([
    "@startuml",
    pumlTitle(normalizeTitle(input.title)),
    ...input.entities.map((name) => `participant ${name}`),
    SEQUENCE_HINT_PUML,
    "@enduml",
  ]);
}

/** Mermaid sequence skeleton: one participant per entity, then a message hint. */
export function emitSequenceMermaid(input: SkeletonInput): string {
  return joinLines([
    mermaidTitle(normalizeTitle(input.title)),
    "sequenceDiagram",
    ...input.entities.map((name) => `participant ${name}`),
    SEQUENCE_HINT_MERMAID,
  ]);
}

/**
 * PlantUML C4-context skeleton, self-contained: rectangles stand in for the
 * external actors and systems, so the diagram renders with a local plantuml
 * CLI and needs no stdlib fetch.
 */
export function emitC4ContextPlantUml(input: SkeletonInput): string {
  return joinLines([
    "@startuml",
    pumlTitle(normalizeTitle(input.title)),
    ...input.entities.map((name) => `rectangle ${name}`),
    C4_HINT_PUML,
    "@enduml",
  ]);
}

/**
 * Mermaid C4-context skeleton using real C4 syntax behind the C4Context
 * starter. Entity names are validated identifiers, so each is safe as a C4
 * alias and needs no quoting.
 */
export function emitC4ContextMermaid(input: SkeletonInput): string {
  return joinLines([
    mermaidTitle(normalizeTitle(input.title)),
    "C4Context",
    ...input.entities.map((name) => `System(${name}, "${name}")`),
    C4_HINT_MERMAID,
  ]);
}

type SkeletonEmitter = (input: SkeletonInput) => string;

// The whole surface: one emitter per template kind per dialect.
const SKELETONS: Record<TemplateKind, Record<DiagramType, SkeletonEmitter>> = {
  class: { plantuml: emitClassPlantUml, mermaid: emitClassMermaid },
  sequence: { plantuml: emitSequencePlantUml, mermaid: emitSequenceMermaid },
  c4_context: { plantuml: emitC4ContextPlantUml, mermaid: emitC4ContextMermaid },
};

/**
 * Emit a skeleton by kind and dialect. The dialect string is the tool-level
 * `format` ("puml" | "mermaid"), mapped the same way both generators map it.
 */
export function emitSkeleton(
  kind: TemplateKind,
  format: "puml" | "mermaid",
  input: SkeletonInput,
): string {
  const type: DiagramType = format === "puml" ? "plantuml" : "mermaid";
  return SKELETONS[kind][type](input);
}

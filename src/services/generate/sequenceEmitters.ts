// Pure sequence-diagram emitters for diagrams_generate_sequence. No
// filesystem and no options beyond the collected participants and messages:
// the same input always yields the same source text, and every emitted
// source passes the shared syntax validator (asserted by the golden tests,
// never assumed at runtime).
//
// A participant name comes from a file basename, so it can carry characters
// that are illegal in a sequence participant. The two dialects need different
// handling: PlantUML has quoted display names, Mermaid has identifiers only,
// so Mermaid names are sanitized where PlantUML names are quoted. Both forms
// are applied before the participant and message lists leave the collection
// layer, so what structuredContent reports is exactly what the source renders.

import type { DiagramType } from "../../types.js";
import type { SequenceMessage } from "./sequence.js";

/** True when the name is a legal bare participant token in both dialects. */
function isBareParticipantName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

// PlantUML sequence keywords that a bare participant name would collide
// with: participant types (`actor`, `entity`, ...), block keywords, and the
// `as`/`create`/`destroy` verbs. The validator checks boundaries only, so a
// collision here would render as a broken diagram rather than a rejection.
const PUML_SEQUENCE_KEYWORDS = new Set([
  "participant",
  "actor",
  "boundary",
  "control",
  "entity",
  "database",
  "collections",
  "queue",
  "create",
  "destroy",
  "autonumber",
  "box",
  "end",
  "note",
  "title",
  "hide",
  "show",
  "skinparam",
  "activate",
  "deactivate",
  "loop",
  "alt",
  "else",
  "opt",
  "par",
  "and",
  "break",
  "critical",
  "group",
  "rect",
  "over",
  "as",
]);

/**
 * PlantUML token for a participant name: bare when it is a legal identifier
 * and not a sequence keyword, otherwise quoted with `"` and `\` escaped.
 * Quoting is how a name that collides with a keyword stays a participant.
 */
export function pumlParticipantName(name: string): string {
  if (isBareParticipantName(name) && !PUML_SEQUENCE_KEYWORDS.has(name)) return name;
  return `"${name.replace(/(["\\])/g, "\\$1")}"`;
}

// Mermaid sequence keywords that a bare participant name would clash with
// (the validator cannot see this: it checks the leading diagram type only).
const MERMAID_SEQUENCE_KEYWORDS = new Set([
  "end",
  "loop",
  "alt",
  "else",
  "opt",
  "par",
  "and",
  "rect",
  "note",
  "Note",
  "participant",
  "actor",
  "as",
  "autonumber",
]);

/**
 * Mermaid identifier for a participant name, unique within `taken`. Mermaid
 * has no quoted participant names, so illegal characters become `_` and a
 * keyword or collision gets a `_2`, `_3`, ... suffix.
 */
export function mermaidParticipantName(name: string, taken: Set<string>): string {
  let sanitized = isBareParticipantName(name) ? name : name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (sanitized.length === 0 || MERMAID_SEQUENCE_KEYWORDS.has(sanitized)) {
    sanitized = `_${sanitized || "participant"}`;
  }
  if (!taken.has(sanitized)) {
    taken.add(sanitized);
    return sanitized;
  }
  let suffix = 2;
  while (taken.has(`${sanitized}_${suffix}`)) suffix += 1;
  const unique = `${sanitized}_${suffix}`;
  taken.add(unique);
  return unique;
}

/** Emit PlantUML: declarations, then one ordered message per collected call. */
export function emitPlantUmlSequence(participants: string[], messages: SequenceMessage[]): string {
  const lines = ["@startuml"];
  for (const name of participants) {
    lines.push(`participant ${pumlParticipantName(name)}`);
  }
  for (const message of messages) {
    lines.push(
      `${pumlParticipantName(message.from)} -> ${pumlParticipantName(message.to)} : ${message.message}`,
    );
  }
  lines.push("@enduml");
  return `${lines.join("\n")}\n`;
}

/** Emit Mermaid sequenceDiagram: declarations, then ordered messages. */
export function emitMermaidSequence(participants: string[], messages: SequenceMessage[]): string {
  const lines = ["sequenceDiagram"];
  for (const name of participants) {
    lines.push(`participant ${name}`);
  }
  for (const message of messages) {
    lines.push(`${message.from}->>${message.to}: ${message.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export function emitSequenceDiagram(
  type: DiagramType,
  participants: string[],
  messages: SequenceMessage[],
): string {
  return type === "plantuml"
    ? emitPlantUmlSequence(participants, messages)
    : emitMermaidSequence(participants, messages);
}

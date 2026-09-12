// Kind-tagged diagram entity extraction (sequence layer).
// Seq P1 stub: signatures only. No caller wires into this yet, so tagging
// returns an empty list.

import type { DiagramType } from "../../../types.js";

/** Which diagram construct an entity name came from. */
export type SequenceEntityKind = "participant" | "operation" | "structural";

/** One diagram entity with its construct kind. */
export interface SequenceEntity {
  name: string;
  kind: SequenceEntityKind;
}

/** Extract kind-tagged entities from diagram source (stub: empty). */
export function extractSequenceEntities(_source: string, _type: DiagramType): SequenceEntity[] {
  void _source;
  void _type;
  return [];
}

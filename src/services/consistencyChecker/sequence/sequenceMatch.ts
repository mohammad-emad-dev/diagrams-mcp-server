// Kind-aware existence verdicts for sequence entities.
// Seq P1 stub: returns empty verdicts. Phase 3 matches participants
// through the entity cascade and operations through the operation index
// with whole-word fallback. No caller wires into this yet.

import type { SequenceEntity } from "./sequenceEntities.js";

/** Existence verdict split for kind-tagged entities. */
export interface SequenceMatchResult {
  matched: string[];
  unmatched: string[];
}

/** Match kind-tagged entities against the codebase (stub: empty). */
export function matchSequenceEntities(_entities: SequenceEntity[]): SequenceMatchResult {
  void _entities;
  return { matched: [], unmatched: [] };
}

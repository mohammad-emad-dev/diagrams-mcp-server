// Pure comparison of two diagram sources. Reports added / removed / renamed
// declaration names, plus the sequence-side participants and message calls,
// without ever writing anything or touching the filesystem.
//
// Declaration names come from the same extractors the consistency checker
// uses, so "what counts as a declared name" means the same thing on both
// sides of the comparison. Rename pairing is the only judgment call here, and
// it goes through the shared normalizeForMatch: a removed name pairs with an
// added one only when their normalized forms are identical, which is why
// every rename carries confidence: "heuristic".

import type { DiagramType } from "../../types.js";
import {
  extractEntities,
  extractMermaidParticipants,
  extractMessageCalls,
  extractPlantUmlParticipants,
} from "../consistencyChecker/entities.js";
import { normalizeForMatch } from "../nameNormalize.js";

/** One side of a comparison: source text and its dialect. */
export interface DiffSide {
  source: string;
  type: DiagramType;
}

/** A name present on side b and absent from side a. */
export interface AddedEntity {
  name: string;
}

/** A name present on side a and absent from side b. */
export interface RemovedEntity {
  name: string;
}

/** A removed name paired with an added name by the shared normalizer. */
export interface RenamedEntity {
  from: string;
  to: string;
  confidence: "heuristic";
}

export interface DiffResult {
  added: AddedEntity[];
  removed: RemovedEntity[];
  renamed: RenamedEntity[];
  /** Names declared on both sides, in side a's extraction order. */
  unchanged: string[];
  unchanged_count: number;
  participants_added: string[];
  participants_removed: string[];
  calls_added: string[];
  calls_removed: string[];
  /** True iff added, removed, and renamed are all empty. */
  is_same: boolean;
}

/** Entity names for one side, distinct and in extraction order. */
function entitiesOf(side: DiffSide): string[] {
  return extractEntities(side.source, side.type);
}

/** Participant names for one side, by its dialect's participant syntax. */
function participantsOf(side: DiffSide): string[] {
  return side.type === "plantuml"
    ? extractPlantUmlParticipants(side.source)
    : extractMermaidParticipants(side.source);
}

/**
 * Set difference of two already-distinct name lists, keeping the "from" side's
 * order so the result is deterministic regardless of input ordering.
 */
function difference(from: string[], notIn: Set<string>): string[] {
  return from.filter((name) => !notIn.has(name));
}

/**
 * Pair removed names with added names whose normalized forms agree, in order,
 * using each candidate once. An empty normalized key (a separator-only name)
 * never pairs: it would match every other empty key and invent a rename.
 *
 * Pairing is exact-after-normalization on purpose. A name that merely looks
 * related ("User" vs "UserManager") has a different key and stays a plain
 * add/remove pair — similarity is not identity, so the verdict says heuristic.
 */
function pairRenames(
  removed: RemovedEntity[],
  added: AddedEntity[],
): {
  renamed: RenamedEntity[];
  remainingRemoved: RemovedEntity[];
  remainingAdded: AddedEntity[];
} {
  const renamed: RenamedEntity[] = [];
  const usedAdded = new Set<number>();
  const indexesByKey = new Map<string, number[]>();
  added.forEach((entity, index) => {
    const key = normalizeForMatch(entity.name);
    if (key.length === 0) return;
    const indexes = indexesByKey.get(key);
    if (indexes) {
      indexes.push(index);
    } else {
      indexesByKey.set(key, [index]);
    }
  });

  const remainingRemoved: RemovedEntity[] = [];
  for (const removedEntry of removed) {
    const key = normalizeForMatch(removedEntry.name);
    const candidates = key.length > 0 ? indexesByKey.get(key) : undefined;
    const unused = candidates?.find((index) => !usedAdded.has(index));
    if (unused === undefined) {
      remainingRemoved.push(removedEntry);
      continue;
    }
    usedAdded.add(unused);
    renamed.push({
      from: removedEntry.name,
      to: added[unused].name,
      confidence: "heuristic",
    });
  }

  const remainingAdded = added.filter((_, index) => !usedAdded.has(index));
  return { renamed, remainingRemoved, remainingAdded };
}

/**
 * Compare two diagram sources. Pure: same inputs always yield the same
 * result, and nothing is read or written. Cross-dialect comparisons are
 * allowed; each side is extracted with its own dialect's syntax.
 */
export function diffDiagrams(sideA: DiffSide, sideB: DiffSide): DiffResult {
  const namesA = entitiesOf(sideA);
  const namesB = entitiesOf(sideB);
  const setA = new Set(namesA);
  const setB = new Set(namesB);

  const removed = difference(namesA, setB).map((name) => ({ name }));
  const added = difference(namesB, setA).map((name) => ({ name }));

  // A paired rename leaves the add/remove lists: reporting "User -> Account"
  // and also "User removed, Account added" would say the same thing twice.
  const { renamed, remainingRemoved, remainingAdded } = pairRenames(removed, added);

  const unchanged = namesA.filter((name) => setB.has(name));

  const participantsA = participantsOf(sideA);
  const participantsB = participantsOf(sideB);
  const callsA = extractMessageCalls(sideA.source);
  const callsB = extractMessageCalls(sideB.source);

  return {
    added: remainingAdded,
    removed: remainingRemoved,
    renamed,
    unchanged,
    unchanged_count: unchanged.length,
    participants_added: difference(participantsB, new Set(participantsA)),
    participants_removed: difference(participantsA, new Set(participantsB)),
    calls_added: difference(callsB, new Set(callsA)),
    calls_removed: difference(callsA, new Set(callsB)),
    is_same: remainingAdded.length === 0 && remainingRemoved.length === 0 && renamed.length === 0,
  };
}

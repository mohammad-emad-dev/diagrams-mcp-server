import { MAX_DIFF_ORDER_CALLS } from "../../constants.js";
import type { CallOrderComparison } from "./callOrder.js";

const MAX_RENAME_EVIDENCE_PAIRS = 100;

export interface RenameCallEvidence {
  from: string;
  to: string;
  a_from_calls: number;
  a_to_calls: number;
  b_from_calls: number;
  b_to_calls: number;
  confidence: "heuristic";
}

export interface RenameEvidence {
  pairs: RenameCallEvidence[];
  pairs_available: number;
  pairs_capped: boolean;
  pair_limit: number;
  call_limit: number;
  basis: "diagram-message-call-labels";
}

function frequencies(calls: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

export function renameCallEvidence(
  renamed: ReadonlyArray<{ from: string; to: string }>,
  calls: CallOrderComparison,
): RenameEvidence {
  const a = frequencies(calls.a);
  const b = frequencies(calls.b);
  const pairs = renamed
    .slice(0, MAX_RENAME_EVIDENCE_PAIRS)
    .map(({ from, to }) => evidenceForPair({ from, to }, a, b));
  return {
    pairs,
    pairs_available: renamed.length,
    pairs_capped: renamed.length > MAX_RENAME_EVIDENCE_PAIRS,
    pair_limit: MAX_RENAME_EVIDENCE_PAIRS,
    call_limit: MAX_DIFF_ORDER_CALLS,
    basis: "diagram-message-call-labels",
  };
}

function evidenceForPair(
  { from, to }: { from: string; to: string },
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): RenameCallEvidence {
  return {
    from,
    to,
    a_from_calls: a.get(from) ?? 0,
    a_to_calls: a.get(to) ?? 0,
    b_from_calls: b.get(from) ?? 0,
    b_to_calls: b.get(to) ?? 0,
    confidence: "heuristic" as const,
  };
}

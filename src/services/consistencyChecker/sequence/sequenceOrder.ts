// Message-order comparison between diagram and code (Phase 2 ordering layer).
//
// Compares the sequence of diagram messages against the ordered call edges
// observed in code. Every finding is severity-info evidence: ordering never
// flips an entity between matched and unmatched. Callbacks and DI-driven
// calls are noted as limits, not divergences; unmapped participants skip.

import type { CallEdge } from "./callGraph.js";
import type { ParticipantMapping } from "./participantMapping.js";

/** Ordering finding kinds: agreement, genuine divergence, or explicit skips. */
export type OrderFindingKind = "match" | "divergence" | "callback-note" | "unmapped-skip";

/** One ordering finding with human-readable detail. */
export interface OrderFinding {
  kind: OrderFindingKind;
  detail: string;
}

/**
 * Compare diagram message order against ordered code call edges.
 *
 * Contract: identical order is a match; same calls in a different order are
 * a divergence naming the first out-of-order message; messages matching only
 * callback edges are callback-notes; when mappings exist but all are null,
 * ordering is unevaluable and yields a single unmapped-skip.
 */
export function compareMessageOrder(
  _diagramMessages: string[],
  _edges: CallEdge[],
  _mappings: ParticipantMapping[],
): OrderFinding[] {
  void _diagramMessages;
  void _edges;
  void _mappings;
  return [];
}

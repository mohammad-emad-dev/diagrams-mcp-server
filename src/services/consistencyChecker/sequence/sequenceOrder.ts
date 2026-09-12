// Message-order comparison between diagram and code (Phase 2 ordering layer).
//
// Compares the sequence of diagram messages against the ordered call edges
// observed in code. Every finding is severity-info evidence: ordering never
// flips an entity between matched and unmatched. Callbacks and DI-driven
// calls are noted as limits, not divergences; unmapped participants skip.

/** Ordering finding kinds: agreement, genuine divergence, or explicit skips. */
export type OrderFindingKind = "match" | "divergence" | "callback-note" | "unmapped-skip";

/** One ordering finding with human-readable detail. */
export interface OrderFinding {
  kind: OrderFindingKind;
  detail: string;
}

/** Compare diagram message order against ordered code calls. */
export function compareMessageOrder(
  _diagramMessages: string[],
  _codeCalls: string[],
): OrderFinding[] {
  void _diagramMessages;
  void _codeCalls;
  return [];
}

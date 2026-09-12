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
  diagramMessages: string[],
  edges: CallEdge[],
  mappings: ParticipantMapping[],
): OrderFinding[] {
  if (mappings.length > 0 && mappings.every((mapping) => mapping.mapsTo === null)) {
    return [
      {
        kind: "unmapped-skip",
        detail:
          "No diagram participant maps to a declared identifier, so message " +
          "ordering is unevaluable and skipped. This is a gap in evidence, not a divergence.",
      },
    ];
  }
  const codeOrder: string[] = [];
  const callbackNames = new Set<string>();
  for (const edge of edges) {
    if (edge.viaCallback) {
      callbackNames.add(edge.callee);
    } else {
      codeOrder.push(edge.callee);
    }
  }
  const codeSet = new Set(codeOrder);
  const findings: OrderFinding[] = [];
  const comparable: string[] = [];
  for (const message of diagramMessages) {
    if (codeSet.has(message)) {
      comparable.push(message);
    } else if (callbackNames.has(message)) {
      findings.push({
        kind: "callback-note",
        detail:
          `'${message}' reaches code only through a callback, promise, or listener ` +
          "path, so its position cannot be ordered. Treated as a limit, not a divergence.",
      });
    }
  }
  if (comparable.length === 0) return findings;
  const firstPosition = new Map<string, number>();
  codeOrder.forEach((name, index) => {
    if (!firstPosition.has(name)) firstPosition.set(name, index);
  });
  let maxSeen = -1;
  for (const message of comparable) {
    const position = firstPosition.get(message) ?? -1;
    if (position < maxSeen) {
      return [
        {
          kind: "divergence",
          detail:
            `Diagram message '${message}' is out of order: the code calls it ` +
            "before an earlier diagram message.",
        },
        ...findings,
      ];
    }
    maxSeen = position;
  }
  findings.push({
    kind: "match",
    detail: "Diagram message order matches the observed call order.",
  });
  return findings;
}

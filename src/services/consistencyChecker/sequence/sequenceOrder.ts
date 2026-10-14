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

/** Single unevaluable-ordering finding. */
function unmappedSkip(): OrderFinding[] {
  return [
    {
      kind: "unmapped-skip",
      detail:
        "No diagram participant maps to a declared identifier, so message " +
        "ordering is unevaluable and skipped. This is a gap in evidence, not a divergence.",
    },
  ];
}

/** Split edges into first-seen direct-call positions and callback-only names. */
function partitionEdges(edges: CallEdge[]): {
  firstPosition: Map<string, number>;
  callbackNames: Set<string>;
} {
  const firstPosition = new Map<string, number>();
  const callbackNames = new Set<string>();
  let directIndex = 0;
  for (const edge of edges) {
    if (edge.viaCallback) {
      callbackNames.add(edge.callee);
    } else {
      if (!firstPosition.has(edge.callee)) firstPosition.set(edge.callee, directIndex);
      directIndex += 1;
    }
  }
  return { firstPosition, callbackNames };
}

interface TriagedMessages {
  comparable: string[];
  notes: OrderFinding[];
}

/** Sort messages into order-comparable ones and callback notes. */
function triageMessages(
  diagramMessages: string[],
  firstPosition: Map<string, number>,
  callbackNames: Set<string>,
): TriagedMessages {
  const comparable: string[] = [];
  const notes: OrderFinding[] = [];
  for (const message of diagramMessages) {
    if (firstPosition.has(message)) {
      comparable.push(message);
    } else if (callbackNames.has(message)) {
      notes.push({
        kind: "callback-note",
        detail:
          `'${message}' reaches code only through a callback, promise, or listener ` +
          "path, so its position cannot be ordered. Treated as a limit, not a divergence.",
      });
    }
  }
  return { comparable, notes };
}

/** Walk comparable messages in diagram order; divergence naming the outlier. */
function walkOrder(comparable: string[], firstPosition: Map<string, number>): OrderFinding | null {
  let maxSeen = -1;
  for (const message of comparable) {
    const position = firstPosition.get(message) ?? -1;
    if (position < maxSeen) {
      return {
        kind: "divergence",
        detail:
          `Diagram message '${message}' is out of order: the code calls it ` +
          "before an earlier diagram message.",
      };
    }
    maxSeen = position;
  }
  return null;
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
    return unmappedSkip();
  }
  const { firstPosition, callbackNames } = partitionEdges(edges);
  const { comparable, notes } = triageMessages(diagramMessages, firstPosition, callbackNames);
  if (comparable.length === 0) return notes;
  const divergence = walkOrder(comparable, firstPosition);
  if (divergence) return [divergence, ...notes];
  return [
    ...notes,
    {
      kind: "match",
      detail: "Diagram message order matches the observed call order.",
    },
  ];
}

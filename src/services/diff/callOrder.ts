// Bounded recognized-message-call order comparison. Compares the ordered call
// names both diagram sources recognize through the shared message-call
// grammar (repetitions kept), without any character, argument, participant,
// or label analysis. Over-limit input rejects the whole comparison: the
// error names the side and the ceiling, never source text or paths, and no
// partial arrays are returned on success.

import { MAX_DIFF_ORDER_CALLS } from "../../constants.js";
import { extractOrderedMessageCalls } from "../consistencyChecker/entities.js";

/** Whole comparison rejected: one side holds more recognized calls than kept. */
export class CallOrderLimitError extends Error {
  readonly side: "a" | "b";
  readonly limit: number;

  constructor(side: "a" | "b", limit: number) {
    super(`Call order on side '${side}' exceeds the limit of ${limit} calls.`);
    this.name = "CallOrderLimitError";
    this.side = side;
    this.limit = limit;
  }
}

/** Ordered recognized calls for both sides plus whether the order changed. */
export interface CallOrderComparison {
  a: string[];
  b: string[];
  changed: boolean;
}

/** Positional equality: same length and same name at every position. O(n). */
function ordersEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Ordered calls for one side, or throw naming that side when over the cap. */
function orderedCallsOrThrow(source: string, side: "a" | "b"): string[] {
  const { calls, exceeded } = extractOrderedMessageCalls(source, MAX_DIFF_ORDER_CALLS);
  if (exceeded) throw new CallOrderLimitError(side, MAX_DIFF_ORDER_CALLS);
  return calls;
}

/**
 * Compare recognized call order for two diagram sources. Pure: same inputs
 * always yield the same result. Either side over the cap throws
 * CallOrderLimitError for that side; nothing partial is returned.
 */
export function compareCallOrder(sourceA: string, sourceB: string): CallOrderComparison {
  const a = orderedCallsOrThrow(sourceA, "a");
  const b = orderedCallsOrThrow(sourceB, "b");
  return { a, b, changed: !ordersEqual(a, b) };
}

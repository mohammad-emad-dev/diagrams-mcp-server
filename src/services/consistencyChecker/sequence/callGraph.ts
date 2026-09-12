// Ordered call graph per scanned file (Phase 2 ordering layer).
//
// One edge per call site, in source order: who calls what, where.
// The ordering check compares this sequence against diagram message order.
// Informational only: ordering findings never flip matched/unmatched verdicts.

/** One directed call observed in source order. */
export interface CallEdge {
  /** Enclosing function/method name, or "<module>" at top level. */
  caller: string;
  /** Called function/method name. */
  callee: string;
  /** True when the call sits inside a callback/promise/listener (ordering limit). */
  viaCallback: boolean;
  /** 1-based line number of the call site. */
  line: number;
}

/** Extract ordered call edges from comment/string-stripped source. */
export function extractCallEdges(_stripped: string): CallEdge[] {
  void _stripped;
  return [];
}

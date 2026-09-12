// Operation-name index per scanned file.
// Seq P1 stub: returns an empty set. Phase 3 derives it from the existing
// declared-identifier set (function/method declarations per language
// family); no caller wires into this yet.

/** Operation names visible in one file (stub: empty). */
export function buildOperationIndex(_declared: Set<string>): Set<string> {
  void _declared;
  return new Set<string>();
}

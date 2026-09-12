// Operation-name index per scanned file.
//
// V1 derives it from the declared-identifier set (function/method
// declarations per language family share that set with classes, so this is
// a copy). The seam exists so Phase 2 ordering and future per-language
// method patterns have one place to refine.

/** Operation names visible in one file. */
export function buildOperationIndex(declared: Set<string>): Set<string> {
  return new Set(declared);
}

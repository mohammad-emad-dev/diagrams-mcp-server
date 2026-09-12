// Glue between the AST layer and the existing ScannedFile shape.
// Phase 1 stub: returns an empty set so the union in Phase 3 is a no-op
// until the visitor is filled. No caller wires into this yet.

/** Build the AST-declared set for one file (stub: empty). */
export function buildTsDeclared(_stripped: string, _raw: string, _ext: string): Set<string> {
  void _stripped;
  void _raw;
  void _ext;
  return new Set<string>();
}

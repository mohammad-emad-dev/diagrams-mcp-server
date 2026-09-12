// Kind-aware existence verdicts for sequence entities.
//
// Unmatched participants and operations get construct-specific issue text;
// structural entities (class diagrams and everything else) keep the
// long-standing generic text byte-identical.

import type { SequenceEntityKind } from "./sequenceEntities.js";

/** Issue text for one unmatched entity of a known kind. */
export function sequenceIssueText(entity: string, kind: SequenceEntityKind): string {
  if (kind === "participant") {
    return (
      `'${entity}' appears as a participant in the diagram but no matching identifier ` +
      "was found in the scanned codebase. It may be renamed, removed, or not yet implemented."
    );
  }
  if (kind === "operation") {
    return (
      `'${entity}' appears as an operation in the diagram but no matching function ` +
      "was found in the scanned codebase. It may be renamed, removed, or not yet implemented."
    );
  }
  return (
    `'${entity}' appears in the diagram but no matching identifier was found ` +
    "in the scanned codebase. It may be renamed, removed, or not yet implemented."
  );
}

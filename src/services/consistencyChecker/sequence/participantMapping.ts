// Diagram-participant to code-identity mapping (Phase 2 ordering layer).
//
// Ordering comparison needs to know which declared identifier (if any) each
// diagram participant corresponds to. Unmapped participants are skipped by
// the ordering check, never reported: absence of evidence is not divergence.

/** One participant and the code identity it maps to, if any. */
export interface ParticipantMapping {
  /** Participant name as it appears in the diagram. */
  participant: string;
  /** Declared identifier it maps to, or null when unmapped. */
  mapsTo: string | null;
}

/** Declared identifier matching a participant: exact, then case-insensitive. */
function matchDeclared(name: string, declared: Set<string>): string | null {
  if (declared.has(name)) return name;
  const lowered = name.toLowerCase();
  for (const candidate of declared) {
    if (candidate.toLowerCase() === lowered) return candidate;
  }
  return null;
}

/** Map each participant to a declared identifier; null when no match. */
export function mapParticipants(
  participants: string[],
  declared: Set<string>,
): ParticipantMapping[] {
  return participants.map((participant) => ({
    participant,
    mapsTo: matchDeclared(participant, declared),
  }));
}

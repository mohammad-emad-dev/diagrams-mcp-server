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

/** Map each participant to a declared identifier; null when no match. */
export function mapParticipants(
  participants: string[],
  declared: Set<string>,
): ParticipantMapping[] {
  if (participants.length === 0) return [];

  // Keep the first declaration for folded collisions; exact matches still
  // take priority when mapping participants below.
  const folded = new Map<string, string>();
  for (const id of declared) {
    const key = id.toLowerCase();
    if (!folded.has(key)) folded.set(key, id);
  }

  return participants.map((participant) => {
    if (declared.has(participant)) return { participant, mapsTo: participant };
    return { participant, mapsTo: folded.get(participant.toLowerCase()) ?? null };
  });
}

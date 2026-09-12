// Kind-tagged diagram entity extraction (sequence layer).
//
// Tags every name from extractEntities by construct: participant names,
// message-call (operation) names, or anything else (structural: classes,
// components, namespaces). Participant wins when a name is both.

import type { DiagramType } from "../../../types.js";
import {
  extractEntities,
  extractMermaidParticipants,
  extractMessageCalls,
  extractPlantUmlParticipants,
} from "../entities.js";

/** Which diagram construct an entity name came from. */
export type SequenceEntityKind = "participant" | "operation" | "structural";

/** One diagram entity with its construct kind. */
export interface SequenceEntity {
  name: string;
  kind: SequenceEntityKind;
}

/** Extract kind-tagged entities from diagram source. */
export function extractSequenceEntities(source: string, type: DiagramType): SequenceEntity[] {
  const names = extractEntities(source, type);
  const participants = new Set(
    type === "plantuml" ? extractPlantUmlParticipants(source) : extractMermaidParticipants(source),
  );
  const operations = new Set(extractMessageCalls(source));
  return names.map((name) => {
    let kind: SequenceEntityKind = "structural";
    if (participants.has(name)) {
      kind = "participant";
    } else if (operations.has(name)) {
      kind = "operation";
    }
    return { name, kind };
  });
}

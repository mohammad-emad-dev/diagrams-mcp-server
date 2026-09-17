// Pure diagram emitters for diagrams_generate. No filesystem, no options
// beyond the collected entities and relations: the same input always yields
// the same source text, and every emitted source passes the shared syntax
// validator (asserted by the golden tests, never assumed at runtime).

import type { DiagramType } from "../../types.js";
import type { RelationEdge } from "./collectEntities.js";

export interface EmittedDiagram {
  type: DiagramType;
  source: string;
}

const PUML_HEADER = "@startuml";
const PUML_FOOTER = "@enduml";
const MERMAID_HEADER = "classDiagram";

/** PlantUML relation arrows by kind. */
const PUML_ARROWS: Record<RelationEdge["kind"], string> = {
  extends: "--|>",
  implements: "..|>",
};

/** Mermaid relation arrows by kind. */
const MERMAID_ARROWS: Record<RelationEdge["kind"], string> = {
  extends: "--|>",
  implements: "..|>",
};

/** Emit PlantUML: one box per entity, then one arrow per evidenced edge. */
export function emitPlantUml(entities: string[], relations: RelationEdge[]): string {
  const lines = [PUML_HEADER];
  for (const entity of entities) {
    lines.push(`class ${entity}`);
  }
  for (const edge of relations) {
    lines.push(`${edge.from} ${PUML_ARROWS[edge.kind]} ${edge.to}`);
  }
  lines.push(PUML_FOOTER);
  return `${lines.join("\n")}\n`;
}

/** Emit Mermaid classDiagram: one box per entity, then one edge per evidence. */
export function emitMermaid(entities: string[], relations: RelationEdge[]): string {
  const lines = [MERMAID_HEADER];
  for (const entity of entities) {
    lines.push(`class ${entity}`);
  }
  for (const edge of relations) {
    lines.push(`${edge.from} ${MERMAID_ARROWS[edge.kind]} ${edge.to}`);
  }
  return `${lines.join("\n")}\n`;
}

export function emitDiagram(
  type: DiagramType,
  entities: string[],
  relations: RelationEdge[],
): EmittedDiagram {
  return {
    type,
    source:
      type === "plantuml" ? emitPlantUml(entities, relations) : emitMermaid(entities, relations),
  };
}

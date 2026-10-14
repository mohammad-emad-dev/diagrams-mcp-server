// Pure diagram emitters for diagrams_generate. No filesystem, no options
// beyond the collected entities and relations: the same input always yields
// the same source text, and every emitted source passes the shared syntax
// validator (asserted by the golden tests, never assumed at runtime).

import type { DiagramType } from "../../types.js";
import type { RelationEdge } from "./types.js";

export interface EmittedDiagram {
  type: DiagramType;
  source: string;
}

const PUML_HEADER = "@startuml";
const PUML_FOOTER = "@enduml";
const MERMAID_HEADER = "classDiagram";

/** Class relation arrows by kind. */
const CLASS_ARROWS: Record<RelationEdge["kind"], string> = {
  extends: "--|>",
  implements: "..|>",
};

function collectClassBody(entities: string[], relations: RelationEdge[]): string[] {
  const lines: string[] = [];
  for (const entity of entities) {
    lines.push(`class ${entity}`);
  }
  for (const edge of relations) {
    lines.push(`${edge.from} ${CLASS_ARROWS[edge.kind]} ${edge.to}`);
  }
  return lines;
}

/** Emit PlantUML: one box per entity, then one arrow per evidenced edge. */
export function emitPlantUml(entities: string[], relations: RelationEdge[]): string {
  const lines = [PUML_HEADER, ...collectClassBody(entities, relations), PUML_FOOTER];
  return `${lines.join("\n")}\n`;
}

/** Emit Mermaid classDiagram: one box per entity, then one edge per evidence. */
export function emitMermaid(entities: string[], relations: RelationEdge[]): string {
  const lines = [MERMAID_HEADER, ...collectClassBody(entities, relations)];
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

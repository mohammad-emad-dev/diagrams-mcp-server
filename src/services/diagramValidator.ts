// Best-effort syntax checks for diagram source on create/update.
// PlantUML needs both @startuml/@enduml boundaries; Mermaid needs a known
// leading diagram keyword. Anything deeper is left to the renderer.

import type { DiagramType } from "../types.js";

export class DiagramValidationError extends Error {
  readonly diagramType: DiagramType;
  readonly reason: string;

  constructor(diagramType: DiagramType, reason: string) {
    super(
      `Invalid ${diagramType === "plantuml" ? "PlantUML" : "Mermaid"} diagram (basic check): ${reason}`,
    );
    this.name = "DiagramValidationError";
    this.diagramType = diagramType;
    this.reason = reason;
  }
}

const PLANTUML_START = "@startuml";
const PLANTUML_END = "@enduml";

// Accepted Mermaid openers, lowercase. Version suffixes after - _ : ;
// (e.g. `graph-beta`) are allowed.
const MERMAID_STARTERS = [
  "graph",
  "flowchart",
  "sequencediagram",
  "classdiagram",
  "statediagram",
  "erdiagram",
  "gantt",
  "pie",
  "journey",
  "gitgraph",
  "mindmap",
  "timeline",
  "quadrantchart",
  "requirementdiagram",
  "c4context",
  "c4container",
  "c4component",
  "c4dynamic",
  "c4deployment",
  "c4",
  "sankey",
  "xychart",
  "block",
  "packet",
  "architecture",
  "kanban",
  "radar",
  "info",
] as const;

const MERMAID_STARTER_HINT =
  "graph, flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, " +
  "gantt, pie, journey, gitGraph, mindmap, timeline, quadrantChart, " +
  "requirementDiagram, C4, sankey, xychart, block, packet, architecture, kanban, radar, info";

function formatName(type: DiagramType): string {
  return type === "plantuml" ? "PlantUML" : "Mermaid";
}

function validatePlantUml(content: string): void {
  const lowered = content.toLowerCase();
  const startIndex = lowered.indexOf(PLANTUML_START);
  const endIndex = lowered.indexOf(PLANTUML_END);

  if (startIndex === -1 && endIndex === -1) {
    throw new DiagramValidationError(
      "plantuml",
      "missing @startuml and @enduml boundaries. PlantUML diagrams must start " +
        "with @startuml and end with @enduml.",
    );
  }
  if (startIndex === -1) {
    throw new DiagramValidationError(
      "plantuml",
      "missing @startuml boundary (found @enduml but no @startuml). PlantUML " +
        "diagrams must start with @startuml and end with @enduml.",
    );
  }
  if (endIndex === -1) {
    throw new DiagramValidationError(
      "plantuml",
      "missing @enduml boundary (found @startuml but no @enduml). PlantUML " +
        "diagrams must start with @startuml and end with @enduml.",
    );
  }
  if (endIndex < startIndex) {
    throw new DiagramValidationError(
      "plantuml",
      "@enduml appears before @startuml. PlantUML diagrams must start with " +
        "@startuml and end with @enduml.",
    );
  }
}

function firstMeaningfulMermaidLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const meaningful: string[] = [];
  let index = 0;

  const isSkippable = (trimmed: string): boolean =>
    trimmed.length === 0 || trimmed.startsWith("%%");

  while (index < lines.length && isSkippable(lines[index].trim())) {
    index += 1;
  }

  if (index < lines.length && lines[index].trim() === "---") {
    index += 1;
    while (index < lines.length && lines[index].trim() !== "---") {
      index += 1;
    }
    if (index >= lines.length) {
      return [];
    }
    index += 1;
  }

  for (; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!isSkippable(trimmed)) {
      meaningful.push(trimmed);
    }
  }
  return meaningful;
}

function mermaidFirstToken(line: string): string {
  const token = line.split(/\s+/, 1)[0] ?? "";
  return token.toLowerCase();
}

function normalizeMermaidToken(rawToken: string): string {
  return rawToken.replace(/[;:,]+$/, "");
}

function isKnownMermaidStarter(token: string): boolean {
  const normalized = normalizeMermaidToken(token);
  if (normalized.length === 0) return false;
  for (const starter of MERMAID_STARTERS) {
    if (normalized === starter) return true;
    if (
      normalized.startsWith(`${starter}-`) ||
      normalized.startsWith(`${starter}_`) ||
      normalized.startsWith(`${starter}:`) ||
      normalized.startsWith(`${starter};`)
    ) {
      return true;
    }
  }
  return false;
}

function validateMermaid(content: string): void {
  const meaningful = firstMeaningfulMermaidLines(content);
  if (meaningful.length === 0) {
    throw new DiagramValidationError(
      "mermaid",
      "no diagram declaration found. Mermaid diagrams must start with a known " +
        `diagram type such as ${MERMAID_STARTER_HINT}.`,
    );
  }
  const token = mermaidFirstToken(meaningful[0]);
  if (!isKnownMermaidStarter(token)) {
    throw new DiagramValidationError(
      "mermaid",
      "unrecognized diagram declaration. Mermaid diagrams must start with a " +
        `known diagram type such as ${MERMAID_STARTER_HINT}.`,
    );
  }
}

// Validate source for its type. Throws without ever including the source.
export function validateDiagramSource(content: string, type: DiagramType): void {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new DiagramValidationError(
      type,
      `source is empty or whitespace-only. Provide full ${formatName(type)} source text.`,
    );
  }
  if (type === "plantuml") {
    validatePlantUml(content);
    return;
  }
  validateMermaid(content);
}

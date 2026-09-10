// Diagram-side entity extraction: candidate names from PlantUML and Mermaid source.
import type { DiagramType } from "../../types.js";

/** Reduce a raw diagram name to its plain identifier. */
function cleanDiagramName(raw: string): string | null {
  let name = raw.trim();
  if (name.length === 0) return null;
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'")) ||
    (name.startsWith("[") && name.endsWith("]"))
  ) {
    name = name.slice(1, -1).trim();
  }
  if (name.length === 0) return null;
  const suffixStart = name.search(/[<~(]/);
  if (suffixStart > 0) {
    name = name.slice(0, suffixStart).trim();
  }
  const parenStart = name.indexOf("(");
  if (parenStart > 0) {
    name = name.slice(0, parenStart).trim();
  }
  if (name.length === 0) return null;
  const segments = name
    .split(/[/\\.:]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last.length > 0 ? last : null;
}

/** Shared name sink: dedupe set plus diagram-name cleaning adder. */
function makeEntitySink(): {
  names: Set<string>;
  addClean: (raw: string | undefined) => void;
} {
  const names = new Set<string>();
  const addClean = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = cleanDiagramName(raw);
    if (cleaned) names.add(cleaned);
  };
  return { names, addClean };
}

// Message calls like `charge(card)`; plain labels are ignored. Shared by both
// dialects. Module-level /g regex, so lastIndex is reset on every call below.
const MESSAGE_CALL_REGEX = /:(?![/:])[^\n:]*?\b([A-Za-z_][A-Za-z0-9_]{1,})\s*\(/g;

/** Collect message-call entities from source into a shared sink. */
function collectMessageCalls(source: string, addClean: (raw: string | undefined) => void): void {
  MESSAGE_CALL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MESSAGE_CALL_REGEX.exec(source)) !== null) {
    addClean(match[1]);
  }
}

/** Candidate entity names from PlantUML source. */
function extractEntitiesFromPlantUml(source: string): string[] {
  const { names, addClean } = makeEntitySink();
  let match: RegExpExecArray | null;

  // Type declarations: class, interface, enum, record, struct, and friends.
  const declRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gm;
  while ((match = declRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Aliased declarations (`class "Name" as Alias`).
  const aliasRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\b[^\n{]*?\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = aliasRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Namespace/package/module blocks.
  const blockRegex = /^\s*(?:namespace|package|module)\s+([A-Za-z_][\w.\\/]*)/gm;
  while ((match = blockRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  // Components, with optional aliases.
  const componentRegex =
    /^\s*component\s+(?:\[([^\]]+)\]|"([^"]+)"|([A-Za-z_][\w.\\/]*))(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = componentRegex.exec(source)) !== null) {
    addClean(match[1]);
    addClean(match[2]);
    addClean(match[3]);
    if (match[4]) names.add(match[4]);
  }

  // Sequence participants and actors, with optional aliases.
  const participantRegex =
    /^\s*(?:participant|actor|boundary|control|entity|database|collections|queue)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }

  collectMessageCalls(source, addClean);

  return Array.from(names);
}

/** Candidate entity names from Mermaid source. */
function extractEntitiesFromMermaid(source: string): string[] {
  const { names, addClean } = makeEntitySink();
  let match: RegExpExecArray | null;

  // Class declarations.
  const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = classRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Annotations like `<<interface>> Name`.
  const annotationRegex = /<<\s*[^<>]*?>>\s*([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = annotationRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Namespace blocks.
  const namespaceRegex = /^\s*namespace\s+([A-Za-z_][\w.]*)/gm;
  while ((match = namespaceRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  // Sequence participants and actors, with optional aliases.
  const participantRegex =
    /^\s*(?:create\s+|destroy\s+)?(?:participant|actor)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }

  // C4 containers, components, systems, and people.
  const c4Regex =
    /\b(?:Container|Component|System|ExternalSystem|Person)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((match = c4Regex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Subgraph groupings.
  const subgraphRegex = /^\s*subgraph\s+(?:"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w-]*))/gm;
  while ((match = subgraphRegex.exec(source)) !== null) {
    addClean(match[1]);
    addClean(match[2]);
    addClean(match[3]);
  }

  collectMessageCalls(source, addClean);

  return Array.from(names);
}

export function extractEntities(source: string, type: DiagramType): string[] {
  return type === "plantuml"
    ? extractEntitiesFromPlantUml(source)
    : extractEntitiesFromMermaid(source);
}

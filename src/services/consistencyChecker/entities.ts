// Diagram-side entity extraction: candidate names from PlantUML and Mermaid source.
import type { DiagramType } from "../../types.js";

/** Symmetric wrappers stripped before suffix/segment handling. */
const WRAPPER_PAIRS: Array<[open: string, close: string]> = [
  ['"', '"'],
  ["'", "'"],
  ["[", "]"],
];

/** Strip one symmetric wrapper (`".."`, `'..'`, `[..]`); untouched otherwise. */
function stripWrapper(name: string): string {
  const pair = WRAPPER_PAIRS.find(([open, close]) => name.startsWith(open) && name.endsWith(close));
  return pair ? name.slice(1, -1).trim() : name;
}

/** Cut generic/tilde/paren suffixes (`A<T>`, `A~x`, `fn(x)`); guards keep index-0. */
function cutSuffix(name: string): string {
  const suffixStart = name.search(/[<~(]/);
  const cut = suffixStart > 0 ? name.slice(0, suffixStart) : name;
  const parenStart = cut.indexOf("(");
  return (parenStart > 0 ? cut.slice(0, parenStart) : cut).trim();
}

/** Reduce a raw diagram name to its plain identifier. */
function cleanDiagramName(raw: string): string | null {
  const unwrapped = stripWrapper(raw.trim());
  if (unwrapped.length === 0) return null;
  const cut = cutSuffix(unwrapped);
  if (cut.length === 0) return null;
  const segments = cut
    .split(/[/\\.:]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last.length > 0 ? last : null;
}

/** Shared name sink used by the grammar collectors: dedupe set plus cleaning adder. */
type EntitySink = {
  names: Set<string>;
  addClean: (raw: string | undefined) => void;
};

function makeEntitySink(): EntitySink {
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
const MESSAGE_CALL_REGEX = /:(?![/:])[^\n:]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/** Collect message-call entities from source into a shared sink. */
function collectMessageCalls(source: string, addClean: (raw: string | undefined) => void): void {
  MESSAGE_CALL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MESSAGE_CALL_REGEX.exec(source)) !== null) {
    addClean(match[1]);
  }
}

/** Message-call names (`charge` in `: charge(card)`), shared by both dialects. */
export function extractMessageCalls(source: string): string[] {
  const { names, addClean } = makeEntitySink();
  collectMessageCalls(source, addClean);
  return Array.from(names);
}

/** Cleaned message-call names in extraction order, repetitions kept. */
function* orderedMessageCallNames(source: string): Generator<string> {
  // matchAll clones the shared grammar, so the module regex lastIndex is
  // never touched and repeated calls cannot leak parser state.
  for (const match of source.matchAll(MESSAGE_CALL_REGEX)) {
    const cleaned = cleanDiagramName(match[1] ?? "");
    if (cleaned) yield cleaned;
  }
}

/**
 * Message-call names in extraction order, repetitions kept, bounded by limit.
 * Stops after limit + 1 recognized calls: `calls` never exceeds `limit` and
 * `exceeded` reports whether another recognized call remained. Recognized
 * means the shared grammar matched and the name cleaned to a non-empty
 * identifier; plain labels never count. Never builds a full match array.
 */
export function extractOrderedMessageCalls(
  source: string,
  limit: number,
): { calls: string[]; exceeded: boolean } {
  const calls: string[] = [];
  let recognized = 0;
  for (const name of orderedMessageCallNames(source)) {
    recognized += 1;
    if (recognized > limit) return { calls, exceeded: true };
    calls.push(name);
  }
  return { calls, exceeded: false };
}

/** Run one participant regex to completion, collecting display names and aliases. */
function collectParticipants(source: string, participantRegex: RegExp): string[] {
  const { names, addClean } = makeEntitySink();
  participantRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }
  return Array.from(names);
}

/** PlantUML participant/actor names, with optional aliases. */
export function extractPlantUmlParticipants(source: string): string[] {
  return collectParticipants(
    source,
    /^\s*(?:participant|actor|boundary|control|entity|database|collections|queue)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm,
  );
}

/** Mermaid participant/actor names, with optional aliases. */
export function extractMermaidParticipants(source: string): string[] {
  return collectParticipants(
    source,
    /^\s*(?:create\s+|destroy\s+)?(?:participant|actor)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm,
  );
}

function collectPlantUmlDeclarations(source: string, sink: EntitySink): void {
  const declRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gm;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(source)) !== null) {
    sink.names.add(match[1]);
  }
}

function collectPlantUmlAliases(source: string, sink: EntitySink): void {
  const aliasRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\b[^\n{]*?\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = aliasRegex.exec(source)) !== null) {
    sink.names.add(match[1]);
  }
}

function collectPlantUmlNamespaces(source: string, sink: EntitySink): void {
  const blockRegex = /^\s*(?:namespace|package|module)\s+([A-Za-z_][\w.\\/]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(source)) !== null) {
    sink.addClean(match[1]);
  }
}

function collectPlantUmlComponents(source: string, sink: EntitySink): void {
  const componentRegex =
    /^\s*component\s+(?:\[([^\]]+)\]|"([^"]+)"|([A-Za-z_][\w.\\/]*))(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  let match: RegExpExecArray | null;
  while ((match = componentRegex.exec(source)) !== null) {
    sink.addClean(match[1]);
    sink.addClean(match[2]);
    sink.addClean(match[3]);
    if (match[4]) sink.names.add(match[4]);
  }
}

/** Candidate entity names from PlantUML source. */
function extractEntitiesFromPlantUml(source: string): string[] {
  const sink = makeEntitySink();
  collectPlantUmlDeclarations(source, sink);
  collectPlantUmlAliases(source, sink);
  collectPlantUmlNamespaces(source, sink);
  collectPlantUmlComponents(source, sink);

  // Sequence participants and actors, with optional aliases.
  for (const name of extractPlantUmlParticipants(source)) sink.names.add(name);

  collectMessageCalls(source, sink.addClean);

  return Array.from(sink.names);
}

function collectMermaidClasses(source: string, sink: EntitySink): void {
  const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(source)) !== null) {
    sink.names.add(match[1]);
  }
}

function collectMermaidAnnotations(source: string, sink: EntitySink): void {
  const annotationRegex = /<<\s*[^<>]*?>>\s*([A-Za-z_][A-Za-z0-9_]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = annotationRegex.exec(source)) !== null) {
    sink.names.add(match[1]);
  }
}

function collectMermaidNamespaces(source: string, sink: EntitySink): void {
  const namespaceRegex = /^\s*namespace\s+([A-Za-z_][\w.]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = namespaceRegex.exec(source)) !== null) {
    sink.addClean(match[1]);
  }
}

function collectMermaidC4(source: string, sink: EntitySink): void {
  const c4Regex =
    /\b(?:Container|Component|System|ExternalSystem|Person)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = c4Regex.exec(source)) !== null) {
    sink.names.add(match[1]);
  }
}

function collectMermaidSubgraphs(source: string, sink: EntitySink): void {
  const subgraphRegex = /^\s*subgraph\s+(?:"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w-]*))/gm;
  let match: RegExpExecArray | null;
  while ((match = subgraphRegex.exec(source)) !== null) {
    sink.addClean(match[1]);
    sink.addClean(match[2]);
    sink.addClean(match[3]);
  }
}

/** Candidate entity names from Mermaid source. */
function extractEntitiesFromMermaid(source: string): string[] {
  const sink = makeEntitySink();
  collectMermaidClasses(source, sink);
  collectMermaidAnnotations(source, sink);
  collectMermaidNamespaces(source, sink);

  // Sequence participants and actors, with optional aliases.
  for (const name of extractMermaidParticipants(source)) sink.names.add(name);

  collectMermaidC4(source, sink);
  collectMermaidSubgraphs(source, sink);

  collectMessageCalls(source, sink.addClean);

  return Array.from(sink.names);
}

export function extractEntities(source: string, type: DiagramType): string[] {
  return type === "plantuml"
    ? extractEntitiesFromPlantUml(source)
    : extractEntitiesFromMermaid(source);
}

import type { DiagramType } from "../../types.js";

function* plantUmlLines(source: string): Generator<string> {
  let inComment = false;
  for (const raw of source.split(/\r?\n/)) {
    if (!inComment && raw.trimStart().startsWith("'")) continue;
    const segments: string[] = [];
    let cursor = 0;
    while (cursor < raw.length) {
      if (inComment) {
        const close = raw.indexOf("'/", cursor);
        if (close === -1) break;
        inComment = false;
        cursor = close + 2;
      } else {
        const open = raw.indexOf("/'", cursor);
        segments.push(raw.slice(cursor, open === -1 ? raw.length : open));
        if (open === -1) break;
        inComment = true;
        cursor = open + 2;
      }
    }
    yield segments.join(" ").trim();
  }
}

function* mermaidLines(source: string): Generator<string> {
  for (const raw of source.split(/\r?\n/)) yield raw.split("%%", 1)[0].trim();
}

function* withoutNotes(lines: Iterable<string>): Generator<string> {
  let inNote = false;
  for (const line of lines) {
    if (!line || line.startsWith("'") || line.startsWith("%%")) continue;
    if (inNote) {
      if (/^end\s+note\b/i.test(line)) inNote = false;
      continue;
    }
    if (/^note\b/i.test(line)) {
      // Inline notes carry their text on the header; multiline notes end at `end note`.
      inNote = !/[:"]|end\s+note\b/i.test(line);
      continue;
    }
    yield line;
  }
}

const DIALECT_LINES = { plantuml: plantUmlLines, mermaid: mermaidLines };
const DIALECT_START = { plantuml: /^@startuml(?:\s|$)/, mermaid: /^classDiagram$/ };

export function braceChange(line: string): number {
  // Quoted labels cannot change block scope, even in unsupported declarations.
  const unquoted = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  let change = 0;
  for (const char of unquoted) {
    if (char === "{") change += 1;
    if (char === "}") change -= 1;
  }
  return change;
}

export function* scaffoldDiagramLines(source: string, type: DiagramType): Generator<string> {
  const lines = withoutNotes(DIALECT_LINES[type](source));
  const first = lines.next();
  if (first.done || !DIALECT_START[type].test(first.value)) return;
  yield* lines;
}

export function* topLevelScaffoldLines(source: string, type: DiagramType): Generator<string> {
  let depth = 0;
  for (const line of scaffoldDiagramLines(source, type)) {
    if (depth === 0) yield line;
    depth = Math.max(0, depth + braceChange(line));
  }
}

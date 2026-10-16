import type { DiagramType } from "../../types.js";
import { MAX_ENTITY_NAME_CHARS } from "../../constants.js";

export const MAX_SCAFFOLD_MEMBERS_PER_CLASS = 30;

export interface ScaffoldMember {
  kind: "field" | "method";
  name: string;
  typeLabel?: string;
}

export const MAX_SCAFFOLD_TYPE_LABEL_CHARS = MAX_ENTITY_NAME_CHARS + 2;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_OPEN = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/;
const FORBIDDEN_NAMES = new Set(["constructor", "prototype"]);

function isMemberName(name: string): boolean {
  return (
    name.length <= MAX_ENTITY_NAME_CHARS && IDENTIFIER.test(name) && !FORBIDDEN_NAMES.has(name)
  );
}

function methodName(signature: string, type: DiagramType): string | undefined {
  const open = signature.indexOf("(");
  if (open === -1) return undefined;
  const close = signature.indexOf(")", open + 1);
  if (close < open || close === -1) return undefined;
  const args = signature.slice(open + 1, close);
  if (/[()]/.test(args)) return undefined;
  const suffix = signature
    .slice(close + 1)
    .trim()
    .replace(/^:\s*/, "");
  if (suffix && /\s|[()]/.test(suffix)) return undefined;
  // A colon without a return label is outside the supported signature subset.
  if (signature.slice(close + 1).trim() === ":") return undefined;
  const prefix = signature.slice(0, open).trim().split(/\s+/);
  if (prefix.length === 1) return prefix[0];
  if (type === "plantuml" && prefix.length === 2 && IDENTIFIER.test(prefix[0])) return prefix[1];
  return undefined;
}

function retainTypeLabel(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SCAFFOLD_TYPE_LABEL_CHARS) return undefined;
  return trimmed;
}

function fieldInfo(signature: string): { name: string | undefined; typeLabel?: string } {
  const colon = signature.indexOf(":");
  if (colon !== -1) {
    const rawLabel = signature.slice(colon + 1).trim();
    if (!rawLabel || rawLabel.includes(":")) return { name: undefined };
    return { name: signature.slice(0, colon).trim(), typeLabel: retainTypeLabel(rawLabel) };
  }
  const tokens = signature.split(/\s+/);
  if (tokens.length === 1) return { name: tokens[0] };
  if (tokens.length === 2 && IDENTIFIER.test(tokens[0]))
    return { name: tokens[1], typeLabel: retainTypeLabel(tokens[0]) };
  return { name: undefined };
}

function parseMember(line: string, type: DiagramType): ScaffoldMember | undefined {
  // Only validated names survive; raw labels are retained bounded for typed
  // emission and never reach the unknown/method emitters.
  if (/[{};="'`]/.test(line)) return undefined;
  const signature = line.replace(/^[+\-#~]\s*/, "");
  if (/[()]/.test(signature)) {
    const name = methodName(signature, type);
    return name && isMemberName(name) ? { kind: "method", name } : undefined;
  }
  const field = fieldInfo(signature);
  const name = field.name;
  if (!name || !isMemberName(name)) return undefined;
  return field.typeLabel
    ? { kind: "field", name, typeLabel: field.typeLabel }
    : { kind: "field", name };
}

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

function braceChange(line: string): number {
  // Quoted labels cannot change block scope, even in unsupported declarations.
  const unquoted = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  let change = 0;
  for (const char of unquoted) {
    if (char === "{") change += 1;
    if (char === "}") change -= 1;
  }
  return change;
}

export function extractScaffoldMembers(
  source: string,
  type: DiagramType,
  selected: readonly string[],
): { membersByClass: Map<string, ScaffoldMember[]>; membersCapped: boolean } {
  const membersByClass = new Map(selected.map((name) => [name, [] as ScaffoldMember[]]));
  const lines = withoutNotes(DIALECT_LINES[type](source));
  const first = lines.next();
  if (first.done || !DIALECT_START[type].test(first.value)) {
    return { membersByClass, membersCapped: false };
  }
  let current: ScaffoldMember[] | undefined;
  let membersCapped = false;
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) {
      const opening = CLASS_OPEN.exec(line);
      current = opening ? membersByClass.get(opening[1]) : undefined;
      depth = Math.max(0, braceChange(line));
      continue;
    }
    if (depth === 1 && current && !/[{}]/.test(line)) {
      const member = parseMember(line, type);
      if (member && !current.some((existing) => existing.name === member.name)) {
        if (current.length < MAX_SCAFFOLD_MEMBERS_PER_CLASS) current.push(member);
        else membersCapped = true;
      }
    }
    depth = Math.max(0, depth + braceChange(line));
  }
  return { membersByClass, membersCapped };
}

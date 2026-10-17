import type { DiagramType } from "../../types.js";
import { MAX_ENTITY_NAME_CHARS } from "../../constants.js";
import { braceChange, scaffoldDiagramLines } from "./diagramLines.js";

export const MAX_SCAFFOLD_MEMBERS_PER_CLASS = 30;

export interface ScaffoldMember {
  kind: "field" | "method";
  name: string;
  typeLabel?: string;
}

export const MAX_SCAFFOLD_TYPE_ATOM_CHARS = MAX_ENTITY_NAME_CHARS + 2;
export const MAX_SCAFFOLD_TYPE_LABEL_CHARS = MAX_SCAFFOLD_TYPE_ATOM_CHARS + " | null".length;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_OPEN = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/;
const FORBIDDEN_NAMES = new Set(["constructor", "prototype"]);

export function isScaffoldMemberName(name: string): boolean {
  return (
    name.length <= MAX_ENTITY_NAME_CHARS && IDENTIFIER.test(name) && !FORBIDDEN_NAMES.has(name)
  );
}

function hasSupportedMethodSuffix(suffix: string): boolean {
  const raw = suffix.trim();
  const label = raw.replace(/^:\s*/, "");
  return raw !== ":" && (!label || !/\s|[()]/.test(label));
}

function methodName(signature: string, type: DiagramType): string | undefined {
  const open = signature.indexOf("(");
  if (open === -1) return undefined;
  const close = signature.indexOf(")", open + 1);
  if (close < open) return undefined;
  const args = signature.slice(open + 1, close);
  if (/[()]/.test(args)) return undefined;
  if (!hasSupportedMethodSuffix(signature.slice(close + 1))) return undefined;
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
    return name && isScaffoldMemberName(name) ? { kind: "method", name } : undefined;
  }
  const field = fieldInfo(signature);
  const name = field.name;
  if (!name || !isScaffoldMemberName(name)) return undefined;
  return field.typeLabel
    ? { kind: "field", name, typeLabel: field.typeLabel }
    : { kind: "field", name };
}

function newScaffoldMember(
  line: string,
  type: DiagramType,
  current: readonly ScaffoldMember[],
): ScaffoldMember | undefined {
  const member = parseMember(line, type);
  return member && !current.some((existing) => existing.name === member.name) ? member : undefined;
}

export interface ScaffoldMembersResult {
  membersByClass: Map<string, ScaffoldMember[]>;
  membersCapped: boolean;
}

export function extractScaffoldMembers(
  source: string,
  type: DiagramType,
  selected: readonly string[],
): ScaffoldMembersResult {
  const membersByClass = new Map(selected.map((name) => [name, [] as ScaffoldMember[]]));
  let current: ScaffoldMember[] | undefined;
  let membersCapped = false;
  let depth = 0;
  for (const line of scaffoldDiagramLines(source, type)) {
    if (depth === 0) {
      const opening = CLASS_OPEN.exec(line);
      current = opening ? membersByClass.get(opening[1]) : undefined;
      depth = Math.max(0, braceChange(line));
      continue;
    }
    if (depth === 1 && current && !/[{}]/.test(line)) {
      const member = newScaffoldMember(line, type, current);
      if (member) {
        if (current.length < MAX_SCAFFOLD_MEMBERS_PER_CLASS) current.push(member);
        else membersCapped = true;
      }
    }
    depth = Math.max(0, depth + braceChange(line));
  }
  return { membersByClass, membersCapped };
}

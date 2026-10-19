// Candidate names retain the shared extractor's behavior in all scaffold modes.

import { MAX_ENTITY_NAME_CHARS, MAX_SCAFFOLD_SOURCE_BYTES } from "../../constants.js";
import type { DiagramType } from "../../types.js";
import { extractEntities } from "../consistencyChecker/entities.js";
import {
  MAX_SCAFFOLD_MEMBERS_PER_CLASS,
  extractScaffoldMembers,
  type ScaffoldMember,
  type ScaffoldMembersResult,
} from "./members.js";
import { MAX_SCAFFOLD_RELATIONS, appendScaffoldRelations } from "./relations.js";
import { resolveTypedFieldType } from "./fieldTypes.js";

/** Diagram source larger than the scaffold byte cap. Rejected before extraction. */
export class ScaffoldSourceTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(
      `Diagram source is ${bytes} bytes, larger than the ${limit}-byte limit, ` +
        `so no scaffold was generated. Split or simplify the diagram, then try again.`,
    );
    this.name = "ScaffoldSourceTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

// Conservative identifier blocklist: ECMAScript strict-mode reserved words plus
// TypeScript-forbidden class names (primitive type names, undefined, and the
// strict-mode eval/arguments pair). Syntax alone does not make a class name legal.
const RESERVED_SCAFFOLD_NAMES: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "eval",
  "arguments",
  "any",
  "unknown",
  "never",
  "number",
  "string",
  "boolean",
  "symbol",
  "object",
  "undefined",
  "bigint",
]);

export const SCAFFOLD_HEURISTIC_WARNING =
  "Scaffold names are heuristic entity-name candidates from the diagram " +
  "(declarations, aliases, namespaces, components, participants, and call names " +
  "such as charge), not recovered types. The draft does not recover class kinds, members, " +
  "field types, relations, or runtime behavior. Review every name before saving; remove or " +
  "rename anything that is not a type you intend to implement, then save it as TypeScript yourself.";

export const SCAFFOLD_MEMBERS_HEURISTIC_WARNING =
  "Scaffold members are a heuristic subset from plain class NAME { ... } blocks only " +
  "(bare ASCII names; no quotes, aliases, generics, or stereotypes). Fields emit as " +
  "`name: unknown;` and methods as throwing stubs " +
  "`name(..._args: unknown[]): unknown`, so every type is unknown, argument and return " +
  "labels are ignored, and visibility/static/readonly/abstract modifiers are lost. " +
  "Unsupported lines, note bodies, comments, constructors, initializers, relations, and " +
  "runtime behavior are skipped, never executed or emitted. Review every name and member " +
  "before saving; remove or rename anything you do not intend to implement, then save it " +
  "as TypeScript yourself.";

export const SCAFFOLD_TYPES_HEURISTIC_WARNING =
  "Scaffold field types are a heuristic strict subset from plain class NAME { ... } blocks only " +
  "(bare ASCII names; no quotes, aliases, generics, or stereotypes). Field name and type labels are heuristics; " +
  "only string, number, boolean, bigint, or exactly an emitted class name, optionally with one [] suffix, is emitted as `Atom`; " +
  "one optional null arm in either order canonicalizes to `Atom | null`. Whitespace around arms and the separator is " +
  "allowed but not inside an atom. Array<T> and ReadonlyArray<T> accept one supported base and emit T[] or readonly T[]; " +
  "literal `readonly T[]` is also accepted in colon notation for one supported base. Readonly scalars, nested arrays, " +
  "and other generic forms are not recovered. Every other label falls back to `name: unknown;`. Class references are labels only with no " +
  "supplied runtime value or relations. Methods remain throwing stubs " +
  "`name(..._args: unknown[]): unknown`, so argument and return labels are ignored, and visibility/static/readonly/abstract " +
  "modifiers are lost. Unsupported lines, note bodies, comments, constructors, initializers, relations, and runtime behavior " +
  "are skipped, never executed or emitted. Review every name, member, and type before saving; remove or rename anything you do " +
  "not intend to implement, then save it as TypeScript yourself.";

export const SCAFFOLD_RELATIONS_HEURISTIC_WARNING =
  "Scaffold relations are a heuristic role-label subset from top-level `Owner --> Target : role` lines only " +
  '(bare ASCII names; optional right-target multiplicity "*", "0..*", or "1..*" for Target[]; no other arrows, ' +
  "multiplicities, labels, aliases, generics, or unlabeled relations). Role fields emit as `role!: Target;` or " +
  "`role!: Target[];` with no initializers, constructors, runtime values, or supplied relations; methods remain throwing stubs " +
  "`name(..._args: unknown[]): unknown`. Body field types use the same scalar/emitted-class subset, optionally with one [] " +
  "suffix, and may include one null arm in either order, canonicalized as `Atom | null`. Body fields also accept Array<T> and ReadonlyArray<T> for a supported base, emitted as T[] and readonly T[]. Existing members win name conflicts, and undeclared or non-emitted endpoints are skipped. " +
  "Body field types also accept literal `readonly T[]` in colon notation for one supported base; readonly scalars and nested arrays are unsupported. " +
  "No inheritance, composition, or semantic inference is performed. Unsupported lines, note bodies, comments, and runtime behavior " +
  "are skipped, never executed or emitted. Review every name, member, type, and relation before saving; remove or rename anything you do " +
  "not intend to implement, then save it as TypeScript yourself.";

const SCAFFOLD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when a candidate can be emitted bare as an exported class name. */
function isScaffoldableName(name: string): boolean {
  if (name.length > MAX_ENTITY_NAME_CHARS) return false;
  if (!SCAFFOLD_NAME_PATTERN.test(name)) return false;
  return !RESERVED_SCAFFOLD_NAMES.has(name);
}

interface PartitionedScaffoldCandidates {
  valid: string[];
  skipped: string[];
}

/**
 * Split candidates into emittable names and skipped names. Order is the
 * extractor's order (already deduplicated), and the
 * skipped list is independent of any later emission cap.
 */
function partitionScaffoldCandidates(candidates: string[]): PartitionedScaffoldCandidates {
  const valid: string[] = [];
  const skipped: string[] = [];
  for (const candidate of candidates) {
    if (isScaffoldableName(candidate)) valid.push(candidate);
    else skipped.push(candidate);
  }
  return { valid, skipped };
}

/**
 * Emit one empty exported class per name. Names are already validated, so the
 * emitter does no further filtering. An empty list yields an empty string,
 * never a placeholder class.
 */
function emitScaffoldSource(names: string[]): string {
  if (names.length === 0) return "";
  return `${names.map((name) => `export class ${name} {}`).join("\n\n")}\n`;
}

function emitScaffoldSourceWithMembers(
  names: string[],
  membersByClass: Map<string, ScaffoldMember[]>,
  fieldDeclaration: (member: ScaffoldMember) => string,
): string {
  if (names.length === 0) return "";
  const blocks = names.map((name) => {
    const members = membersByClass.get(name) ?? [];
    if (members.length === 0) return `export class ${name} {}`;
    // A literal cannot be shadowed by diagram classes named Error or globalThis.
    const body = members
      .map((member) =>
        member.kind === "field"
          ? fieldDeclaration(member)
          : `  ${member.name}(..._args: unknown[]): unknown { throw "Not implemented"; }`,
      )
      .join("\n");
    return `export class ${name} {\n${body}\n}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

export interface ScaffoldResult {
  /** Emitted names, capped to the requested limit. */
  entities: string[];
  /** Valid candidates before the cap. */
  entitiesAvailable: number;
  /** True when valid candidates were dropped by the cap. */
  entitiesCapped: boolean;
  /** The applied cap. */
  entityLimit: number;
  /** Invalid candidates, independent of the cap. */
  skippedEntities: string[];
  skippedCount: number;
  /** The emitted TypeScript source; identical to the tool text block. */
  source: string;
}

export interface ScaffoldWithMembersResult extends ScaffoldResult {
  membersIncluded: number;
  membersCapped: boolean;
  memberLimit: number;
}

function assertScaffoldSourceSize(source: string): void {
  const bytes = Buffer.byteLength(source, "utf-8");
  if (bytes > MAX_SCAFFOLD_SOURCE_BYTES) {
    throw new ScaffoldSourceTooLargeError(bytes, MAX_SCAFFOLD_SOURCE_BYTES);
  }
}

/**
 * Build a scaffold from diagram source. The byte cap is enforced on the UTF-8
 * length before extraction, so over-cap input never yields partial output.
 * Candidate order and dedupe come from the shared extractor; the cap applies
 * to valid names only.
 */
export function buildScaffold(
  source: string,
  type: DiagramType,
  maxEntities: number,
): ScaffoldResult {
  assertScaffoldSourceSize(source);
  const candidates = extractEntities(source, type);
  const { valid, skipped } = partitionScaffoldCandidates(candidates);
  const emitted = valid.slice(0, maxEntities);
  return {
    entities: emitted,
    entitiesAvailable: valid.length,
    entitiesCapped: valid.length > emitted.length,
    entityLimit: maxEntities,
    skippedEntities: skipped,
    skippedCount: skipped.length,
    source: emitScaffoldSource(emitted),
  };
}

export function buildScaffoldWithMembers(
  source: string,
  type: DiagramType,
  maxEntities: number,
): ScaffoldWithMembersResult {
  const scaffold = buildScaffold(source, type, maxEntities);
  const { membersByClass, membersCapped } = extractScaffoldMembers(source, type, scaffold.entities);
  return {
    ...scaffold,
    source: emitScaffoldSourceWithMembers(
      scaffold.entities,
      membersByClass,
      unknownFieldDeclaration,
    ),
    membersIncluded: [...membersByClass.values()].reduce(
      (total, members) => total + members.length,
      0,
    ),
    membersCapped,
    memberLimit: MAX_SCAFFOLD_MEMBERS_PER_CLASS,
  };
}

export interface ScaffoldWithTypesResult extends ScaffoldWithMembersResult {
  typedFields: number;
  unresolvedFields: number;
}

function unknownFieldDeclaration(member: ScaffoldMember): string {
  return `  ${member.name}: unknown;`;
}

function typedFieldDeclaration(member: ScaffoldMember, emitted: ReadonlySet<string>): string {
  const resolved = resolveTypedFieldType(member.typeLabel, emitted);
  return resolved ? `  ${member.name}!: ${resolved};` : unknownFieldDeclaration(member);
}

/**
 * Build a typed scaffold from diagram source. Reuses the base candidate flow
 * and the same bounded member parser as the member mode; only field emission
 * resolves the strict scalar/class-name subset, everything else falls back.
 */
export function buildScaffoldWithTypes(
  source: string,
  type: DiagramType,
  maxEntities: number,
): ScaffoldWithTypesResult {
  const scaffold = buildScaffold(source, type, maxEntities);
  const members = extractScaffoldMembers(source, type, scaffold.entities);
  return finalizeTypedScaffold(scaffold, members);
}

export interface ScaffoldWithRelationsResult extends ScaffoldWithTypesResult {
  relationsIncluded: number;
  relationsSkipped: number;
  relationsCapped: boolean;
  relationLimit: number;
}

function finalizeTypedScaffold(
  scaffold: ScaffoldResult,
  { membersByClass, membersCapped }: ScaffoldMembersResult,
): ScaffoldWithTypesResult {
  const emitted = new Set(scaffold.entities);
  let typedFields = 0;
  let unresolvedFields = 0;
  for (const members of membersByClass.values()) {
    for (const member of members) {
      if (member.kind !== "field") continue;
      if (resolveTypedFieldType(member.typeLabel, emitted)) typedFields += 1;
      else unresolvedFields += 1;
    }
  }
  return {
    ...scaffold,
    source: emitScaffoldSourceWithMembers(scaffold.entities, membersByClass, (member) =>
      typedFieldDeclaration(member, emitted),
    ),
    membersIncluded: [...membersByClass.values()].reduce(
      (total, members) => total + members.length,
      0,
    ),
    membersCapped,
    memberLimit: MAX_SCAFFOLD_MEMBERS_PER_CLASS,
    typedFields,
    unresolvedFields,
  };
}

/**
 * Build a typed scaffold with optional named-association fields. Reuses the
 * base candidate flow and a single member parse; relation fields are appended
 * after body members, then the shared typed finalizer emits the result.
 */
export function buildScaffoldWithRelations(
  source: string,
  type: DiagramType,
  maxEntities: number,
): ScaffoldWithRelationsResult {
  const scaffold = buildScaffold(source, type, maxEntities);
  const { membersByClass, membersCapped } = extractScaffoldMembers(source, type, scaffold.entities);
  const relations = appendScaffoldRelations({
    source,
    type,
    entities: scaffold.entities,
    membersByClass,
  });
  const typed = finalizeTypedScaffold(scaffold, {
    membersByClass: relations.membersByClass,
    membersCapped: membersCapped || relations.membersCapped,
  });
  return {
    ...typed,
    relationsIncluded: relations.relationsIncluded,
    relationsSkipped: relations.relationsSkipped,
    relationsCapped: relations.relationsCapped,
    relationLimit: MAX_SCAFFOLD_RELATIONS,
  };
}

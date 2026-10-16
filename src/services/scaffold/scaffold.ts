// Pure code-from-diagram scaffold: heuristic entity names to empty TypeScript classes.
// No filesystem, no rendering, no network, no execution. The candidate list
// comes from the existing diagram entity extractor unchanged, so this module
// never parses a dialect itself; it only filters, caps, and emits.

import { MAX_ENTITY_NAME_CHARS, MAX_SCAFFOLD_SOURCE_BYTES } from "../../constants.js";
import type { DiagramType } from "../../types.js";
import { extractEntities } from "../consistencyChecker/entities.js";

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

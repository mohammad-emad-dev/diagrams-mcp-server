import { MAX_ENTITY_NAME_CHARS } from "../../constants.js";
import { MAX_SCAFFOLD_TYPE_ATOM_CHARS, MAX_SCAFFOLD_TYPE_LABEL_CHARS } from "./members.js";

const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "bigint"]);

// Match the whole label so unsupported syntax cannot become generated TypeScript.
export function resolveTypedFieldType(
  label: string | undefined,
  emitted: ReadonlySet<string>,
): string | undefined {
  if (!label) return undefined;
  const trimmed = label.trim();
  if (trimmed.length > MAX_SCAFFOLD_TYPE_LABEL_CHARS) return undefined;
  const arms = trimmed.split("|");
  if (arms.length === 1) return resolveTypedAtom(trimmed, emitted);
  if (arms.length !== 2) return undefined;
  const [left, right] = arms.map((arm) => arm.trim());
  return resolveNullableType(left, right, emitted);
}

function resolveNullableType(
  left: string,
  right: string,
  emitted: ReadonlySet<string>,
): string | undefined {
  const atomLabel = left === "null" ? right : right === "null" ? left : undefined;
  if (atomLabel === undefined || atomLabel === "null") return undefined;
  const atom = resolveTypedAtom(atomLabel, emitted);
  return atom ? `${atom} | null` : undefined;
}

function resolveTypedAtom(label: string, emitted: ReadonlySet<string>): string | undefined {
  const arrayMatch = /^(Array|ReadonlyArray)<([A-Za-z_][A-Za-z0-9_]*)>$/.exec(label);
  if (arrayMatch) {
    const [, wrapper, element] = arrayMatch;
    const base = resolveSupportedBaseType(element, emitted);
    if (!base) return undefined;
    return wrapper === "ReadonlyArray" ? `readonly ${base}[]` : `${base}[]`;
  }
  if (label.length > MAX_SCAFFOLD_TYPE_ATOM_CHARS) return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/.exec(label);
  if (!match) return undefined;
  const [, base, suffix = ""] = match;
  const resolvedBase = resolveSupportedBaseType(base, emitted);
  return resolvedBase ? `${resolvedBase}${suffix}` : undefined;
}

function resolveSupportedBaseType(base: string, emitted: ReadonlySet<string>): string | undefined {
  if (base.length > MAX_ENTITY_NAME_CHARS) return undefined;
  return SCALAR_TYPES.has(base) || emitted.has(base) ? base : undefined;
}

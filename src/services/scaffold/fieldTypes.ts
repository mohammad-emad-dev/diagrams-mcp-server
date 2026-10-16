import { MAX_SCAFFOLD_TYPE_LABEL_CHARS } from "./members.js";

const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "bigint"]);

// Match the whole label so unsupported syntax cannot become generated TypeScript.
export function resolveTypedFieldType(
  label: string | undefined,
  emitted: ReadonlySet<string>,
): string | undefined {
  if (!label) return undefined;
  const trimmed = label.trim();
  if (trimmed.length > MAX_SCAFFOLD_TYPE_LABEL_CHARS) return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/.exec(trimmed);
  if (!match) return undefined;
  const [, base, suffix = ""] = match;
  return SCALAR_TYPES.has(base) || emitted.has(base) ? `${base}${suffix}` : undefined;
}

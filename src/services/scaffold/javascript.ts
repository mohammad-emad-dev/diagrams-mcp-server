import type { DiagramType } from "../../types.js";
import { buildScaffold, type ScaffoldResult } from "./scaffold.js";

export const SCAFFOLD_JAVASCRIPT_HEURISTIC_WARNING =
  "JavaScript scaffold names are heuristic entity-name candidates from the diagram " +
  "(declarations, aliases, namespaces, components, participants, and call names such as charge), " +
  "not recovered types. The draft emits empty exported JavaScript classes only; it does not recover " +
  "class kinds, members, field types, relations, or runtime behavior. Review every name before " +
  "saving it as JavaScript yourself.";

function emitJavaScriptShells(names: readonly string[]): string {
  if (names.length === 0) return "";
  return `${names.map((name) => `export class ${name} {}`).join("\n\n")}\n`;
}

/** Build bounded empty JavaScript shells from the shared safe candidate flow. */
export function buildJavaScriptScaffold(
  source: string,
  type: DiagramType,
  maxEntities: number,
): ScaffoldResult {
  const scaffold = buildScaffold(source, type, maxEntities);
  return { ...scaffold, source: emitJavaScriptShells(scaffold.entities) };
}

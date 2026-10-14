import type { SideReport } from "./diffInput.js";
import type { diffDiagrams } from "../services/diff/diffDiagram.js";

function listOrNone(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

export function summaryCallOrder(
  order: NonNullable<ReturnType<typeof diffDiagrams>["call_order"]>,
): string {
  return [
    `Recognized message-call order ${order.changed ? "changed" : "unchanged"}.`,
    `  a: ${order.a.length > 0 ? order.a.join(" -> ") : "(none)"}`,
    `  b: ${order.b.length > 0 ? order.b.join(" -> ") : "(none)"}`,
  ].join("\n");
}

export function summaryIdentical(a: SideReport, b: SideReport, unchangedCount: number): string {
  return (
    `No differences between '${a.source}' and '${b.source}': both declare the same ` +
    `${unchangedCount} entity name${unchangedCount === 1 ? "" : "s"} (added, removed, and renamed are all empty).`
  );
}

export function summaryChanged(
  a: SideReport,
  b: SideReport,
  diff: ReturnType<typeof diffDiagrams>,
): string {
  const lines = [
    `Compared '${a.source}' (${a.type}) with '${b.source}' (${b.type}): ${diff.added.length} added, ` +
      `${diff.removed.length} removed, ${diff.renamed.length} renamed, ${diff.unchanged_count} unchanged.`,
    `  added: ${listOrNone(diff.added.map((entry) => entry.name))}`,
    `  removed: ${listOrNone(diff.removed.map((entry) => entry.name))}`,
    `  renamed: ${listOrNone(diff.renamed.map((entry) => `${entry.from} -> ${entry.to} (heuristic)`))}`,
    `  unchanged: ${listOrNone(diff.unchanged)}`,
  ];
  const sequenceFields = [
    ["participants added", diff.participants_added],
    ["participants removed", diff.participants_removed],
    ["calls added", diff.calls_added],
    ["calls removed", diff.calls_removed],
  ] as const;
  // Sequence-only: a class diagram has none of these, so its summary does not
  // list four empty groups.
  if (sequenceFields.some(([, names]) => names.length > 0)) {
    for (const [label, names] of sequenceFields) {
      lines.push(`  ${label}: ${listOrNone(names)}`);
    }
  }
  return lines.join("\n");
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { toPosixPath } from "../constants.js";
import { diffDiagrams } from "../services/diff/diffDiagram.js";
import type { DiffSide } from "../services/diff/diffDiagram.js";
import { detectDiagramType } from "../services/diagramValidator.js";
import { handleToolError } from "./toolError.js";

const INLINE_LABEL = "<inline>";

const HEURISTIC_WARNING =
  "Rename detection is name-similarity, not semantic identity: a removed name pairs with an " +
  "added one only when they are identical once lowercased and stripped of separators, so a " +
  "genuine rename with a different spelling stays an add plus a remove, and a paired rename " +
  "is a candidate, not a verdict. Member lists, layout, and style are never compared, and no " +
  "call-site analysis is done. Treat the result as a review aid, then edit the diagram " +
  "yourself — this tool reports, it does not patch.";

const InputSchema = z
  .object({
    a_relative_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Side a as a stored diagram: path relative to the diagrams root (e.g. 'system/order-flow.puml'). Exactly one of a_relative_path or a_content must be given.",
      ),
    a_content: z
      .string()
      .optional()
      .describe(
        "Side a as inline source text (no file read). Exactly one of a_relative_path or a_content must be given; the dialect is detected from the source itself.",
      ),
    b_relative_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Side b as a stored diagram: path relative to the diagrams root. Exactly one of b_relative_path or b_content must be given.",
      ),
    b_content: z
      .string()
      .optional()
      .describe(
        "Side b as inline source text. Exactly one of b_relative_path or b_content must be given; the dialect is detected from the source itself.",
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

type Side = "a" | "b";

interface SideReport {
  /** POSIX path for a stored side, or "<inline>" for inline source. */
  source: string;
  type: "plantuml" | "mermaid";
}

/** Input-shape error naming every offending side; reported before any file is read. */
function sideShapeErrors(params: Input): string[] {
  const errors: string[] = [];
  for (const side of ["a", "b"] as const) {
    const hasPath = params[`${side}_relative_path`] !== undefined;
    const hasContent = params[`${side}_content`] !== undefined;
    if (hasPath && hasContent) {
      errors.push(
        `Error: Invalid side '${side}': supply exactly one of ${side}_relative_path or ` +
          `${side}_content (both were given).`,
      );
    } else if (!hasPath && !hasContent) {
      errors.push(
        `Error: Invalid side '${side}': supply exactly one of ${side}_relative_path or ` +
          `${side}_content (neither was given).`,
      );
    }
  }
  return errors;
}

/** Dialect of an inline side, detected from its source; null when unrecognizable. */
function inlineDialectErrors(params: Input): string[] {
  const errors: string[] = [];
  for (const side of ["a", "b"] as const) {
    const content = params[`${side}_content`];
    if (content === undefined) continue;
    if (detectDiagramType(content) === null) {
      errors.push(
        `Error: Invalid side '${side}' content: not a recognizable PlantUML or Mermaid ` +
          "diagram. Inline source must start with @startuml and end with @enduml " +
          "(PlantUML) or a known Mermaid diagram declaration; pass " +
          `${side}_relative_path instead to compare a stored diagram.`,
      );
    }
  }
  return errors;
}

/**
 * The dialect of an inline side. inlineDialectErrors has already rejected
 * unrecognizable content before this runs, so the null case is defensive: it
 * surfaces as an unexpected internal error rather than a silent guess.
 */
function inlineType(content: string): "plantuml" | "mermaid" {
  const type = detectDiagramType(content);
  if (type === null) {
    throw new Error("unrecognized inline diagram dialect after shape validation");
  }
  return type;
}

/**
 * Read a side: a stored diagram through the store (which enforces traversal
 * protection, extension gating, and existence), or inline text whose dialect
 * was already validated. Never throws for expected store errors — those go to
 * the caller through handleToolError.
 */
async function readSide(
  ctx: ServerContext,
  side: Side,
  params: Input,
): Promise<{ report: SideReport; sideInput: DiffSide }> {
  const relativePath = params[`${side}_relative_path`];
  if (relativePath !== undefined) {
    const { content, type } = await ctx.diagramStore.read(relativePath);
    return {
      report: { source: toPosixPath(relativePath), type },
      sideInput: { source: content, type },
    };
  }
  const content = params[`${side}_content`] as string;
  const type = inlineType(content);
  return {
    report: { source: INLINE_LABEL, type },
    sideInput: { source: content, type },
  };
}

function listOrNone(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

/** One-line summary when the two sides declare the same names. */
function summaryIdentical(a: SideReport, b: SideReport, unchangedCount: number): string {
  return (
    `No differences between '${a.source}' and '${b.source}': both declare the same ` +
    `${unchangedCount} entity name${unchangedCount === 1 ? "" : "s"} (added, removed, and renamed are all empty).`
  );
}

/** Multi-line summary naming every changed group. */
function summaryChanged(
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

export function registerDiagramsDiff(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_diff",
    {
      title: "Diff Two Diagrams",
      description: `Compare two diagram sources — two stored files, or a stored file against inline text — and report the added, removed, and renamed entity names in structured form.

This is the review-time companion to diagrams_check_consistency: that tool asks whether a diagram still matches the code, this one asks what changed between two versions of the diagram itself. Give it the previous version as a_relative_path or a_content and the new version as the b side, and it lists what a reviewer needs to confirm. It is pure comparison over sources the store already knows how to read: no writes, no network, no filesystem changes.

Each side supplies exactly one of a path or inline content, so unstaged edits can be diffed without a round trip. Rename detection pairs a removed name with an added one only when they are identical once lowercased and stripped of separators, and every rename carries confidence: "heuristic" — similarity is not semantic identity.

Args:
  - a_relative_path (string, optional): Side a as a path relative to the diagrams root
  - a_content (string, optional): Side a as inline source text (dialect detected from the source)
  - b_relative_path (string, optional): Side b as a path relative to the diagrams root
  - b_content (string, optional): Side b as inline source text (dialect detected from the source)
  - Exactly one path or content per side; both or neither is an error naming the side

Returns:
  JSON with schema:
  {
    "a": { "source": string, "type": "plantuml" | "mermaid" },  // path, or "<inline>"
    "b": { "source": string, "type": "plantuml" | "mermaid" },
    "added": [{ "name": string }],                 // declared on b only
    "removed": [{ "name": string }],               // declared on a only
    "renamed": [                                   // paired by the shared name normalizer
      { "from": string, "to": string, "confidence": "heuristic" }
    ],
    "unchanged": string[],                         // declared on both, in a's order
    "unchanged_count": number,
    "participants_added": string[],                // sequence diagrams only; [] otherwise
    "participants_removed": string[],
    "calls_added": string[],
    "calls_removed": string[],
    "is_same": boolean,                            // true iff added, removed, and renamed are all empty
    "confidence": "heuristic",
    "heuristic_warning": string
  }

  A paired rename leaves the added/removed lists, so no change is reported twice. The two sides may use different dialects; each is read with its own syntax.

Examples:
  - Use when: "What changed in this diagram since my last edit?" -> a_relative_path="models/order.puml", b_content="<edited source>"
  - Use when: "Compare the stored diagram against the version in my buffer" -> a_relative_path="system/flow.mmd", b_content="<buffer source>"
  - Don't use when: You want to know whether the diagram still matches the code (use diagrams_check_consistency)
  - Don't use when: You want member-level, layout, or style differences (out of scope; this tool compares declared names only)

Error Handling:
  - Returns "Error: Invalid side 'a'|'b': supply exactly one of ..." when a side supplies both or neither of its path and content
  - Returns "Error: Invalid side 'a'|'b' content: not a recognizable ..." when inline content is neither PlantUML nor Mermaid
  - Returns "Error: No diagram found at '<path>'" when a stored side does not exist
  - Returns "Error: Refused to access path outside the diagrams root" when a stored side attempts to escape the diagrams directory
  - Returns "Error: ... does not have a recognized diagram extension" when a stored path's extension is not .puml/.plantuml/.mmd/.mermaid
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      // Shape and dialect errors are reported before any file is read, so a
      // malformed request touches nothing on disk.
      const shapeErrors = [...sideShapeErrors(params), ...inlineDialectErrors(params)];
      if (shapeErrors.length > 0) {
        return {
          content: [{ type: "text" as const, text: shapeErrors.join(" ") }],
          isError: true,
        };
      }

      try {
        const a = await readSide(ctx, "a", params);
        const b = await readSide(ctx, "b", params);
        const diff = diffDiagrams(a.sideInput, b.sideInput);

        return {
          content: [
            {
              type: "text" as const,
              text: diff.is_same
                ? summaryIdentical(a.report, b.report, diff.unchanged_count)
                : summaryChanged(a.report, b.report, diff),
            },
          ],
          structuredContent: {
            a: a.report,
            b: b.report,
            added: diff.added,
            removed: diff.removed,
            renamed: diff.renamed,
            unchanged: diff.unchanged,
            unchanged_count: diff.unchanged_count,
            participants_added: diff.participants_added,
            participants_removed: diff.participants_removed,
            calls_added: diff.calls_added,
            calls_removed: diff.calls_removed,
            is_same: diff.is_same,
            confidence: "heuristic",
            heuristic_warning: HEURISTIC_WARNING,
          },
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_diff", err);
      }
    },
  );
}

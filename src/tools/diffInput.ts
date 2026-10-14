import { z } from "zod";
import type { ServerContext } from "../context.js";
import { toPosixPath } from "../constants.js";
import type { DiffSide } from "../services/diff/diffDiagram.js";
import { detectDiagramType } from "../services/diagramValidator.js";

const INLINE_LABEL = "<inline>";

export const InputSchema = z
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

export type Input = z.infer<typeof InputSchema>;

type Side = "a" | "b";

export interface SideReport {
  /** POSIX path for a stored side, or "<inline>" for inline source. */
  source: string;
  type: "plantuml" | "mermaid";
}

/** Input-shape error naming every offending side; reported before any file is read. */
export function sideShapeErrors(params: Input): string[] {
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

/** Reject unrecognizable inline sources before either side is read. */
export function inlineDialectErrors(params: Input): string[] {
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
 * was already validated. Expected store errors propagate to the caller for
 * adapter error mapping through handleToolError.
 */
export async function readSide(
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

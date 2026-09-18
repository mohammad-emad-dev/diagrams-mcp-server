import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MAX_ENTITY_NAME_CHARS,
  MAX_TEMPLATE_ENTITIES,
  MAX_TEMPLATE_TITLE_CHARS,
} from "../constants.js";
import { validateDiagramSource } from "../services/diagramValidator.js";
import { emitSkeleton, normalizeTitle } from "../services/templates/skeletons.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    template: z
      .enum(["class", "sequence", "c4_context"])
      .describe(
        "Which starter skeleton to emit: 'class' (a box per entity), 'sequence' (a participant " +
          "per entity), or 'c4_context' (one context-level system per entity). The set is fixed " +
          "at these three; anything else is a schema change, not a value of this enum.",
      ),
    format: z
      .enum(["puml", "mermaid"])
      .default("puml")
      .describe("Output dialect for the skeleton (default: 'puml')."),
    title: z
      .string()
      .max(MAX_TEMPLATE_TITLE_CHARS, {
        message: `title must be at most ${MAX_TEMPLATE_TITLE_CHARS} characters`,
      })
      .refine((value) => /\S/.test(value), {
        message: "title must contain non-whitespace characters",
      })
      .optional()
      .describe(
        `Optional diagram title, at most ${MAX_TEMPLATE_TITLE_CHARS} characters. Whitespace-only ` +
          "is rejected rather than emitting an empty title line. Internal whitespace runs are " +
          "collapsed so the title stays one line, and the normalized value is what the source " +
          "and the structured output report.",
      ),
    entities: z
      .array(
        z
          .string()
          // Refines, not .max/.regex: an ErrMessage can only be a static
          // string, and a rejection has to name the offending name.
          .refine(
            (name) => name.length <= MAX_ENTITY_NAME_CHARS,
            (name) => ({
              message: `entity name '${name}' must be at most ${MAX_ENTITY_NAME_CHARS} characters`,
            }),
          )
          .refine(
            (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
            (name) => ({
              message:
                `entity name '${name}' must be an identifier: a letter or underscore, then ` +
                "letters, digits, or underscores",
            }),
          ),
      )
      .min(1, { message: "entities must contain at least one name" })
      .max(MAX_TEMPLATE_ENTITIES, {
        message: `entities must contain at most ${MAX_TEMPLATE_ENTITIES} names`,
      })
      .superRefine((entities, ctx) => {
        // A duplicate name would emit two declarations of the same box, so the
        // repeat is reported at its own index, not the first occurrence. The
        // path is relative to this array, so [index] reaches entities[index].
        const seen = new Set<string>();
        entities.forEach((name, index) => {
          if (seen.has(name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index],
              message: `duplicate entity name '${name}'`,
            });
          }
          seen.add(name);
        });
      })
      .describe(
        `Entity names to instantiate, 1 to ${MAX_TEMPLATE_ENTITIES} of them, each an identifier ` +
          `matching /^[A-Za-z_][A-Za-z0-9_]*$/ at most ${MAX_ENTITY_NAME_CHARS} characters long, ` +
          "with no duplicates. Names are emitted in the given order, one declaration each.",
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Exported so tests can parse arguments exactly as the server does: the SDK
// runs safeParse on the input schema before the handler sees the arguments,
// which is what applies the default format above.
export const diagramsTemplateInputSchema = InputSchema;

/** Map the wire dialect to the store's diagram type. */
function diagramTypeFor(format: "puml" | "mermaid"): "plantuml" | "mermaid" {
  return format === "puml" ? "plantuml" : "mermaid";
}

/**
 * The one tool that takes no server context: the skeleton tables are pure, so
 * there is no store to read, no project root to resolve, and no state to keep.
 */
export function registerDiagramsTemplate(server: McpServer): void {
  server.registerTool(
    "diagrams_template",
    {
      title: "Instantiate a Diagram Skeleton",
      description: `Emit a minimal, always-valid starter skeleton (class, sequence, or C4-context) in PlantUML or Mermaid, returning source text to fill in and then save with diagrams_create.

The skeleton is pure: no filesystem, no code scanning, no heuristics, no state. The same inputs yield byte-identical source every time, so a skeleton can be requested, dropped, and re-requested without drift. One line per entity, then a TODO hint pointing at where the diagram grows — no member bodies, no styling, no inferred relationships. Those belong to diagrams_generate and your own edits; this is hand-instantiated scaffolding.

It never writes: nothing lands in the diagrams directory without an explicit diagrams_create call, and the emitted source clears the exact syntax gate that tool enforces, so the output can be saved as-is.

The template set is fixed at three: 'class', 'sequence', 'c4_context'. A fourth is a deliberate schema change, not a value to pass in.

Args:
  - template ('class' | 'sequence' | 'c4_context', required): Which starter skeleton to emit
  - format ('puml' | 'mermaid', default 'puml'): Output dialect
  - title (string, optional, at most ${MAX_TEMPLATE_TITLE_CHARS} chars): Diagram title; whitespace-only is rejected, never an empty title line
  - entities (string[], 1-${MAX_TEMPLATE_ENTITIES} items): Entity names, each an identifier matching /^[A-Za-z_][A-Za-z0-9_]*$/ at most ${MAX_ENTITY_NAME_CHARS} chars, no duplicates

Returns:
  JSON with schema:
  {
    "template": "class" | "sequence" | "c4_context",
    "format": "puml" | "mermaid",
    "title": string | null,      // the normalized one-line title, or null when none was given
    "source": string,            // the skeleton; identical to the text block
    "entities": string[],        // the names as accepted, in input order
    "entities_included": number, // length of "entities"
    "deterministic": true,       // always true: no heuristics, no reading of code or disk
    "written": false             // always false; save with diagrams_create
  }

Examples:
  - Use when: "Start a class diagram for the order model" -> template="class", entities=["User","Order"]
  - Use when: "Give me a Mermaid sequence skeleton for these services" -> template="sequence", format="mermaid", entities=["Checkout","Payment"]
  - Use when: "Sketch the C4 context for this system" -> template="c4_context", entities=["Web","Billing"]
  - Don't use when: You want generated content from code (use diagrams_generate or diagrams_generate_sequence)
  - Don't use when: You want a custom template, theme, or member bodies — out of scope; edit the source after saving

Error Handling:
  - Returns "Input validation error: Invalid arguments for tool diagrams_template: <message> at <path>" with isError:true for a template that is missing or not one of the three kinds, an unknown format or key, a title over ${MAX_TEMPLATE_TITLE_CHARS} characters or whitespace-only, an entities array that is empty, longer than ${MAX_TEMPLATE_ENTITIES}, or carries a name over ${MAX_ENTITY_NAME_CHARS} characters, a name that is not an identifier, or a duplicate name; each message names the offending input
  - Emitted source always passes the same syntax gate diagrams_create enforces; an emission that cannot is reported as an unexpected internal error
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
      try {
        // Normalize once: the report carries the same single-line title the
        // source renders, never the raw argument.
        const title = normalizeTitle(params.title);
        const source = emitSkeleton(params.template, params.format, {
          title: title ?? undefined,
          entities: params.entities,
        });

        // Self-check: the skeleton must clear the gate diagrams_create applies,
        // so the caller can hand it straight back and save it unchanged.
        validateDiagramSource(source, diagramTypeFor(params.format));

        const output = {
          template: params.template,
          format: params.format,
          title,
          source,
          entities: params.entities,
          entities_included: params.entities.length,
          deterministic: true as const,
          written: false as const,
        };

        return {
          content: [{ type: "text" as const, text: source }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_template", err);
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import {
  MAX_ENTITY_NAME_CHARS,
  MAX_TEMPLATE_ENTITIES,
  MAX_TEMPLATE_TITLE_CHARS,
  MAX_CUSTOM_TEMPLATE_NAME_CHARS,
  MAX_CUSTOM_TEMPLATE_BYTES,
  MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS,
} from "../constants.js";
import { validateDiagramSource } from "../services/diagramValidator.js";
import { emitSkeleton, normalizeTitle } from "../services/templates/skeletons.js";
import { CustomTemplateError, emitCustomTemplate } from "../services/templates/customTemplates.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    template: z
      .enum(["class", "sequence", "c4_context", "custom"])
      .describe(
        "Which starter skeleton to emit: 'class' (a box per entity), 'sequence' (a participant " +
          "per entity), 'c4_context' (one context-level system per entity), or 'custom' " +
          "(a named JSON template in the project's .diagrams-templates directory).",
      ),
    custom_template: z
      .string()
      .min(1)
      .max(MAX_CUSTOM_TEMPLATE_NAME_CHARS)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional()
      .describe(
        "Custom template identifier without extension or path; required only when template is 'custom'.",
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

async function templateSource(
  params: Input,
  ctx: ServerContext | undefined,
  title: string | null,
): Promise<string> {
  if (params.template === "custom") {
    if (!params.custom_template)
      throw new CustomTemplateError("custom_template is required when template is 'custom'.");
    if (!ctx) throw new CustomTemplateError("Custom templates require a configured project root.");
    return emitCustomTemplate({
      projectRoot: ctx.codeRootDir,
      name: params.custom_template,
      format: params.format,
      title,
      entities: params.entities,
    });
  }
  if (params.custom_template !== undefined)
    throw new CustomTemplateError("custom_template is only supported when template is 'custom'.");
  return emitSkeleton(params.template, params.format, {
    title: title ?? undefined,
    entities: params.entities,
  });
}

/**
 * Built-in templates need no context. Custom templates read under the supplied project root.
 */
export function registerDiagramsTemplate(server: McpServer, ctx?: ServerContext): void {
  server.registerTool(
    "diagrams_template",
    {
      title: "Instantiate a Diagram Skeleton",
      description: `Emit a built-in starter skeleton (class, sequence, or C4-context) or a custom project template in PlantUML or Mermaid, returning validated source text to fill in and then save with diagrams_create.

Built-in skeletons are pure and require no filesystem or code scan. Custom templates read one named JSON file under PROJECT_ROOT/.diagrams-templates; identical inputs and file contents yield identical source. No template evaluates code or fetches remote resources.

It never writes: nothing lands in the diagrams directory without an explicit diagrams_create call, and the emitted source clears the exact syntax gate that tool enforces, so the output can be saved as-is.

The three built-in kinds are 'class', 'sequence', and 'c4_context'. Use 'custom' with custom_template to load <name>.json. The selected 'puml' or 'mermaid' object must contain 'source' and 'entity' strings. Source placeholders are {{title}} and {{entities}}; entity patterns support {{name}}. Reads are limited to ${MAX_CUSTOM_TEMPLATE_BYTES} bytes and expansion to ${MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS} JavaScript string characters. Files must be regular files inside the template directory; symlinks, unknown fields, and unsupported placeholders are rejected.

Args:
  - template ('class' | 'sequence' | 'c4_context' | 'custom', required): Which starter skeleton to emit
  - custom_template (string, required only for custom): Identifier without path or extension, 1-${MAX_CUSTOM_TEMPLATE_NAME_CHARS} letters, digits, underscores or hyphens
  - format ('puml' | 'mermaid', default 'puml'): Output dialect
  - title (string, optional, at most ${MAX_TEMPLATE_TITLE_CHARS} chars): Diagram title; whitespace-only is rejected, never an empty title line
  - entities (string[], 1-${MAX_TEMPLATE_ENTITIES} items): Entity names, each an identifier matching /^[A-Za-z_][A-Za-z0-9_]*$/ at most ${MAX_ENTITY_NAME_CHARS} chars, no duplicates

Returns:
  JSON with schema:
  {
    "template": "class" | "sequence" | "c4_context" | "custom",
    "custom_template": string,   // present only for custom templates
    "format": "puml" | "mermaid",
    "title": string | null,      // the normalized one-line title, or null when none was given
    "source": string,            // the skeleton; identical to the text block
    "entities": string[],        // the names as accepted, in input order
    "entities_included": number, // length of "entities"
    "deterministic": true,       // same inputs and template contents yield the same source
    "written": false             // always false; save with diagrams_create
  }

Examples:
  - Use when: "Start a class diagram for the order model" -> template="class", entities=["User","Order"]
  - Use when: "Give me a Mermaid sequence skeleton for these services" -> template="sequence", format="mermaid", entities=["Checkout","Payment"]
  - Use when: "Sketch the C4 context for this system" -> template="c4_context", entities=["Web","Billing"]
  - Don't use when: You want generated content from code (use diagrams_generate or diagrams_generate_sequence)
  - Use when: "Use our team skeleton" -> template="custom", custom_template="team-model", entities=["User"]

Error Handling:
  - Input validation rejects unknown kinds/formats/keys, invalid custom identifiers, over-limit or whitespace-only titles, and invalid/duplicate/over-limit entity names
  - CustomTemplateError messages explain missing custom_template, invalid built-in/custom combinations, unreadable or invalid JSON files, unsupported dialects/placeholders, and read/expansion limits without exposing absolute paths
  - Emitted source passes the same syntax gate diagrams_create enforces; invalid template output returns a diagram validation error
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
        const source = await templateSource(params, ctx, title);

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
          ...(params.template === "custom" ? { custom_template: params.custom_template } : {}),
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

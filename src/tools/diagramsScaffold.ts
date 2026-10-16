import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import {
  MAX_ENTITY_NAME_CHARS,
  MAX_GENERATE_ENTITIES,
  MAX_SCAFFOLD_SOURCE_BYTES,
  toPosixPath,
} from "../constants.js";
import { buildScaffold, SCAFFOLD_HEURISTIC_WARNING } from "../services/scaffold/scaffold.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe("Path to the diagram to scaffold from, relative to the diagrams root."),
    max_entities: z
      .number()
      .int()
      .min(1)
      .max(MAX_GENERATE_ENTITIES)
      .default(30)
      .describe(
        `Hard cap on emitted TypeScript classes, an integer between 1 and ${MAX_GENERATE_ENTITIES} (default: 30). ` +
          `The applied cap is reported as entity_limit; anything past it is counted in entities_available and flagged by entities_capped.`,
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Exported so tests can parse arguments exactly as the server does: the SDK
// runs safeParse on the input schema before the handler sees the arguments,
// which is what applies the default above.
export const diagramsScaffoldInputSchema = InputSchema;

export function registerDiagramsScaffold(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_scaffold",
    {
      title: "Scaffold TypeScript Classes from a Diagram",
      description: `Draft empty exported TypeScript classes from the entity-name candidates in a stored PlantUML or Mermaid diagram, returning source text to review and then save yourself.

This reads heuristic entity-name candidates through the existing extractor unchanged, so candidates may include aliases, namespaces, components, participants, and call names such as charge. It does NOT recover class kinds, members, field types, relations, or runtime behavior. Every result says so with confidence "heuristic" plus a heuristic_warning; review the draft before saving it as TypeScript yourself.

It never writes, renders, fetches, or executes: one traversal-protected store read, pure filtering and emission, no new dependencies. Nothing lands outside the response until you save it with an explicit write.

Args:
  - relative_path (string, required): Path to the diagram, relative to the diagrams root
  - max_entities (integer 1-${MAX_GENERATE_ENTITIES}, default 30): Hard cap on emitted classes

Returns:
  JSON with schema:
  {
    "relative_path": string,             // POSIX form
    "language": "typescript",
    "source": string,                    // the scaffold; identical to the text block ("" when no emittable names)
    "entities": string[],                // emitted class names in candidate order, capped
    "entities_included": number,         // length of "entities"
    "entities_available": number,        // valid candidates before the cap
    "entities_capped": boolean,          // true when valid names were dropped by the cap
    "entity_limit": number,              // the applied cap (max_entities, at most ${MAX_GENERATE_ENTITIES})
    "skipped_entities": string[],        // invalid or reserved candidates, independent of the cap
    "skipped_count": number,             // length of "skipped_entities"
    "confidence": "heuristic",
    "heuristic_warning": string,         // candidate-only limitations; review the draft before saving
    "written": false                     // always false; save the source yourself
  }

  Names are emitted only when they match /^[A-Za-z_][A-Za-z0-9_]*$/ at most ${MAX_ENTITY_NAME_CHARS} characters and avoid reserved and TypeScript-forbidden class names. Other candidates are listed in skipped_entities without further renaming. An empty candidate set returns empty source.

Examples:
  - Use when: "Draft class shells for the names in this diagram" -> relative_path="models/order.puml"
  - Use when: "Give me TypeScript stubs for the Mermaid model" -> relative_path="models/order.mmd", max_entities=10
  - Don't use when: You want members, types, or relations (out of scope; this emits empty classes only)
  - Don't use when: You want a diagram from code (use diagrams_generate)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the diagram does not exist, before any extraction
  - Returns "Error: Refused to access path outside the diagrams root" if relative_path attempts to escape the diagrams directory
  - Returns "Error: ... does not have a recognized diagram extension ..." when the path has no diagram extension
  - Returns "Error: Diagram source is <n> bytes, larger than the ${MAX_SCAFFOLD_SOURCE_BYTES}-byte limit ..." when the stored source exceeds the byte cap; nothing partial is returned
  - An empty candidate set is not an error: source is "" with entities [] and the heuristic warning still explains the limitation
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const { content, type } = await ctx.diagramStore.read(params.relative_path);

        const built = buildScaffold(content, type, params.max_entities);
        const output = {
          relative_path: toPosixPath(params.relative_path),
          language: "typescript" as const,
          source: built.source,
          entities: built.entities,
          entities_included: built.entities.length,
          entities_available: built.entitiesAvailable,
          entities_capped: built.entitiesCapped,
          entity_limit: built.entityLimit,
          skipped_entities: built.skippedEntities,
          skipped_count: built.skippedCount,
          confidence: "heuristic" as const,
          heuristic_warning: SCAFFOLD_HEURISTIC_WARNING,
          written: false as const,
        };

        return {
          content: [{ type: "text" as const, text: built.source }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_scaffold", err);
      }
    },
  );
}

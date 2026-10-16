import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import {
  MAX_ENTITY_NAME_CHARS,
  MAX_GENERATE_ENTITIES,
  MAX_SCAFFOLD_SOURCE_BYTES,
  toPosixPath,
} from "../constants.js";
import {
  buildScaffold,
  buildScaffoldWithMembers,
  SCAFFOLD_HEURISTIC_WARNING,
  SCAFFOLD_MEMBERS_HEURISTIC_WARNING,
} from "../services/scaffold/scaffold.js";
import { MAX_SCAFFOLD_MEMBERS_PER_CLASS } from "../services/scaffold/members.js";
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
    include_members: z
      .boolean()
      .default(false)
      .describe(
        "Opt-in heuristic member stubs from plain class NAME { ... } blocks only (default: false). " +
          "False keeps empty classes with no new keys; true adds throwing stubs plus members metadata.",
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

This reads heuristic entity-name candidates through the existing extractor unchanged, so candidates may include aliases, namespaces, components, participants, and call names such as charge. By default (include_members=false) it does NOT recover class kinds, members, field types, relations, or runtime behavior. Every result says so with confidence "heuristic" plus a heuristic_warning; review the draft before saving it as TypeScript yourself.

With include_members=true, simple top-level multiline class NAME { blocks can add member stubs. Names must be bare ASCII identifiers; quoted, aliased, generic, nested, or decorated classes are outside this subset. The first substantive line must be @startuml (PlantUML) or classDiagram (Mermaid).

Supported members: optional +, -, #, or ~ visibility; fields name: Type, Type name, or bare name; methods name(args) with an optional single-token return label, or PlantUML Type name(args). Fields become unknown; methods accept ..._args: unknown[], return unknown, and throw the literal "Not implemented". Argument names, types, modifiers, and bodies are not recovered. Member names use the same ASCII identifier grammar and length cap as class names; constructor and prototype are excluded. Duplicate names keep their first occurrence across field/method collisions and repeated class blocks.

Unsupported syntax is skipped, including constructors, initializers, implementation bodies, relationships, and external Class : member notation. Whole-line comments, PlantUML block comments, and note bodies are ignored. Each emitted class receives at most ${MAX_SCAFFOLD_MEMBERS_PER_CLASS} members; members_capped reports an additional recognized unique name beyond that limit. This is a heuristic subset, not a full parser.

It never writes, renders, fetches, or executes: one traversal-protected store read, pure filtering and emission, no new dependencies. Nothing lands outside the response until you save it with an explicit write. Still read-only with include_members=true.

Args:
  - relative_path (string, required): Path to the diagram, relative to the diagrams root
  - max_entities (integer 1-${MAX_GENERATE_ENTITIES}, default 30): Hard cap on emitted classes
  - include_members (boolean, default false): Opt-in heuristic member stubs plus members metadata

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
    "heuristic_warning": string,         // candidate-only limitations by default; member-mode limitations when include_members=true
    "written": false,                    // always false; save the source yourself
    // include_members=true only:
    // "include_members": true,
    // "members_included": number,       // total emitted field+method stubs across emitted classes
    // "members_capped": boolean,        // true when a 31st unique supported member was found
    // "member_limit": ${MAX_SCAFFOLD_MEMBERS_PER_CLASS}  // fixed per-class member cap
  }

  Names are emitted only when they match /^[A-Za-z_][A-Za-z0-9_]*$/ at most ${MAX_ENTITY_NAME_CHARS} characters and avoid reserved and TypeScript-forbidden class names. Other candidates are listed in skipped_entities without further renaming. An empty candidate set returns empty source.

Examples:
  - Use when: "Draft class shells for the names in this diagram" -> relative_path="models/order.puml"
  - Use when: "Give me TypeScript stubs for the Mermaid model" -> relative_path="models/order.mmd", max_entities=10
  - Use when: "Draft shells with heuristic member stubs" -> relative_path="models/order.puml", include_members=true
  - Don't use when: You want full members, types, or relations (out of scope; default emits empty classes only, opt-in emits heuristic unknown-typed throwing stubs only)
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

        const memberDraft = params.include_members
          ? buildScaffoldWithMembers(content, type, params.max_entities)
          : undefined;
        const built = memberDraft ?? buildScaffold(content, type, params.max_entities);
        const base = {
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
          heuristic_warning: params.include_members
            ? SCAFFOLD_MEMBERS_HEURISTIC_WARNING
            : SCAFFOLD_HEURISTIC_WARNING,
          written: false as const,
        };
        const output = memberDraft
          ? {
              ...base,
              include_members: true as const,
              members_included: memberDraft.membersIncluded,
              members_capped: memberDraft.membersCapped,
              member_limit: memberDraft.memberLimit,
            }
          : base;

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

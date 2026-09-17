import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_GENERATE_ENTITIES, MAX_GENERATE_RELATIONS, toPosixPath } from "../constants.js";
import type { GenerateDeps } from "../services/generate/collectEntities.js";
import { collectScopeEntities } from "../services/generate/collectEntities.js";
import { emitDiagram } from "../services/generate/emitters.js";
import { MAX_SCAN_FILES } from "../services/consistencyChecker/scanning.js";
import { validateDiagramSource } from "../services/diagramValidator.js";
import { resolveScope } from "../services/scopeResolve.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    scope: z
      .string()
      .min(1)
      .default(".")
      .describe(
        "Relative path under the project root pointing at a file or a directory to read " +
          "(default: '.', the whole project root). Absolute paths and anything that resolves " +
          "outside the project root are refused.",
      ),
    format: z
      .enum(["puml", "mermaid"])
      .default("puml")
      .describe("Output dialect for the generated class diagram (default: 'puml')."),
    max_entities: z
      .number()
      .int()
      .min(1)
      .max(MAX_GENERATE_ENTITIES)
      .default(30)
      .describe(
        `Hard cap on emitted class/interface declarations, an integer between 1 and ${MAX_GENERATE_ENTITIES} (default: 30). ` +
          `The applied cap is reported as entity_limit; anything past it is counted in entities_available and flagged by entities_capped.`,
      ),
    include_relations: z
      .boolean()
      .default(true)
      .describe(
        "Emit 'A <|-- B' / 'A <|.. B' extends/implements edges when relation evidence is " +
          "available (default: true). Relations are read from TypeScript heritage clauses only, " +
          "so a scope without TypeScript-family files emits an empty relations list with a dialect_note.",
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Exported so tests can parse arguments exactly as the server does: the SDK
// runs safeParse on the input schema before the handler sees the arguments,
// which is what applies the defaults above.
export const diagramsGenerateInputSchema = InputSchema;

const HEURISTIC_WARNING =
  "Entity names come from declaration patterns and, when the TypeScript compiler is " +
  "installed, from the AST; there is no type resolution and no cross-file inheritance through " +
  "re-exports. Member lists, generics, and namespaces are not emitted, and a name here is " +
  "evidence of a declaration, not a modeled type. Treat the result as a draft to review, " +
  "then save it with diagrams_create.";

/** Map the wire dialect to the store's diagram type. */
function diagramTypeFor(format: "puml" | "mermaid"): "plantuml" | "mermaid" {
  return format === "puml" ? "plantuml" : "mermaid";
}

export function registerDiagramsGenerate(
  server: McpServer,
  ctx: ServerContext,
  deps: GenerateDeps = {},
): void {
  server.registerTool(
    "diagrams_generate",
    {
      title: "Generate a Class Diagram from Code",
      description: `Draft a PlantUML or Mermaid class diagram from a slice of the codebase, returning source text to review and then save with diagrams_create.

This is the generative flip side of diagrams_check_consistency: the same code-reading machinery that detects drift can seed the diagram in the first place. It reads class/interface/enum/type/function declarations under the requested scope and emits one box per declared name, plus extends/implements edges when the TypeScript AST can evidence them. It never writes: nothing lands in the diagrams directory without an explicit diagrams_create call.

It is a heuristic (name extraction, not full type modeling) and says so in every result: member lists, generics, package nesting, and cross-file inheritance through re-exports are out of scope, and a scope without TypeScript-family files yields entities with no relations.

Args:
  - scope (string, default "."): Relative path under the project root pointing at a file or a directory. Absolute paths and anything resolving outside the project root are refused
  - format ('puml' | 'mermaid', default 'puml'): Output dialect
  - max_entities (integer 1-${MAX_GENERATE_ENTITIES}, default 30): Hard cap on emitted declarations
  - include_relations (boolean, default true): Emit extends/implements edges when evidence is available

Returns:
  JSON with schema:
  {
    "scope": string,               // POSIX path as resolved, "." for the project root
    "format": "puml" | "mermaid",
    "source": string,              // the generated diagram; identical to the text block
    "entities": string[],          // declared names in emission order, capped
    "entities_included": number,   // length of "entities"
    "entities_available": number,  // distinct names found, may exceed the cap
    "entities_capped": boolean,    // true when names were dropped by the cap
    "entity_limit": number,        // the applied cap (max_entities, at most ${MAX_GENERATE_ENTITIES})
    "relations": [                 // evidenced edges only; empty when evidence is unavailable
      { "from": string, "to": string, "kind": "extends" | "implements" }
    ],
    "relations_included": number,
    "relations_available": number,
    "relations_capped": boolean,   // true when edges were dropped by the cap or by an entity the cap removed
    "relation_limit": number,      // ${MAX_GENERATE_RELATIONS}
    "files_scanned": number,
    "truncated": boolean,          // true when the ${MAX_SCAN_FILES.toLocaleString()}-file scan cap was reached
    "scan_limit": number,          // ${MAX_SCAN_FILES.toLocaleString()}
    "scan_warning": string | null, // human-readable warning when truncated, otherwise null
    "dialect_note": string | null, // non-null when relations are unavailable or the scope has no code files
    "confidence": "heuristic",
    "heuristic_warning": string,   // what name extraction can and cannot tell you
    "written": false               // always false; save with diagrams_create
  }

  Every cap reports itself in-band, so a truncated or capped result is never silent.

Examples:
  - Use when: "Draft a class diagram for the services layer" -> scope="src/services"
  - Use when: "Give me a Mermaid starter for this module" -> scope="src/models", format="mermaid"
  - Don't use when: You want a hand-written skeleton instead of one read from code (write the source directly, or use diagrams_create)
  - Don't use when: You expect semantic accuracy (member types, generics, or resolved cross-file inheritance); this is a heuristic draft

Error Handling:
  - Returns "Error: Refused to resolve scope outside the project root: '<scope>'" when scope is absolute or resolves outside the project root; no file is read
  - A scope with no code files is not an error: entities is empty with a dialect_note explaining why
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
        // Resolve the scope before any read: a refusal must touch no file.
        const scope = resolveScope(ctx.codeRootDir, params.scope);

        // The schema already bounds max_entities at MAX_GENERATE_ENTITIES; the
        // clamp keeps that invariant honest if the two ever drift apart.
        const entityLimit = Math.min(params.max_entities, MAX_GENERATE_ENTITIES);

        const collected = await collectScopeEntities(scope.absolutePath, {
          includeRelations: params.include_relations,
          maxEntities: entityLimit,
          maxRelations: MAX_GENERATE_RELATIONS,
          deps,
        });

        const diagramType = diagramTypeFor(params.format);
        const { source } = emitDiagram(diagramType, collected.entities, collected.relations);
        // Self-check: the emitted source must clear the same gate
        // diagrams_create enforces, so the output can be saved as-is.
        validateDiagramSource(source, diagramType);

        const output = {
          scope: toPosixPath(scope.relativePath),
          format: params.format,
          source,
          entities: collected.entities,
          entities_included: collected.entities.length,
          entities_available: collected.entitiesAvailable,
          entities_capped: collected.entitiesDropped > 0,
          entity_limit: entityLimit,
          relations: collected.relations,
          relations_included: collected.relations.length,
          relations_available: collected.relationsAvailable,
          relations_capped: collected.relationsDropped > 0,
          relation_limit: MAX_GENERATE_RELATIONS,
          files_scanned: collected.filesScanned,
          truncated: collected.truncated,
          scan_limit: collected.scanLimit,
          scan_warning: collected.scanWarning,
          dialect_note: collected.dialectNote,
          confidence: "heuristic" as const,
          heuristic_warning: HEURISTIC_WARNING,
          written: false as const,
        };

        return {
          content: [{ type: "text" as const, text: source }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_generate", err);
      }
    },
  );
}

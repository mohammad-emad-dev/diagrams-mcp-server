import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { toPosixPath } from "../constants.js";
import { DiagramNotFoundError } from "../services/diagramStore.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe("Path to the existing diagram, relative to the diagrams root."),
    content: z
      .string()
      .min(1)
      .describe("New full PlantUML or Mermaid source text that replaces the existing content."),
    create_if_missing: z
      .boolean()
      .default(false)
      .describe(
        "If true and no diagram exists at relative_path, create it instead of failing (default: false).",
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerDiagramsUpdate(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_update",
    {
      title: "Update Existing Diagram",
      description: `Replace the full content of an existing PlantUML or Mermaid diagram file.

This performs a full-content replace, not a partial edit — pass the complete new diagram source. To create a new diagram, use diagrams_create (or set create_if_missing=true here).

Performs a basic, dependency-free syntax check before writing (not full validation): PlantUML must include @startuml/@enduml boundaries; Mermaid must start with a known diagram declaration. Clearly invalid or empty sources are rejected without overwriting the existing file.

Args:
  - relative_path (string): Path to the diagram, relative to the diagrams root
  - content (string): Full new diagram source text
  - create_if_missing (boolean): Create the file instead of erroring if it doesn't exist (default: false)

Returns:
  JSON with schema:
  {
    "relative_path": string,
    "updated": true
  }

Examples:
  - Use when: "Add a new field to the User class diagram" -> read current content with diagrams_get first, then call diagrams_update with the modified full content
  - Don't use when: The file doesn't exist yet and you don't want auto-creation (use diagrams_create)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the file doesn't exist and create_if_missing is false
  - Returns "Error: ... does not have a recognized diagram extension" if the extension isn't recognized
  - Returns "Error: Invalid PlantUML diagram (basic check): ..." if PlantUML source is empty or missing @startuml/@enduml boundaries (original file left unchanged)
  - Returns "Error: Invalid Mermaid diagram (basic check): ..." if Mermaid source is empty or has no recognized diagram declaration (original file left unchanged)
  - Returns "Error: Refused to access path outside the diagrams root" if relative_path attempts to escape the diagrams directory
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const alreadyExists = await ctx.diagramStore.exists(params.relative_path);
        if (!alreadyExists && !params.create_if_missing) {
          throw new DiagramNotFoundError(params.relative_path);
        }
        await ctx.diagramStore.write(params.relative_path, params.content, {
          overwrite: true,
        });
        const output = {
          relative_path: toPosixPath(params.relative_path),
          updated: true,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated diagram at '${toPosixPath(params.relative_path)}'.`,
            },
          ],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_update", err);
      }
    },
  );
}

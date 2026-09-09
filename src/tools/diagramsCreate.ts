import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { toPosixPath } from "../constants.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe(
        "Path for the new diagram, relative to the diagrams root, including extension (.puml, .plantuml, .mmd, or .mermaid). E.g. 'system/order-flow.puml'.",
      ),
    content: z.string().min(1).describe("Full PlantUML or Mermaid source text for the diagram."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerDiagramsCreate(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_create",
    {
      title: "Create New Diagram",
      description: `Create a new PlantUML or Mermaid diagram file under the diagrams root.

The diagram type is inferred from the file extension in relative_path:
  - .puml or .plantuml -> PlantUML
  - .mmd or .mermaid -> Mermaid

This tool refuses to overwrite an existing file — use diagrams_update for that. Intermediate directories in relative_path are created automatically.

Performs a basic, dependency-free syntax check before writing (not full validation): PlantUML must include @startuml/@enduml boundaries; Mermaid must start with a known diagram declaration. Clearly invalid or empty sources are rejected without creating a file.

Args:
  - relative_path (string): Path for the new file, relative to the diagrams root, with a recognized extension
  - content (string): Full diagram source text

Returns:
  JSON with schema:
  {
    "relative_path": string,
    "created": true
  }

Examples:
  - Use when: "Create a class diagram for the User model" -> relative_path="models/user-class.puml", content="@startuml\\nclass User {\\n  +id: int\\n}\\n@enduml"
  - Don't use when: The file already exists and you want to change it (use diagrams_update instead)

Error Handling:
  - Returns "Error: ... already exists" if a file already exists at relative_path
  - Returns "Error: ... does not have a recognized diagram extension" if the extension isn't one of .puml/.plantuml/.mmd/.mermaid
  - Returns "Error: Invalid PlantUML diagram (basic check): ..." if PlantUML source is empty or missing @startuml/@enduml boundaries
  - Returns "Error: Invalid Mermaid diagram (basic check): ..." if Mermaid source is empty or has no recognized diagram declaration
  - Returns "Error: Refused to access path outside the diagrams root" if relative_path attempts to escape the diagrams directory
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        await ctx.diagramStore.write(params.relative_path, params.content, {
          overwrite: false,
        });
        const output = {
          relative_path: toPosixPath(params.relative_path),
          created: true,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Created diagram at '${toPosixPath(params.relative_path)}'.`,
            },
          ],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_create", err);
      }
    },
  );
}

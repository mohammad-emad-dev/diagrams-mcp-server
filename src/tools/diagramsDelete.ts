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
        "Path to the diagram to delete, relative to the diagrams root (e.g. 'system/order-flow.puml'). Get this from diagrams_list.",
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerDiagramsDelete(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_delete",
    {
      title: "Delete Diagram",
      description: `Delete a single PlantUML or Mermaid diagram file from the diagrams root.

This is destructive and cannot be undone — the file is removed from disk. To replace content instead, use diagrams_update. To remove then recreate with different content, delete first, then use diagrams_create.

Args:
  - relative_path (string): Path to the diagram relative to the diagrams root, as returned by diagrams_list

Returns:
  JSON with schema:
  {
    "relative_path": string,
    "deleted": true
  }

Examples:
  - Use when: "Remove the outdated order-flow diagram" -> relative_path="system/order-flow.puml"
  - Don't use when: You want to change the diagram content but keep the file (use diagrams_update)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the file doesn't exist
  - Returns "Error: Refused to access path outside the diagrams root" if relative_path attempts to escape the diagrams directory (e.g. via '../..')
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        await ctx.diagramStore.delete(params.relative_path);
        const output = {
          relative_path: toPosixPath(params.relative_path),
          deleted: true,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted diagram at '${toPosixPath(params.relative_path)}'.`,
            },
          ],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_delete", err);
      }
    },
  );
}

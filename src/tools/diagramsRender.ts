import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { toPosixPath } from "../constants.js";
import type { DiagramType } from "../types.js";
import { renderDiagram } from "../services/renderer.js";
import { handleRenderError, handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe("Path to the diagram to render, relative to the diagrams root."),
    format: z.enum(["svg", "png"]).default("svg").describe("Output image format (default: 'svg')."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerDiagramsRender(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_render",
    {
      title: "Render Diagram to Image",
      description: `Render a PlantUML or Mermaid diagram to an image (SVG or PNG) and return it as base64-encoded image content.

Rendering requirements:
  - Mermaid: requires the 'mmdc' CLI (install with: npm install -g @mermaid-js/mermaid-cli). No fallback exists.
  - PlantUML: uses a local 'plantuml' CLI if installed. Without one, rendering fails unless remote rendering is explicitly enabled with ALLOW_REMOTE_PLANTUML=true, in which case it falls back to the configured PlantUML rendering server over HTTPS (requires internet access; sends diagram source to that server). DISABLE_REMOTE_PLANTUML=true always disables the fallback, even when the allow flag is set.

Args:
  - relative_path (string): Path to the diagram, relative to the diagrams root
  - format ('svg' | 'png'): Output image format (default: 'svg')

Returns:
  An image content block (base64-encoded), plus a JSON summary:
  {
    "relative_path": string,
    "format": "svg" | "png",
    "rendered": true
  }

Examples:
  - Use when: "Show me what the order-flow diagram looks like" -> relative_path="system/order-flow.puml", format="svg"
  - Don't use when: You just need the raw source text (use diagrams_get instead, it's much cheaper)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the file doesn't exist
  - Returns "Error: Mermaid rendering requires the 'mmdc' CLI..." if rendering a Mermaid diagram without mmdc installed
  - Returns "Error: PlantUML rendering requires a local 'plantuml' CLI..." when no local CLI is installed and remote rendering is not explicitly enabled (set ALLOW_REMOTE_PLANTUML=true to opt in)
  - Returns "Error: PlantUML rendering server responded with <status>..." if both local and remote PlantUML rendering fail
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      let content: string;
      let type: DiagramType;
      try {
        ({ content, type } = await ctx.diagramStore.read(params.relative_path));
      } catch (err: unknown) {
        return handleToolError("diagrams_render", err);
      }
      try {
        const imageBuffer = await renderDiagram(content, type, params.format);
        const base64 = imageBuffer.toString("base64");
        const mimeType = params.format === "svg" ? "image/svg+xml" : "image/png";

        const output = {
          relative_path: toPosixPath(params.relative_path),
          format: params.format,
          rendered: true,
        };

        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType,
            },
          ],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleRenderError("diagrams_render", err);
      }
    },
  );
}

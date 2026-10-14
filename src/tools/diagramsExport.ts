import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_EXPORT_HTML_BYTES, toPosixPath } from "../constants.js";
import type { DiagramType } from "../types.js";
import { buildExportBundle } from "../services/export/htmlBundle.js";
import { renderDiagramWithProvenance } from "../services/renderer.js";
import type { RenderResult } from "../services/renderer.js";
import { handleRenderError, handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe("Path to the diagram to export, relative to the diagrams root."),
    include_source: z
      .boolean()
      .default(true)
      .describe(
        "Embed the diagram source in a collapsible block so the artifact explains " +
          "itself (default: true). The block is a native <details> element, so it " +
          "works without JavaScript.",
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Exported so tests can parse arguments exactly as the server does: the SDK
// runs safeParse on the input schema before the handler sees the arguments,
// which is what applies the default include_source above.
export const diagramsExportInputSchema = InputSchema;

interface ExportResponseRequest {
  params: Input;
  source: string;
  type: DiagramType;
  rendered: RenderResult;
}

function formatExportResponse({ params, source, type, rendered }: ExportResponseRequest) {
  const { buffer, renderedWith } = rendered;
  const { html, svgChars } = buildExportBundle({
    relativePath: params.relative_path,
    diagramType: type,
    svg: buffer.toString("utf-8"),
    source: params.include_source ? source : null,
    renderedWith,
  });

  // A bundle is one whole artifact or nothing: the cap is checked on the
  // finished document, so a caller never saves a diagram with half its
  // rendering. The message names the ceiling and the diagram, never the
  // source or any absolute path.
  const byteLength = Buffer.byteLength(html, "utf-8");
  if (byteLength > MAX_EXPORT_HTML_BYTES) {
    const message =
      `Error: The export bundle for '${toPosixPath(params.relative_path)}' is ` +
      `${byteLength} bytes, larger than the ${MAX_EXPORT_HTML_BYTES}-byte limit, so ` +
      `it was not returned. Split or simplify the diagram, then export it again.`;
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }

  const output = {
    relative_path: toPosixPath(params.relative_path),
    diagram_type: type,
    format: "html" as const,
    bytes: byteLength,
    svg_chars: svgChars,
    source_included: params.include_source,
    truncated: false as const,
    rendered_with: renderedWith,
  };

  return {
    content: [{ type: "text" as const, text: html }],
    structuredContent: output,
  };
}

export function registerDiagramsExport(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_export",
    {
      title: "Export Diagram as a Self-Contained HTML File",
      description: `Package a stored PlantUML or Mermaid diagram and its rendered SVG into one self-contained HTML file you can share or open outside the repo. The SVG is encoded as a data image, so renderer markup is not parsed into the HTML DOM. SVG image processing disables scripts and external resource loading. A restrictive content security policy allows only data images and inline wrapper styles. SVG text is not selectable in the exported image. Diagram source is escaped in a native collapsible block when include_source is set, and the artifact works offline without new dependencies.

Rendering uses the same path and the same rules as diagrams_render: Mermaid requires the local 'mmdc' CLI with no fallback, and PlantUML prefers a local 'plantuml' CLI, falling back to the configured remote server only when ALLOW_REMOTE_PLANTUML=true and DISABLE_REMOTE_PLANTUML is not 'true'. Remote PlantUML rendering sends diagram source to that server over HTTPS.

The tool never writes a file: the HTML comes back as text and you decide where it lands. A bundle larger than ${MAX_EXPORT_HTML_BYTES} bytes is refused outright rather than cut down, because a half-rendered artifact is worse than none.

Args:
  - relative_path (string, required): Path to the diagram, relative to the diagrams root
  - include_source (boolean, default true): Embed the diagram source in a collapsible <pre> block

Returns:
  The HTML as a text content block, plus a JSON summary:
  {
    "relative_path": string,                 // POSIX form, the only path in the bundle
    "diagram_type": "plantuml" | "mermaid",
    "format": "html",
    "bytes": number,                         // UTF-8 byte length of the returned HTML
    "svg_chars": number,                     // image source characters after XML preamble stripping, before base64 encoding
    "source_included": boolean,              // whether the source block was embedded
    "truncated": false,                      // always false; over-cap is an error, never a cut file
    "rendered_with": "local-plantuml" | "remote-plantuml" | "mmdc"
  }

Examples:
  - Use when: "Package the order-flow diagram so I can send it to someone without the repo" -> relative_path="system/order-flow.puml"
  - Use when: "Give me a standalone HTML of the checkout sequence" -> relative_path="system/checkout.mmd", include_source=false
  - Don't use when: You want the image alone (use diagrams_render, which returns an image block)
  - Don't use when: You want to edit the diagram (use diagrams_get and diagrams_update)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the diagram does not exist, before any render is attempted
  - Returns "Error: Mermaid rendering requires the 'mmdc' CLI..." when rendering a Mermaid diagram without mmdc installed (no fallback exists)
  - Returns "Error: PlantUML rendering requires a local 'plantuml' CLI..." when no local CLI is installed and remote rendering is not explicitly enabled (set ALLOW_REMOTE_PLANTUML=true to opt in)
  - Returns "Error: PlantUML rendering server responded with <status>..." when the opt-in remote fallback answers non-2xx
  - Returns "Error: The export bundle for '<path>' is <n> bytes, larger than the ${MAX_EXPORT_HTML_BYTES}-byte limit, so it was not returned..." when the finished bundle exceeds the cap
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
      // Read first, render second: a missing diagram must fail before any CLI
      // is spawned or any remote request is considered.
      let content: string;
      let type: DiagramType;
      try {
        ({ content, type } = await ctx.diagramStore.read(params.relative_path));
      } catch (err: unknown) {
        return handleToolError("diagrams_export", err);
      }
      try {
        const rendered = await renderDiagramWithProvenance(content, type, "svg", ctx.rendererDeps);
        return formatExportResponse({ params, source: content, type, rendered });
      } catch (err: unknown) {
        return handleRenderError("diagrams_export", err);
      }
    },
  );
}

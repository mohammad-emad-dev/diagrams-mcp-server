import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_EXPORT_HTML_BYTES, toPosixPath } from "../constants.js";
import type { DiagramType } from "../types.js";
import { buildSizedExportBundle } from "../services/export/htmlBundle.js";
import { renderDiagramWithProvenance } from "../services/renderer.js";
import type { RenderResult } from "../services/renderer.js";
import { handleRenderError, handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe("Path to the diagram to export, relative to the diagrams root."),
    output_path: z
      .string()
      .min(1)
      .describe(
        "Path for the saved HTML file, relative to the diagrams root, ending in .html " +
          "(case-insensitive). Intermediate directories are created. Existing files are " +
          "refused, never overwritten.",
      ),
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
export const diagramsSaveExportInputSchema = InputSchema;

interface SaveExportResponseRequest {
  params: Input;
  type: DiagramType;
  rendered: RenderResult;
  svgChars: number;
  byteLength: number;
}

function formatSaveExportResponse({
  params,
  type,
  rendered,
  svgChars,
  byteLength,
}: SaveExportResponseRequest) {
  const output = {
    relative_path: toPosixPath(params.relative_path),
    output_path: toPosixPath(params.output_path),
    diagram_type: type,
    format: "html" as const,
    bytes: byteLength,
    svg_chars: svgChars,
    source_included: params.include_source,
    truncated: false as const,
    rendered_with: rendered.renderedWith,
  };

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Saved HTML export of '${toPosixPath(params.relative_path)}' ` +
          `to '${toPosixPath(params.output_path)}' ` +
          `(${byteLength} bytes, rendered with ${rendered.renderedWith}).`,
      },
    ],
    structuredContent: output,
  };
}

export function registerDiagramsSaveExport(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_save_export",
    {
      title: "Save Diagram Export as HTML File",
      description: `Save a stored PlantUML or Mermaid diagram as one self-contained HTML file inside the diagrams root. The SVG is encoded as a data image, so renderer markup is not parsed into the HTML DOM. SVG image processing disables scripts and external resource loading. A restrictive content security policy allows only data images and inline wrapper styles. SVG text is not selectable in the exported image. Diagram source is escaped in a native collapsible block when include_source is set, and the artifact works offline without new dependencies.

Rendering uses the same path and the same rules as diagrams_render: Mermaid requires the local 'mmdc' CLI with no fallback, and PlantUML prefers a local 'plantuml' CLI, falling back to the configured remote server only when ALLOW_REMOTE_PLANTUML=true and DISABLE_REMOTE_PLANTUML is not 'true'. Remote PlantUML rendering sends diagram source to that server over HTTPS.

The finished bundle is measured before the output directories or file are created. A bundle larger than ${MAX_EXPORT_HTML_BYTES} bytes is refused. The target must end in .html (case-insensitive) and must not exist: existing files are refused atomically, never overwritten. Saved HTML files are excluded from diagram listing and CRUD tools. To replace an export, choose a different output_path or remove the existing target yourself.

Args:
  - relative_path (string, required): Path to the diagram, relative to the diagrams root
  - output_path (string, required): Path for the saved HTML file, relative to the diagrams root, ending in .html
  - include_source (boolean, default true): Embed the diagram source in a collapsible <pre> block

Returns:
  A short acknowledgement as a text content block (not the HTML itself), plus a JSON summary:
  {
    "relative_path": string,             // POSIX form of the source diagram
    "output_path": string,               // POSIX form of the saved HTML file
    "diagram_type": "plantuml" | "mermaid",
    "format": "html",
    "bytes": number,                     // UTF-8 byte length of the saved HTML
    "svg_chars": number,                 // image source characters after XML preamble stripping, before base64 encoding
    "source_included": boolean,          // whether the source block was embedded
    "truncated": false,                  // always false; over-cap is an error, never a cut file
    "rendered_with": "local-plantuml" | "remote-plantuml" | "mmdc"
  }

Examples:
  - Use when: "Save the order-flow diagram as HTML inside the repo" -> relative_path="system/order-flow.puml", output_path="exports/order-flow.html"
  - Use when: "Save a standalone HTML of the checkout sequence without source" -> relative_path="system/checkout.mmd", output_path="exports/checkout.html", include_source=false
  - Don't use when: You want the HTML text back without writing a file (use diagrams_export, which returns the bundle and writes nothing)
  - Don't use when: You want the image alone (use diagrams_render, which returns an image block)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the diagram does not exist, before any render is attempted
  - Returns "Error: Mermaid rendering requires the 'mmdc' CLI..." when rendering a Mermaid diagram without mmdc installed (no fallback exists)
  - Returns "Error: PlantUML rendering requires a local 'plantuml' CLI..." when no local CLI is installed and remote rendering is not explicitly enabled (set ALLOW_REMOTE_PLANTUML=true to opt in)
  - Returns "Error: PlantUML rendering server responded with <status>..." when the opt-in remote fallback answers non-2xx
  - Returns "Error: The export bundle for '<path>' is <n> bytes, larger than the ${MAX_EXPORT_HTML_BYTES}-byte limit, so it was not saved..." when the finished bundle exceeds the cap, with nothing written
  - Returns "Error: HTML export '<path>' already exists..." if the output file already exists; choose another output_path or remove the target yourself
  - Returns "Error: '<path>' does not have the .html export extension..." if output_path does not end in .html
  - Returns "Error: Refused to access path outside the diagrams root" if relative_path or output_path attempts to escape the diagrams directory
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      // Read first, render second, measure third, write last: a missing
      // diagram fails before any CLI runs, and an over-cap bundle fails
      // before any output directory or file is created.
      let content: string;
      let type: DiagramType;
      try {
        ({ content, type } = await ctx.diagramStore.read(params.relative_path));
      } catch (err: unknown) {
        return handleToolError("diagrams_save_export", err);
      }
      let rendered: RenderResult;
      let bundle: ReturnType<typeof buildSizedExportBundle>;
      try {
        rendered = await renderDiagramWithProvenance(content, type, "svg", ctx.rendererDeps);
        bundle = buildSizedExportBundle({
          relativePath: params.relative_path,
          diagramType: type,
          svg: rendered.buffer.toString("utf-8"),
          source: params.include_source ? content : null,
          renderedWith: rendered.renderedWith,
        });
      } catch (err: unknown) {
        return handleRenderError("diagrams_save_export", err);
      }
      const { html, svgChars, byteLength } = bundle;
      if (byteLength > MAX_EXPORT_HTML_BYTES) {
        const message =
          `Error: The export bundle for '${toPosixPath(params.relative_path)}' is ` +
          `${byteLength} bytes, larger than the ${MAX_EXPORT_HTML_BYTES}-byte limit, so ` +
          `it was not saved to '${toPosixPath(params.output_path)}'. ` +
          `Split or simplify the diagram, then export it again.`;
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
      try {
        await ctx.diagramStore.writeHtmlExport(params.output_path, html);
      } catch (err: unknown) {
        return handleToolError("diagrams_save_export", err);
      }
      return formatSaveExportResponse({
        params,
        type,
        rendered,
        svgChars,
        byteLength,
      });
    },
  );
}

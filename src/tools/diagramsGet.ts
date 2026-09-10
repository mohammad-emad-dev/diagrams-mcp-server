import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_GET_WINDOW_CHARS, toPosixPath } from "../constants.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe(
        "Path to the diagram, relative to the diagrams root (e.g. 'system/order-flow.puml'). Get this from diagrams_list.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Zero-based character offset into the diagram source where the returned window starts (default: 0).",
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .max(MAX_GET_WINDOW_CHARS)
      .optional()
      .describe(
        `Maximum characters to return starting at offset (1-${MAX_GET_WINDOW_CHARS}). Omit to return the full source.`,
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

/** Range check shared by MCP calls and direct handler calls. */
function windowError(offset: unknown, maxChars: unknown): string | null {
  if (
    offset !== undefined &&
    (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
  ) {
    return `Error: Invalid source window: 'offset' must be a non-negative integer (got ${JSON.stringify(offset) ?? "missing"}).`;
  }
  if (
    maxChars !== undefined &&
    (typeof maxChars !== "number" ||
      !Number.isInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > MAX_GET_WINDOW_CHARS)
  ) {
    return `Error: Invalid source window: 'max_chars' must be an integer between 1 and ${MAX_GET_WINDOW_CHARS} (got ${JSON.stringify(maxChars)}).`;
  }
  return null;
}

export function registerDiagramsGet(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_get",
    {
      title: "Get Diagram Source",
      description: `Retrieve the raw source text of a single PlantUML or Mermaid diagram, in full or as an explicit character window.

Args:
  - relative_path (string): Path to the diagram relative to the diagrams root, as returned by diagrams_list
  - offset (number, optional): Zero-based character offset where the returned window starts (default: 0)
  - max_chars (number, optional): Maximum characters to return from offset (1-100000). Omit to return the full source

Returns:
  JSON with schema:
  {
    "relative_path": string,
    "type": "plantuml" | "mermaid",
    "content": string,       // full source, or the requested [offset, offset+max_chars) window
    "is_partial": boolean,   // true when content is a window rather than the full source
    "offset": number,        // effective character offset of this window
    "total_chars": number,   // full source length in characters
    "returned_chars": number,// length of the returned content
    "has_more": boolean      // true when source after this window remains
  }

  The text block always equals structuredContent.content. Content is never
  silently truncated: omitting offset/max_chars returns everything, and
  requesting a window is always reported via is_partial/has_more.

Examples:
  - Use when: "Show me the order-flow diagram" -> relative_path="system/order-flow.puml"
  - Use when: "Read the first 2000 characters of the big diagram" -> relative_path="...", offset=0, max_chars=2000, then offset=2000 for the next window
  - Don't use when: You need to list what diagrams exist first (use diagrams_list)

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the file doesn't exist
  - Returns "Error: Refused to access path outside the diagrams root" if relative_path attempts to escape the diagrams directory (e.g. via '../..')
  - Returns "Error: Invalid source window: ..." if offset/max_chars are negative, non-integer, or max_chars is outside 1-100000
  - Returns "Error: offset <n> is out of range ..." if offset points past the end of the source
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
      const rangeError = windowError(params.offset, params.max_chars);
      if (rangeError) {
        return {
          content: [{ type: "text" as const, text: rangeError }],
          isError: true,
        };
      }

      try {
        const { content: full, type } = await ctx.diagramStore.read(params.relative_path);
        const offset: number = params.offset ?? 0;
        const maxChars: number | undefined = params.max_chars;
        const totalChars = full.length;
        if (offset > 0 && offset >= totalChars) {
          const message =
            `Error: offset ${offset} is out of range for '${toPosixPath(params.relative_path)}': ` +
            `diagram source is ${totalChars} characters. Omit offset/max_chars for the full ` +
            `content or choose an offset below ${totalChars}.`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }
        const end = maxChars === undefined ? totalChars : Math.min(offset + maxChars, totalChars);
        const window = full.slice(offset, end);
        const output = {
          relative_path: toPosixPath(params.relative_path),
          type,
          content: window,
          is_partial: offset !== 0 || end < totalChars,
          offset,
          total_chars: totalChars,
          returned_chars: window.length,
          has_more: offset + window.length < totalChars,
        };
        return {
          content: [{ type: "text" as const, text: window }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_get", err);
      }
    },
  );
}

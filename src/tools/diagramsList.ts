import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_LIST_LIMIT, toPosixPath } from "../constants.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    type_filter: z
      .enum(["plantuml", "mermaid", "all"])
      .default("all")
      .describe("Restrict results to a single diagram type, or 'all' for both."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Zero-based number of matching diagrams to skip before the returned page (default: 0).",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST_LIMIT)
      .optional()
      .describe(
        `Maximum number of diagrams to return (1-${MAX_LIST_LIMIT}). Omit to return every remaining match.`,
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

/** Range check shared by MCP calls and direct handler calls. */
function paginationError(offset: unknown, limit: unknown): string | null {
  if (
    offset !== undefined &&
    (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
  ) {
    return `Error: Invalid pagination: 'offset' must be a non-negative integer (got ${JSON.stringify(offset) ?? "missing"}).`;
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)
  ) {
    return `Error: Invalid pagination: 'limit' must be an integer between 1 and ${MAX_LIST_LIMIT} (got ${JSON.stringify(limit)}).`;
  }
  return null;
}

export function registerDiagramsList(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_list",
    {
      title: "List Architecture Diagrams",
      description: `List all PlantUML and Mermaid diagram files stored under the project's diagrams directory.

This tool scans the configured diagrams root recursively and returns every file with a recognized diagram extension (.puml, .plantuml, .mmd, .mermaid). It does NOT create, modify, or render diagrams — read-only.

Args:
  - type_filter ('plantuml' | 'mermaid' | 'all'): Restrict results to one diagram type (default: 'all')
  - offset (number, optional): Zero-based number of matching diagrams to skip (default: 0)
  - limit (number, optional): Maximum diagrams to return (1-500). Omit to return every remaining match

Returns:
  JSON with schema:
  {
    "diagrams_root": string,       // absolute path being scanned
    "count": number,               // number of diagrams in this page
    "total": number,               // number of diagrams matching type_filter, before paging
    "offset": number,              // effective offset of this page
    "limit": number,               // effective limit of this page (requested limit, or remaining count when omitted)
    "has_more": boolean,           // true when diagrams after this page remain
    "diagrams": [
      {
        "relative_path": string,   // path to use with diagrams_get / diagrams_update
        "type": "plantuml" | "mermaid",
        "title": string | null,    // best-effort extracted title
        "size_bytes": number,
        "modified_at": string      // ISO 8601 timestamp
      }
    ]
  }

  Pagination is explicit: omitting offset/limit returns every match with
  has_more=false. Nothing is ever silently dropped — has_more tells the
  caller when to request the next page with offset=<offset+count>.

Examples:
  - Use when: "What diagrams exist for this project?" -> type_filter="all"
  - Use when: "Show me all the Mermaid diagrams" -> type_filter="mermaid"
  - Use when: "List diagrams ten at a time" -> limit=10, then offset=10 for the next page
  - Don't use when: You already know the exact path and just need its content (use diagrams_get instead)

Error Handling:
  - Returns an empty "diagrams" array if the diagrams directory doesn't exist yet or is empty (this is not an error)
  - Returns an empty page (count 0, has_more=false) when offset is past the end of the matches
  - Returns "Error: Invalid pagination: ..." if offset is negative/non-integer or limit is outside 1-500
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
      const rangeError = paginationError(params.offset, params.limit);
      if (rangeError) {
        return {
          content: [{ type: "text" as const, text: rangeError }],
          isError: true,
        };
      }

      const offset: number = params.offset ?? 0;
      const limit: number | undefined = params.limit;

      try {
        const all = await ctx.diagramStore.list();
        const filtered =
          params.type_filter === "all" ? all : all.filter((d) => d.type === params.type_filter);

        const total = filtered.length;
        const page =
          limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
        const effectiveLimit = limit ?? Math.max(total - offset, 0);
        const hasMore = offset + page.length < total;

        const output = {
          diagrams_root: ctx.diagramStore.getRoot(),
          count: page.length,
          total,
          offset,
          limit: effectiveLimit,
          has_more: hasMore,
          diagrams: page.map((d) => ({
            relative_path: toPosixPath(d.relativePath),
            type: d.type,
            title: d.title,
            size_bytes: d.sizeBytes,
            modified_at: d.modifiedAt,
          })),
        };

        let text: string;
        if (page.length === 0) {
          text =
            total === 0
              ? `No diagrams found under '${ctx.diagramStore.getRoot()}'. Create one with diagrams_create.`
              : `No diagrams at offset ${offset} (total ${total}). Call diagrams_list with a smaller offset to see more.`;
        } else {
          text = page
            .map(
              (d) =>
                `- ${toPosixPath(d.relativePath)} (${d.type}${d.title ? `, "${d.title}"` : ""})`,
            )
            .join("\n");
          if (hasMore) {
            text += `\nShowing ${page.length} of ${total} diagrams (offset ${offset}, limit ${effectiveLimit}). Call diagrams_list with offset=${offset + page.length} to see more.`;
          }
        }

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_list", err);
      }
    },
  );
}

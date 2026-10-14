import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_TEMPLATE_SCAN_ENTRIES } from "../constants.js";
import { TEMPLATE_KINDS } from "../services/templates/skeletons.js";
import { listCustomTemplates } from "../services/templates/templateCatalog.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z.object({}).strict();

// Exported so tests can parse arguments exactly as the server does: the SDK
// runs safeParse on the input schema before the handler sees the arguments.
export const diagramsListTemplatesInputSchema = InputSchema;

function scanWarningFor(): string {
  return (
    `Scan reached the ${MAX_TEMPLATE_SCAN_ENTRIES}-entry limit and stopped early; ` +
    `custom candidates may be incomplete. custom_count describes only the returned ` +
    `candidates, not a full directory total. No pagination is offered and capped ` +
    `ordering beyond the sorted subset is not promised. ` +
    `Narrow the .diagrams-templates directory to see the rest.`
  );
}

function formatDiscoveryText(args: {
  builtInNames: string[];
  customNames: string[];
  entriesScanned: number;
  truncated: boolean;
  scanWarning: string | null;
}): string {
  const { builtInNames, customNames, entriesScanned, truncated, scanWarning } = args;
  const builtInLine =
    `Built-in templates (${builtInNames.length}): ${builtInNames.join(", ")} ` +
    `(each supports puml and mermaid).`;
  const customLine =
    customNames.length > 0
      ? `Custom template candidates (${customNames.length}): ${customNames.join(", ")}. ` +
        `Pass custom_template to diagrams_template with template="custom"; ` +
        `definition, dialect, and syntax are validated there, not here.`
      : `Custom template candidates (0): none found under '.diagrams-templates'. ` +
        `Create a <name>.json file there, then pass custom_template to ` +
        `diagrams_template with template="custom".`;
  const scanLine = truncated
    ? `Scan: ${entriesScanned} entries examined (limit ${MAX_TEMPLATE_SCAN_ENTRIES}); truncated. ${scanWarning}`
    : `Scan: ${entriesScanned} entries examined (limit ${MAX_TEMPLATE_SCAN_ENTRIES}); no truncation.`;
  return (
    `${builtInLine}\n${customLine}\n` +
    `Discovery reads directory entries only; file contents are never read.\n${scanLine}`
  );
}

/**
 * Discovery needs the project root: custom candidates live directly under
 * PROJECT_ROOT/.diagrams-templates, and built-ins need no filesystem at all.
 */
export function registerDiagramsListTemplates(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_list_templates",
    {
      title: "List Available Diagram Templates",
      description: `Discover the diagram templates diagrams_template can instantiate, without reading any template contents.

Lists the built-in skeleton kinds (each supports 'puml' and 'mermaid') plus the custom-template candidate names found as *.json entries directly under PROJECT_ROOT/.diagrams-templates. A candidate name is an identifier to pass as custom_template to diagrams_template with template='custom'; the definition, the selected dialect, and the emitted source are validated there, not here. Discovery reads directory entries only — file contents are never read, so a malformed JSON file can still appear as a candidate — and it never writes or creates a missing template directory.

The scan is bounded: at most ${MAX_TEMPLATE_SCAN_ENTRIES} directory entries are examined (MAX_TEMPLATE_SCAN_ENTRIES), counting non-template entries too, plus one lookahead to detect the cap. There is no pagination, no full directory total, and no global subset ordering promised when capped: custom_count describes only the returned candidates, and the returned names are sorted only within the capped subset, which depends on filesystem iteration order.

Args:
  (none): Call with {} — discovery takes no arguments.

Returns:
  JSON with schema:
  {
    "built_in": [                 // one entry per built-in kind, in documented order
      { "template": "class" | "sequence" | "c4_context", "formats": ["puml", "mermaid"] }
    ],
    "custom": [                   // candidate names, sorted within the scanned subset
      { "template": "custom", "custom_template": string, "relative_path": string }
    ],
    "custom_count": number,       // length of "custom": returned candidates only, not a full total when capped
    "entries_scanned": number,    // directory entries examined, including non-template entries
    "scan_limit": number,         // ${MAX_TEMPLATE_SCAN_ENTRIES}
    "truncated": boolean,         // true when the entry cap was reached
    "scan_warning": string | null,// human-readable warning when truncated, otherwise null
    "written": false              // always false; discovery never writes
  }

  Each custom relative_path identifies the project-relative file '.diagrams-templates/<name>.json'. Pass the custom_template identifier, not this path, to diagrams_template.

Examples:
  - Use when: "What templates are available?" -> call with {}
  - Use when: "Do we have a team skeleton?" -> call with {}, then look for its name in "custom"
  - Use when: "Which built-in starter should I use?" -> call with {}, then pass one of the built_in names to diagrams_template
  - Don't use when: You want the skeleton source itself (use diagrams_template with a name from this listing)
  - Don't use when: You want generated content from code (use diagrams_generate or diagrams_generate_sequence)

Error Handling:
  - Unknown argument fields are rejected: discovery accepts only {}
  - A missing .diagrams-templates directory is not an error: "custom" is empty with truncated=false and scan_warning=null
  - Subdirectories, symlink files/directories, invalid identifiers, and extensions other than .json are excluded, not errors
  - A .diagrams-templates path that is not a regular directory is rejected without exposing absolute paths
  - Expected filesystem access failures return CustomTemplateError without absolute paths
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const { names, entriesScanned, truncated } = await listCustomTemplates(ctx.codeRootDir);
        const builtInNames: string[] = [...TEMPLATE_KINDS];
        const scanWarning = truncated ? scanWarningFor() : null;
        const output = {
          built_in: builtInNames.map((template) => ({
            template,
            formats: ["puml", "mermaid"] as const,
          })),
          custom: names.map((id) => ({
            template: "custom" as const,
            custom_template: id,
            relative_path: `.diagrams-templates/${id}.json`,
          })),
          custom_count: names.length,
          entries_scanned: entriesScanned,
          scan_limit: MAX_TEMPLATE_SCAN_ENTRIES,
          truncated,
          scan_warning: scanWarning,
          written: false as const,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: formatDiscoveryText({
                builtInNames,
                customNames: names,
                entriesScanned,
                truncated,
                scanWarning,
              }),
            },
          ],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_list_templates", err);
      }
    },
  );
}

/**
 * Shared constants for the diagrams-mcp-server.
 */

/**
 * Convert a relative path to POSIX form (`/` separators) for user-facing
 * MCP output. Filesystem access still uses native paths internally; only
 * the strings returned to clients are normalized so Windows `\` separators
 * never leak into `relative_path` / `diagram_path` fields or text summaries.
 */
export function toPosixPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

// Supported diagram file extensions, mapped to their diagram type.
export const EXTENSION_TO_TYPE: Record<string, "plantuml" | "mermaid"> = {
  ".puml": "plantuml",
  ".plantuml": "plantuml",
  ".mmd": "mermaid",
  ".mermaid": "mermaid",
};

export const TYPE_TO_EXTENSION: Record<"plantuml" | "mermaid", string> = {
  plantuml: ".puml",
  mermaid: ".mmd",
};

// Default directory (relative to the project root passed at startup) where
// diagrams are stored, if the caller doesn't specify a sub-directory.
export const DEFAULT_DIAGRAMS_DIR = "diagrams";

/**
 * Maximum page size for `diagrams_list` (`limit`). Pagination is explicit
 * and opt-in: omitting `limit` returns every match, so this bound only caps
 * explicitly requested pages. It is not a truncation limit.
 */
export const MAX_LIST_LIMIT = 500;

/**
 * Maximum window size for `diagrams_get` (`max_chars`). Omitting `max_chars`
 * returns the full diagram source, so this bound only caps explicitly
 * requested windows. It is not a truncation limit.
 */
export const MAX_GET_WINDOW_CHARS = 100_000;

// Public PlantUML rendering server (used only if no local plantuml.jar/CLI
// is available). Self-hosted deployments can override via env var.
export const PLANTUML_SERVER_URL =
  process.env.PLANTUML_SERVER_URL || "https://www.plantuml.com/plantuml";

/**
 * Maximum captured characters per stream (stdout and stderr each) for
 * local renderer child processes. The bound is enforced while output is
 * collected: bytes past the cap are discarded and the child is stopped,
 * so a runaway renderer cannot grow memory without bound. Overflow fails
 * with an actionable RenderError whose message never includes captured
 * output (it may echo diagram source, paths, or environment values).
 */
export const MAX_RENDER_OUTPUT_CHARS = 1_000_000;

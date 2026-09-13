// Shared constants for the server.

// POSIX form for user-facing paths. Windows separators never leak into output.
export function toPosixPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

// Diagram file extensions by type.
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

// Default diagrams directory, relative to the project root.
export const DEFAULT_DIAGRAMS_DIR = "diagrams";

// Largest page size `diagrams_list` accepts. Only caps explicit pages.
export const MAX_LIST_LIMIT = 500;

// Largest window `diagrams_get` accepts. Only caps explicit windows.
export const MAX_GET_WINDOW_CHARS = 100_000;

// Public PlantUML render server, used only as an opt-in fallback.
export const PLANTUML_SERVER_URL =
  process.env.PLANTUML_SERVER_URL || "https://www.plantuml.com/plantuml";

// Captured characters per renderer stream. Enforced while collecting,
// so runaway output cannot grow memory without bound.
export const MAX_RENDER_OUTPUT_CHARS = 1_000_000;

// Largest PlantUML remote response kept in memory. Larger bodies are
// discarded with an error before conversion, so a compromised server
// cannot exhaust memory. See D-008.
export const MAX_REMOTE_BODY_BYTES = 5_000_000;

// Abort timeout for PlantUML remote requests. See D-008.
export const REMOTE_FETCH_TIMEOUT_MS = 20_000;

// Largest renderer stderr excerpt surfaced in an exit error. The full
// stream stays capped by MAX_RENDER_OUTPUT_CHARS; tool output only ever
// carries this prefix.
export const MAX_RENDER_ERROR_CHARS = 500;

// Largest file prefix scanned for a diagram title during list(). Titles
// past the window read as null; a title line cut at the window edge keeps
// a "…"-prefixed excerpt instead of passing as the exact title. See D-007.
export const MAX_TITLE_SCAN_BYTES = 8_192;

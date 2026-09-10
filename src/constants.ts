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

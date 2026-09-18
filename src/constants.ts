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

// Largest entity list diagrams_generate emits. The input schema's own
// max_entities (1-60) is clamped to this, so an oversized request still
// yields a bounded diagram and the drop is reported in-band as
// entities_available / entities_capped.
export const MAX_GENERATE_ENTITIES = 60;

// Largest relations list diagrams_generate emits. Edges whose endpoints
// were dropped by the entity cap are excluded too (a diagram must never
// reference a box it does not declare); both drops count as relations_capped.
export const MAX_GENERATE_RELATIONS = 60;

// Largest participant list diagrams_generate_sequence declares. A sequence
// diagram names the parties to a conversation, so the cap bounds how many
// files become boxes. The input schema's own max_participants (1-20) is
// bounded by this ceiling; anything past the cap is counted in
// participants_available and flagged by participants_capped.
export const MAX_SEQUENCE_PARTICIPANTS = 20;

// Largest message list diagrams_generate_sequence emits. Messages are ordered
// call sites, so this bounds the conversation length independently of the
// participant cap; a message whose endpoint the participant cap removed is
// dropped too (never a message to an undeclared box) and counts as capped.
export const MAX_SEQUENCE_MESSAGES = 50;

// Largest entity list diagrams_template accepts. A skeleton is hand-instantiated
// scaffolding, not generated content: the cap bounds what an agent can ask for
// in one call, and the count is echoed back as entities_included.
export const MAX_TEMPLATE_ENTITIES = 20;

// Longest entity name diagrams_template accepts. Names are emitted bare in both
// dialects (a class, participant, or C4 alias), so this is the length that has
// to stay a legal identifier, not a label.
export const MAX_ENTITY_NAME_CHARS = 60;

// Longest title diagrams_template accepts, before it is normalized to one line.
// The cap bounds what can be echoed into a single title line, so a title can
// never wrap and break the emitted source.
export const MAX_TEMPLATE_TITLE_CHARS = 200;

// Largest HTML bundle diagrams_export returns. A bundle is one whole artifact or
// nothing at all: over-cap is an error, never a cut file, so a caller never
// saves a diagram with half its rendering. Matches MAX_REMOTE_BODY_BYTES, the
// same memory bound the renderer already applies to a fetched SVG.
export const MAX_EXPORT_HTML_BYTES = 5_000_000;

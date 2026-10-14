// Shared contracts for diagrams_generate and diagrams_generate_sequence.
// Owned here so collectors, emitters, and tool adapters share one source
// without collector-to-collector imports.

import type { TsModule } from "../consistencyChecker/ts/tsParse.js";

/** One directed edge in the generated diagram. */
export interface RelationEdge {
  /** Declaring class or interface name. */
  from: string;
  /** Parent type name. */
  to: string;
  /** Generalization (extends) or realization (implements). */
  kind: "extends" | "implements";
}

/**
 * Test seam for the TypeScript compiler. The default resolves it by dynamic
 * import; `{ loadTsModule: async () => null }` exercises the AST-missing
 * path on a machine where the compiler is installed. Mirrors RendererDeps.
 */
export interface GenerateDeps {
  loadTsModule?: () => Promise<TsModule | null>;
}

export interface CollectOptions {
  /** Collect extends/implements; false emits an entities-only diagram. */
  includeRelations?: boolean;
  /** Overrides for the emitted caps; tests use small values. */
  maxEntities?: number;
  maxRelations?: number;
  /** Compiler override; see GenerateDeps. */
  deps?: GenerateDeps;
}

export interface EntityCollectionResult {
  /** Entities in emission order, already capped. */
  entities: string[];
  /** Edges in emission order, already capped and endpoint-filtered. */
  relations: RelationEdge[];
  /** Distinct entities found before the cap. */
  entitiesAvailable: number;
  /** Distinct evidenced edges before the cap and endpoint filter. */
  relationsAvailable: number;
  /** Entities dropped by the cap. */
  entitiesDropped: number;
  /** Edges dropped by the cap, or by an endpoint the entity cap removed. */
  relationsDropped: number;
  filesScanned: number;
  truncated: boolean;
  scanLimit: number;
  scanWarning: string | null;
  /** Relations status; null when relations were requested and available. */
  dialectNote: string | null;
  /** True when the TypeScript AST backed this collection. */
  tsAstAvailable: boolean;
}

/** One ordered message in the generated sequence. */
export interface SequenceMessage {
  /** Participant sending the message (the file the call site lives in). */
  from: string;
  /** Participant receiving it (the file declaring the called operation). */
  to: string;
  /** Called operation name, as written at the call site. */
  message: string;
  /** 1-based line number of the call site. */
  line: number;
  /** Always false in output: deferred calls are excluded, never sequenced. */
  via_callback: boolean;
}

export interface SequenceCollectionResult {
  /** Participants in emission order, already capped and dialect-named. */
  participants: string[];
  /** Distinct participants in candidate messages, before the cap. */
  participantsAvailable: number;
  /** Participants dropped by the cap. */
  participantsDropped: number;
  /** Messages in source order, already capped. */
  messages: SequenceMessage[];
  /** Candidate messages before the caps, may exceed the emitted count. */
  messagesAvailable: number;
  /** Messages dropped by the participant cap or the message cap. */
  messagesDropped: number;
  /** Call sites inside a callback/promise: counted, never sequenced. */
  deferredCount: number;
  /** Callee names with no declaring participant in the scope. */
  unresolvedCallees: string[];
  filesScanned: number;
  truncated: boolean;
  scanLimit: number;
  scanWarning: string | null;
  /** True when the TypeScript AST backed this collection. */
  tsAstAvailable: boolean;
  /** Emitted source; identical to the tool's text block. */
  source: string;
}

export interface SequenceOptions {
  /** Output dialect; names are quoted (PlantUML) or sanitized (Mermaid). */
  format?: "puml" | "mermaid";
  /** Overrides for the emitted caps; tests use small values. */
  maxParticipants?: number;
  maxMessages?: number;
  /** Compiler override; see GenerateDeps. */
  deps?: GenerateDeps;
}

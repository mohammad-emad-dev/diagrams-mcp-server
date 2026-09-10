// Shared types for diagrams, tools, and consistency results.

export type DiagramType = "plantuml" | "mermaid";

export interface DiagramFile {
  /** Path relative to the diagrams root. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Diagram type by file extension. */
  type: DiagramType;
  /** Best-effort title from the content, if any. */
  title: string | null;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modified time, ISO 8601 */
  modifiedAt: string;
}

export interface ConsistencyIssue {
  /** Name from the diagram that found no match. */
  name: string;
  /** What the mismatch means. */
  issue: string;
  /** Priority hint for the reader. */
  severity: "warning" | "info";
}

/** Which matching strategy a scanned file falls under. */
export type AnalyzerTier = "reliable" | "experimental" | "generic";

/** Scanned file extensions per tier (lowercase, with dot). */
export interface AnalyzerBreakdown {
  reliable: string[];
  experimental: string[];
  generic: string[];
}

/** Match evidence for one diagram entity. */
export interface ConsistencyEntityEvidence {
  /** Entity name from the diagram. */
  name: string;
  /** Whether it was found in the codebase. */
  matched: boolean;
  /** Tiers of the files that matched. */
  analyzers: AnalyzerTier[];
  /** Matching files, relative POSIX paths, capped. See matchedFileCount. */
  matchedFiles: string[];
  /** Total matches, even past the matchedFiles cap. */
  matchedFileCount: number;
}

export interface ConsistencyCheckResult {
  diagramPath: string;
  entitiesFound: number;
  entitiesMatched: number;
  entitiesUnmatched: number;
  issues: ConsistencyIssue[];
  searchedDirectory: string;
  filesScanned: number;
  /** True when the scan hit the file cap; unmatched may be incomplete. */
  truncated: boolean;
  /** Max source files collected per scan. */
  scanLimit: number;
  /** Warning when truncated, otherwise null. Never includes paths or source. */
  scanWarning: string | null;
  /** Entity names from the diagram, in order. */
  entities: string[];
  /** Entities found in the codebase. */
  matchedEntities: string[];
  /** Entities not found in the codebase. */
  unmatchedEntities: string[];
  /** Extensions actually scanned per tier. */
  analyzers: AnalyzerBreakdown;
  /** Always "heuristic": evidence, not proof. */
  confidence: "heuristic";
  /** What the heuristic can and cannot tell you. */
  heuristicWarning: string;
  /** Per-entity evidence, same order as entities. */
  evidence: ConsistencyEntityEvidence[];
}

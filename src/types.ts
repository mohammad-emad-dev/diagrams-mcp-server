/**
 * Shared TypeScript type definitions for the diagrams-mcp-server.
 */

export type DiagramType = "plantuml" | "mermaid";

export interface DiagramFile {
  /** Path relative to the configured diagrams root, e.g. "system/order-flow.puml" */
  relativePath: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Detected diagram type based on file extension */
  type: DiagramType;
  /** Best-effort title extracted from the diagram content, if any */
  title: string | null;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modified time, ISO 8601 */
  modifiedAt: string;
}

export interface ConsistencyIssue {
  /** The name mentioned in the diagram (class, component, module, etc.) */
  name: string;
  /** Human-readable description of the mismatch */
  issue: string;
  /** Severity for the agent/human to prioritize */
  severity: "warning" | "info";
}

/**
 * Which analyzer tier a scanned source file belongs to. Reliable tiers use
 * per-language declaration patterns; experimental and generic tiers use the
 * whole-word heuristic path only.
 */
export type AnalyzerTier = "reliable" | "experimental" | "generic";

/** File extensions scanned under each analyzer tier (lowercase, with dot). */
export interface AnalyzerBreakdown {
  reliable: string[];
  experimental: string[];
  generic: string[];
}

/** Per-entity match evidence for a single diagram entity name. */
export interface ConsistencyEntityEvidence {
  /** Entity name extracted from the diagram. */
  name: string;
  /** Whether the name was found in the scanned codebase. */
  matched: boolean;
  /** Analyzer tiers of the scanned files that matched (empty when unmatched). */
  analyzers: AnalyzerTier[];
  /**
   * POSIX paths (relative to the searched directory) of scanned files that
   * matched, capped at a small bound; see matchedFileCount for the true total.
   */
  matchedFiles: string[];
  /** Total number of scanned files that matched, even when matchedFiles is capped. */
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
  /** True when the file scan reached the configured cap; unmatched results may be incomplete. */
  truncated: boolean;
  /** Maximum number of source files collected during the scan. */
  scanLimit: number;
  /** Human-readable warning when truncated is true, otherwise null. Paths and source are never included. */
  scanWarning: string | null;
  /** Entity names extracted from the diagram, in extraction order. */
  entities: string[];
  /** Extracted entities found in the scanned codebase. */
  matchedEntities: string[];
  /** Extracted entities NOT found in the scanned codebase. */
  unmatchedEntities: string[];
  /** File extensions actually scanned under each analyzer tier. */
  analyzers: AnalyzerBreakdown;
  /** Always "heuristic": results are evidence, never a definitive verdict. */
  confidence: "heuristic";
  /** Human-readable warning describing the heuristic limits of the result. */
  heuristicWarning: string;
  /** Per-entity evidence, in the same order as entities. */
  evidence: ConsistencyEntityEvidence[];
}

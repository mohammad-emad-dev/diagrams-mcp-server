// Compares entity names in a diagram (classes, components, interfaces)
// against identifiers in the codebase. A fast text heuristic, not a
// parser: it prefers real declarations but also accepts whole-word,
// case-insensitive, and filename matches. TypeScript files with a
// successful AST parse match on declarations (AST union regex) and the
// module basename only. Results are evidence, not proof.

import type {
  AnalyzerBreakdown,
  AnalyzerTier,
  ConsistencyCheckResult,
  DiagramType,
} from "../../types.js";
import { analyzerTierForExtension } from "./codeAnalysis.js";
import { MAX_SCAN_FILES, SCAN_TRUNCATED_WARNING } from "./scanning.js";
import type { SequenceEntityKind } from "./sequence/sequenceEntities.js";
import { extractSequenceEntities } from "./sequence/sequenceEntities.js";
import type { ScannedFile } from "./fileAnalysis.js";
import { scanCodebase } from "./fileAnalysis.js";
import { matchEntities } from "./entityMatching.js";

const HEURISTIC_WARNING =
  "Heuristic text matching only: matching prefers declarations but falls back " +
  "to whole-word occurrence, case/separator-insensitive comparison, and " +
  "file-basename comparison, so an incidental reference can count as a match. " +
  "Treat results as evidence, not a definitive verdict.";

/** Diagram under check: reporting path, raw source, and dialect. */
export interface DiagramInput {
  relativePath: string;
  source: string;
  type: DiagramType;
}

/** Analyzer tiers observed across the scanned extensions. */
function buildAnalyzerBreakdown(scanned: ScannedFile[]): AnalyzerBreakdown {
  const analyzers: AnalyzerBreakdown = {
    reliable: [],
    experimental: [],
    generic: [],
  };
  const seenExtensions: Record<AnalyzerTier, Set<string>> = {
    reliable: new Set(),
    experimental: new Set(),
    generic: new Set(),
  };
  for (const file of scanned) {
    const tier = analyzerTierForExtension(file.ext);
    if (!seenExtensions[tier].has(file.ext)) {
      seenExtensions[tier].add(file.ext);
      analyzers[tier].push(file.ext);
    }
  }
  for (const tier of Object.keys(analyzers) as AnalyzerTier[]) {
    analyzers[tier].sort();
  }
  return analyzers;
}

export async function checkConsistency(
  input: DiagramInput,
  codeRootDir: string,
): Promise<ConsistencyCheckResult> {
  const taggedEntities = extractSequenceEntities(input.source, input.type);
  const entities = taggedEntities.map((entry) => entry.name);
  const kinds = new Map<string, SequenceEntityKind>(
    taggedEntities.map((entry): [string, SequenceEntityKind] => [entry.name, entry.kind]),
  );
  const { scanned, truncated } = await scanCodebase(codeRootDir);
  const analyzers = buildAnalyzerBreakdown(scanned);
  const match = matchEntities(entities, kinds, scanned);

  return {
    diagramPath: input.relativePath,
    entitiesFound: entities.length,
    entitiesMatched: match.matched,
    entitiesUnmatched: entities.length - match.matched,
    issues: match.issues,
    searchedDirectory: codeRootDir,
    filesScanned: scanned.length,
    truncated,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: truncated ? SCAN_TRUNCATED_WARNING : null,
    entities: [...entities],
    matchedEntities: match.matchedEntities,
    unmatchedEntities: match.unmatchedEntities,
    analyzers,
    confidence: "heuristic",
    heuristicWarning: HEURISTIC_WARNING,
    evidence: match.evidence,
  };
}

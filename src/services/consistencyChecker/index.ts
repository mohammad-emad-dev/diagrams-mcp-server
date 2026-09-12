// Compares entity names in a diagram (classes, components, interfaces)
// against identifiers in the codebase. A fast text heuristic, not a
// parser: it prefers real declarations but also accepts whole-word,
// case-insensitive, and filename matches. TypeScript files with a
// successful AST parse match on declarations (AST union regex) and the
// module basename only. Results are evidence, not proof.

import { promises as fs } from "node:fs";
import path from "node:path";
import { toPosixPath } from "../../constants.js";
import type {
  AnalyzerBreakdown,
  AnalyzerTier,
  ConsistencyCheckResult,
  ConsistencyEntityEvidence,
  ConsistencyIssue,
  DiagramType,
} from "../../types.js";
import { extractEntities } from "./entities.js";
import {
  analyzerTierForExtension,
  extractDeclaredIdentifiers,
  familyForExtension,
  stripCommentsAndStrings,
} from "./codeAnalysis.js";
import { collectCodeFiles } from "./scanning.js";
import { analyzeTsFile } from "./ts/tsIndex.js";

const MAX_FILES_SCANNED = 5000;
const MAX_FILE_SIZE_BYTES = 1_000_000; // Skip oversized generated files.
const MAX_EVIDENCE_MATCHED_FILES = 10; // Cap matched files per entity.
const MAX_SCAN_CONCURRENCY = 32; // Bound concurrent file reads (EMFILE safety).

const HEURISTIC_WARNING =
  "Heuristic text matching only: matching prefers declarations but falls back " +
  "to whole-word occurrence, case/separator-insensitive comparison, and " +
  "file-basename comparison, so an incidental reference can count as a match. " +
  "Treat results as evidence, not a definitive verdict.";

const SCAN_TRUNCATED_WARNING =
  "Scan reached the 5,000-file limit and stopped early; unmatched results may be incomplete. " +
  "Narrow the scanned directory or split the check to complete verification.";

/** Lowercase, separator-free form for lenient matching. */
function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Whole-word pattern for one name, plus its declaration-like usages. */
function buildDeclarationPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bare identifier as a whole word.
  return new RegExp(`\\b${escaped}\\b`);
}

interface ScannedFile {
  /** POSIX path relative to the searched directory. */
  relativePath: string;
  /** Lowercase file extension. */
  ext: string;
  stripped: string;
  normalized: string;
  declared: Set<string>;
  moduleName: string;
  /** True when a TS AST parse succeeded; whole-word fallbacks are skipped. */
  tsStrict: boolean;
}

/** Indexes of scanned files matching one entity name. */
function findMatchingFileIndexes(entity: string, scanned: ScannedFile[]): number[] {
  const normalizedEntity = normalizeForMatch(entity);
  const pattern = buildDeclarationPattern(entity);
  const matched: number[] = [];
  for (let index = 0; index < scanned.length; index += 1) {
    const file = scanned[index];
    if (file.declared.has(entity)) {
      matched.push(index);
      continue;
    }
    if (file.moduleName === entity) {
      matched.push(index);
      continue;
    }
    if (
      normalizedEntity.length > 0 &&
      file.moduleName.length > 0 &&
      normalizeForMatch(file.moduleName) === normalizedEntity
    ) {
      matched.push(index);
      continue;
    }
    if (file.tsStrict) continue;
    pattern.lastIndex = 0;
    if (pattern.test(file.stripped)) {
      matched.push(index);
      continue;
    }
    if (normalizedEntity.length > 0 && file.normalized.includes(` ${normalizedEntity} `)) {
      matched.push(index);
    }
  }
  return matched;
}

/** Read and analyze one file for the scan; null when unreadable or oversized. */
async function readScannedFile(codeRootDir: string, file: string): Promise<ScannedFile | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_SIZE_BYTES) return null;
    const raw = await fs.readFile(file, "utf-8");
    const ext = path.extname(file).toLowerCase();
    const family = familyForExtension(ext);
    const stripped = stripCommentsAndStrings(raw, family);
    const declared = extractDeclaredIdentifiers(stripped, family);
    const tsAnalysis = await analyzeTsFile(raw, ext, file);
    for (const name of tsAnalysis.declared) declared.add(name);
    return {
      relativePath: toPosixPath(path.relative(codeRootDir, file)),
      ext,
      stripped,
      normalized: ` ${stripped.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `,
      declared,
      moduleName: path.basename(file, ext),
      tsStrict: tsAnalysis.strict,
    };
  } catch {
    // unreadable file (permissions, race condition); skip it
    return null;
  }
}

/** Map inputs through an async worker with bounded concurrency, order-preserving. */
async function mapWithConcurrency<T, R>(
  inputs: T[],
  concurrency: number,
  worker: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(concurrency, 1), Math.max(inputs.length, 1)) },
    async () => {
      while (next < inputs.length) {
        const index = next;
        next += 1;
        results[index] = await worker(inputs[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/** Diagram under check: reporting path, raw source, and dialect. */
export interface DiagramInput {
  relativePath: string;
  source: string;
  type: DiagramType;
}

/** Scan the codebase: collect files, then read and analyze each one. */
async function scanCodebase(
  codeRootDir: string,
): Promise<{ scanned: ScannedFile[]; truncated: boolean }> {
  const { files: codeFiles, truncated } = await collectCodeFiles(codeRootDir, MAX_FILES_SCANNED);
  const scanned = (
    await mapWithConcurrency(codeFiles, MAX_SCAN_CONCURRENCY, (file) =>
      readScannedFile(codeRootDir, file),
    )
  ).filter((entry): entry is ScannedFile => entry !== null);
  return { scanned, truncated };
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

interface EntityMatchResult {
  matched: number;
  matchedEntities: string[];
  unmatchedEntities: string[];
  issues: ConsistencyIssue[];
  evidence: ConsistencyEntityEvidence[];
}

/** Match every entity against the scanned files, collecting issues and evidence. */
function matchEntities(entities: string[], scanned: ScannedFile[]): EntityMatchResult {
  const issues: ConsistencyIssue[] = [];
  const evidence: ConsistencyEntityEvidence[] = [];
  const matchedEntities: string[] = [];
  const unmatchedEntities: string[] = [];
  let matched = 0;

  for (const entity of entities) {
    const matchIndexes = findMatchingFileIndexes(entity, scanned);
    const isMatched = matchIndexes.length > 0;
    if (isMatched) {
      matched++;
      matchedEntities.push(entity);
    } else {
      unmatchedEntities.push(entity);
      issues.push({
        name: entity,
        issue: `'${entity}' appears in the diagram but no matching identifier was found in the scanned codebase. It may be renamed, removed, or not yet implemented.`,
        severity: "warning",
      });
    }
    const matchedTiers = [
      ...new Set(matchIndexes.map((index) => analyzerTierForExtension(scanned[index].ext))),
    ].sort();
    const allMatchedFiles = matchIndexes.map((index) => scanned[index].relativePath);
    evidence.push({
      name: entity,
      matched: isMatched,
      analyzers: matchedTiers,
      matchedFiles: allMatchedFiles.slice(0, MAX_EVIDENCE_MATCHED_FILES),
      matchedFileCount: allMatchedFiles.length,
    });
  }

  return { matched, matchedEntities, unmatchedEntities, issues, evidence };
}

export async function checkConsistency(
  input: DiagramInput,
  codeRootDir: string,
): Promise<ConsistencyCheckResult> {
  const entities = extractEntities(input.source, input.type);
  const { scanned, truncated } = await scanCodebase(codeRootDir);
  const analyzers = buildAnalyzerBreakdown(scanned);
  const match = matchEntities(entities, scanned);

  return {
    diagramPath: input.relativePath,
    entitiesFound: entities.length,
    entitiesMatched: match.matched,
    entitiesUnmatched: entities.length - match.matched,
    issues: match.issues,
    searchedDirectory: codeRootDir,
    filesScanned: scanned.length,
    truncated,
    scanLimit: MAX_FILES_SCANNED,
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

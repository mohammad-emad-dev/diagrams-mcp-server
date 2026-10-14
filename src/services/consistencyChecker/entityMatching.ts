import type { ConsistencyEntityEvidence, ConsistencyIssue } from "../../types.js";
import { analyzerTierForExtension } from "./codeAnalysis.js";
import type { ScannedFile } from "./fileAnalysis.js";
import { normalizeForMatch } from "../nameNormalize.js";
import type { SequenceEntityKind } from "./sequence/sequenceEntities.js";
import { sequenceIssueText } from "./sequence/sequenceMatch.js";

const MAX_EVIDENCE_MATCHED_FILES = 10; // Cap matched files per entity.

/** Whole-word fallback for names not matched by declared identifiers. */
function buildDeclarationPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

interface EntityQuery {
  entity: string;
  normalizedEntity: string;
  pattern: RegExp;
}

function matchesTextFallback(query: EntityQuery, file: ScannedFile): boolean {
  query.pattern.lastIndex = 0;
  if (query.pattern.test(file.stripped)) return true;
  return (
    query.normalizedEntity.length > 0 && file.normalized.includes(` ${query.normalizedEntity} `)
  );
}

// AST declarations omit some operation shapes, including methods, so keep text fallback.
function matchesOperation(query: EntityQuery, file: ScannedFile): boolean {
  return file.operations.has(query.entity) || matchesTextFallback(query, file);
}

// AST-backed structural names need declaration or module evidence, not incidental text.
function matchesStructural(query: EntityQuery, file: ScannedFile): boolean {
  if (file.declared.has(query.entity)) return true;
  if (file.moduleName === query.entity) return true;
  if (
    query.normalizedEntity.length > 0 &&
    file.moduleName.length > 0 &&
    normalizeForMatch(file.moduleName) === query.normalizedEntity
  ) {
    return true;
  }
  if (file.tsStrict) return false;
  return matchesTextFallback(query, file);
}

/** Indexes of scanned files matching one entity name. */
function findMatchingFileIndexes(
  entity: string,
  kind: SequenceEntityKind,
  scanned: ScannedFile[],
): number[] {
  const query: EntityQuery = {
    entity,
    normalizedEntity: normalizeForMatch(entity),
    pattern: buildDeclarationPattern(entity),
  };
  const matches = kind === "operation" ? matchesOperation : matchesStructural;
  const matched: number[] = [];
  for (let index = 0; index < scanned.length; index += 1) {
    if (matches(query, scanned[index])) matched.push(index);
  }
  return matched;
}

interface EntityMatchResult {
  matched: number;
  matchedEntities: string[];
  unmatchedEntities: string[];
  issues: ConsistencyIssue[];
  evidence: ConsistencyEntityEvidence[];
}

/** Match every entity against the scanned files, collecting issues and evidence. */
export function matchEntities(
  entities: string[],
  kinds: Map<string, SequenceEntityKind>,
  scanned: ScannedFile[],
): EntityMatchResult {
  const issues: ConsistencyIssue[] = [];
  const evidence: ConsistencyEntityEvidence[] = [];
  const matchedEntities: string[] = [];
  const unmatchedEntities: string[] = [];
  let matched = 0;

  for (const entity of entities) {
    const kind = kinds.get(entity) ?? "structural";
    const matchIndexes = findMatchingFileIndexes(entity, kind, scanned);
    const isMatched = matchIndexes.length > 0;
    if (isMatched) {
      matched++;
      matchedEntities.push(entity);
    } else {
      unmatchedEntities.push(entity);
      issues.push({
        name: entity,
        issue: sequenceIssueText(entity, kind),
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

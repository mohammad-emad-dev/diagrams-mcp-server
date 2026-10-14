// Entity collection for diagrams_generate: scan a scope under the project
// root and turn its declarations into an ordered entity list, plus the
// extends/implements edges that can be evidenced from the TypeScript AST.
//
// Reuses the consistency checker's scan stack (collectCodeFiles, scan caps,
// mapWithConcurrency) and its AST/heuristic analysis, so both tools agree on
// what a "declared identifier" is. The only new behavior is emission order:
// files are visited in POSIX-path order and, when the TypeScript parser is
// available, within-file declaration order is kept from the AST.

import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_GENERATE_ENTITIES, MAX_GENERATE_RELATIONS, toPosixPath } from "../../constants.js";
import type { TsModule } from "../consistencyChecker/ts/tsParse.js";
import { isTsFamilyExtension, loadTsModule } from "../consistencyChecker/ts/tsParse.js";
import { analyzeTsFile } from "../consistencyChecker/ts/tsIndex.js";
import {
  extractDeclaredIdentifiers,
  familyForExtension,
  stripCommentsAndStrings,
} from "../consistencyChecker/codeAnalysis.js";
import {
  GENERATE_SCAN_TRUNCATED_WARNING,
  mapWithConcurrency,
  MAX_SCAN_CONCURRENCY,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_FILES,
} from "../consistencyChecker/scanning.js";
import { listScopeFiles } from "./scopeFiles.js";

import type {
  CollectOptions,
  EntityCollectionResult,
  GenerateDeps,
  RelationEdge,
} from "./types.js";
export type { CollectOptions, EntityCollectionResult, GenerateDeps, RelationEdge };

interface ScannedScopeFile {
  /** Absolute path; only used for emission ordering. */
  absolutePath: string;
  /** Lowercase extension. */
  ext: string;
  entities: string[];
  relations: RelationEdge[];
}

const EMPTY_SCOPE_NOTE =
  "no code files found in the scanned scope; check the scope path or add code files";

const RELATIONS_DISABLED_NOTE =
  "relations omitted: include_relations is false; pass true to add extends/implements edges";

const NO_COMPILER_NOTE =
  "relations unavailable: the TypeScript compiler is not installed; entities only";

const NO_TS_FILES_NOTE =
  "relations unavailable: no TypeScript-family files in the scanned scope; " +
  "relations are read from TypeScript extends/implements clauses only";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Empty result for a scope with no code files; fresh object per caller. */
function emptyResult(): EntityCollectionResult {
  return {
    entities: [],
    relations: [],
    entitiesAvailable: 0,
    relationsAvailable: 0,
    entitiesDropped: 0,
    relationsDropped: 0,
    filesScanned: 0,
    truncated: false,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: null,
    dialectNote: EMPTY_SCOPE_NOTE,
    tsAstAvailable: false,
  };
}

/**
 * Merge ordered name lists into one, keeping the first occurrence of each
 * name: earlier lists (AST declarations) win over later ones (heuristic
 * matches). Casing is preserved and compared exactly.
 */
function mergeDeclarations(nameLists: Iterable<string>[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const names of nameLists) {
    for (const name of names) {
      if (!seen.has(name)) {
        seen.add(name);
        merged.push(name);
      }
    }
  }
  return merged;
}

async function analyzeScopeFile(request: {
  sourceText: string;
  filePath: string;
  includeRelations: boolean;
  compiler: TsModule | null;
}): Promise<ScannedScopeFile> {
  const { sourceText, filePath, includeRelations, compiler } = request;
  const ext = path.extname(filePath).toLowerCase();
  const family = familyForExtension(ext);
  const stripped = stripCommentsAndStrings(sourceText, family);

  const nameLists: Iterable<string>[] = [];
  let relations: RelationEdge[] = [];
  if (isTsFamilyExtension(ext)) {
    const analysis = await analyzeTsFile(sourceText, ext, filePath, {
      ts: compiler,
      includeRelations,
    });
    // AST names first so a parsed file emits in source-declaration order;
    // heuristic-only names follow for shapes the visitor does not read.
    nameLists.push(analysis.declared, extractDeclaredIdentifiers(stripped, family));
    relations = analysis.relations;
  } else {
    nameLists.push(extractDeclaredIdentifiers(stripped, family));
  }

  return { absolutePath: filePath, ext, entities: mergeDeclarations(nameLists), relations };
}

/** Unreadable and oversized files are skipped; unexpected failures propagate. */
async function readScopeFile(
  file: string,
  includeRelations: boolean,
  compiler: TsModule | null,
): Promise<ScannedScopeFile | null> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    if (Buffer.byteLength(raw, "utf-8") > MAX_SCAN_FILE_BYTES) return null;
    return await analyzeScopeFile({ sourceText: raw, filePath: file, includeRelations, compiler });
  } catch (err: unknown) {
    // Skip unreadable files; unexpected failures must surface instead of
    // silently shrinking the entity list.
    const skippable =
      isNodeError(err) &&
      (err.code === "ENOENT" ||
        err.code === "EACCES" ||
        err.code === "EPERM" ||
        err.code === "ENOTDIR" ||
        err.code === "EISDIR");
    if (!skippable) throw err;
    return null;
  }
}

/** Distinct entity names across files, first occurrence wins (emission order). */
function mergeEntities(scanned: ScannedScopeFile[]): string[] {
  return mergeDeclarations(scanned.map((file) => file.entities));
}

/** Distinct edges whose both endpoints are declared somewhere in the scope. */
function evidencedEdges(scanned: ScannedScopeFile[], declared: Set<string>): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const seen = new Set<string>();
  for (const file of scanned) {
    for (const edge of file.relations) {
      if (edge.from === edge.to) continue;
      if (!declared.has(edge.from) || !declared.has(edge.to)) continue;
      const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges;
}

/**
 * Collect entities from a resolved scope. Unreadable files are skipped and a
 * missing compiler uses heuristic analysis. Unexpected failures propagate.
 */
export async function collectScopeEntities(
  scopePath: string,
  options?: CollectOptions,
): Promise<EntityCollectionResult> {
  const includeRelations = options?.includeRelations === true;
  const maxEntities = options?.maxEntities ?? MAX_GENERATE_ENTITIES;
  const maxRelations = options?.maxRelations ?? MAX_GENERATE_RELATIONS;

  const { files, truncated } = await listScopeFiles(scopePath);
  if (files.length === 0) return emptyResult();

  // Resolve the compiler once for the whole scan; null keeps the heuristic
  // path and records that relations cannot be evidenced. Resolve the seam
  // before awaiting: a `??` on the promise itself would always look non-null
  // and never fall back, hiding a null seam behind the real compiler.
  const resolveCompiler = options?.deps?.loadTsModule ?? loadTsModule;
  const compiler = await resolveCompiler();

  const scanned = (
    await mapWithConcurrency(files, MAX_SCAN_CONCURRENCY, (file) =>
      readScopeFile(file, includeRelations, compiler),
    )
  ).filter((entry): entry is ScannedScopeFile => entry !== null);

  // Deterministic emission order: POSIX path order, then within-file order.
  scanned.sort((a, b) => toPosixPath(a.absolutePath).localeCompare(toPosixPath(b.absolutePath)));

  const all = mergeEntities(scanned);
  const entities = all.slice(0, maxEntities);
  const included = new Set(entities);

  // A diagram must never reference a box it does not declare, so edges
  // dropped by the entity cap are excluded before the relation cap applies.
  const evidenced = evidencedEdges(scanned, new Set(all));
  const relations = evidenced
    .filter((edge) => included.has(edge.from) && included.has(edge.to))
    .slice(0, maxRelations);

  return {
    entities,
    relations,
    entitiesAvailable: all.length,
    relationsAvailable: evidenced.length,
    entitiesDropped: all.length - entities.length,
    relationsDropped: evidenced.length - relations.length,
    filesScanned: scanned.length,
    truncated,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: truncated ? GENERATE_SCAN_TRUNCATED_WARNING : null,
    dialectNote: dialectNoteFor(includeRelations, compiler, scanned),
    tsAstAvailable: compiler !== null,
  };
}

function dialectNoteFor(
  includeRelations: boolean,
  compiler: TsModule | null,
  scanned: ScannedScopeFile[],
): string | null {
  if (!includeRelations) return RELATIONS_DISABLED_NOTE;
  if (compiler === null) return NO_COMPILER_NOTE;
  if (!scanned.some((file) => isTsFamilyExtension(file.ext))) return NO_TS_FILES_NOTE;
  return null;
}

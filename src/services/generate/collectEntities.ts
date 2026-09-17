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

/** Read and analyze one file; null when unreadable, oversized, or unparseable. */
async function readScopeFile(
  file: string,
  includeRelations: boolean,
  compiler: TsModule | null,
): Promise<ScannedScopeFile | null> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    if (Buffer.byteLength(raw, "utf-8") > MAX_SCAN_FILE_BYTES) return null;
    const ext = path.extname(file).toLowerCase();
    const family = familyForExtension(ext);
    const stripped = stripCommentsAndStrings(raw, family);

    const entities: string[] = [];
    const seen = new Set<string>();
    const push = (name: string): void => {
      if (!seen.has(name)) {
        seen.add(name);
        entities.push(name);
      }
    };

    let relations: RelationEdge[] = [];
    if (isTsFamilyExtension(ext)) {
      const analysis = await analyzeTsFile(raw, ext, file, { ts: compiler, includeRelations });
      // AST names first so a parsed file emits in source-declaration order;
      // heuristic-only names follow for shapes the visitor does not read.
      for (const name of analysis.declared) push(name);
      for (const name of extractDeclaredIdentifiers(stripped, family)) push(name);
      relations = analysis.relations;
    } else {
      for (const name of extractDeclaredIdentifiers(stripped, family)) push(name);
    }

    return { absolutePath: file, ext, entities, relations };
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
  const entities: string[] = [];
  const seen = new Set<string>();
  for (const file of scanned) {
    for (const name of file.entities) {
      if (!seen.has(name)) {
        seen.add(name);
        entities.push(name);
      }
    }
  }
  return entities;
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
 * Collect entities from a resolved scope. Never throws: unreadable files and
 * a missing compiler both degrade to fewer entities with an in-band note.
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

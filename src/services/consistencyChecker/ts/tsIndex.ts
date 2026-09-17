// Glue between the AST layer and the existing ScannedFile shape.
//
// analyzeTsFile returns the AST-declared set plus a strict flag: when a TS
// family file parses, matching uses declarations (AST union regex) and the
// module basename only. Any other case (non-TS extension, missing compiler,
// syntax errors) reports strict false and the caller keeps the full
// heuristic cascade.
//
// Relations (extends/implements) are opt-in: only diagrams_generate reads
// them, and only when the compiler resolved. The consistency checker asks
// for declarations only, so its results are unchanged.

import { collectTsHeritage } from "./tsHeritage.js";
import type { HeritageEdge } from "./tsHeritage.js";
import { collectTsDeclaredSymbols } from "./tsSymbols.js";
import { isTsFamilyExtension, loadTsModule, parseTsSource } from "./tsParse.js";
import type { TsModule } from "./tsParse.js";

export interface TsFileAnalysis {
  /** AST-declared names; empty when not applicable. */
  declared: Set<string>;
  /** True when the file parsed and strict matching applies. */
  strict: boolean;
  /** Heritage edges; empty unless relations were requested. */
  relations: HeritageEdge[];
}

/** Caller-supplied compiler and analysis switches; all optional. */
export interface TsAnalysisOptions {
  /**
   * Pre-resolved compiler: undefined resolves it by dynamic import (the
   * default), null records that it is not installed, a module is used as
   * given. Diagrams_generate pins null to exercise the fallback path.
   */
  ts?: TsModule | null;
  /** Collect extends/implements edges alongside declarations. */
  includeRelations?: boolean;
}

/** Analyze one file; never throws, falls back to `{ empty, strict false }`. */
export async function analyzeTsFile(
  rawText: string,
  ext: string,
  filePath: string,
  options?: TsAnalysisOptions,
): Promise<TsFileAnalysis> {
  const fallback: TsFileAnalysis = {
    declared: new Set<string>(),
    strict: false,
    relations: [],
  };
  if (!isTsFamilyExtension(ext)) return fallback;
  const compiler = options?.ts === undefined ? await loadTsModule() : options.ts;
  // No compiler means no AST at all: keep the strict flag down and let the
  // caller fall back to the heuristic cascade.
  if (compiler === null) return fallback;
  const sourceFile = await parseTsSource(filePath, rawText, compiler);
  if (!sourceFile) return fallback;
  const declared = await collectTsDeclaredSymbols(sourceFile, compiler);
  const relations =
    options?.includeRelations === true ? collectTsHeritage(sourceFile, compiler) : [];
  return { declared, strict: true, relations };
}

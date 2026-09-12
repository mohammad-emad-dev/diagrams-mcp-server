// Glue between the AST layer and the existing ScannedFile shape.
//
// analyzeTsFile returns the AST-declared set plus a strict flag: when a TS
// family file parses, matching uses declarations (AST union regex) and the
// module basename only. Any other case (non-TS extension, missing compiler,
// syntax errors) reports strict false and the caller keeps the full
// heuristic cascade.

import { collectTsDeclaredSymbols } from "./tsSymbols.js";
import { isTsFamilyExtension, parseTsSource } from "./tsParse.js";

export interface TsFileAnalysis {
  /** AST-declared names; empty when not applicable. */
  declared: Set<string>;
  /** True when the file parsed and strict matching applies. */
  strict: boolean;
}

/** Analyze one file; never throws, falls back to `{ empty, strict false }`. */
export async function analyzeTsFile(
  rawText: string,
  ext: string,
  filePath: string,
): Promise<TsFileAnalysis> {
  const fallback: TsFileAnalysis = { declared: new Set<string>(), strict: false };
  if (!isTsFamilyExtension(ext)) return fallback;
  const sourceFile = await parseTsSource(filePath, rawText);
  if (!sourceFile) return fallback;
  return { declared: await collectTsDeclaredSymbols(sourceFile), strict: true };
}

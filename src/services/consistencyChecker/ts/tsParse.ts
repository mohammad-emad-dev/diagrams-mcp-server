// TypeScript source parsing behind an isolated compiler boundary.
//
// The compiler is resolved by dynamic import only (never a static import),
// so published installs without `typescript` keep working on the regex
// fallback. All failures (missing module, syntax errors, unknown shapes)
// resolve to null and the caller falls back without throwing.

import path from "node:path";
import type * as tsTypes from "typescript";

/** The dynamically imported compiler module (type-only import keeps it erasable). */
export type TsModule = typeof import("typescript");

const TS_FAMILY_SCRIPT_KINDS = new Set([".ts", ".tsx", ".mts", ".cts"]);

let cachedTsModule: TsModule | null | undefined;

export function isTsFamilyExtension(ext: string): boolean {
  return TS_FAMILY_SCRIPT_KINDS.has(ext);
}

/** Resolve the compiler once; null when it is not installed. */
export async function loadTsModule(): Promise<TsModule | null> {
  if (cachedTsModule !== undefined) return cachedTsModule;
  try {
    cachedTsModule = (await import("typescript")) as TsModule;
  } catch {
    cachedTsModule = null;
  }
  return cachedTsModule;
}

/** True when the TypeScript compiler resolves via dynamic import. */
export async function isTsAstAvailable(): Promise<boolean> {
  return (await loadTsModule()) !== null;
}

/**
 * Parse one source file; null when unavailable, non-TS, or unparseable.
 *
 * `ts` is a pre-resolved compiler: undefined resolves it by dynamic import
 * (the default), null records that it is not installed, and a module is used
 * as given. Callers that already resolved the compiler pass it here so one
 * resolution serves the whole scan.
 */
export async function parseTsSource(
  filePath: string,
  rawText: string,
  ts?: TsModule | null,
): Promise<unknown> {
  const ext = path.extname(filePath).toLowerCase();
  if (!isTsFamilyExtension(ext)) return null;
  const compiler = ts === undefined ? await loadTsModule() : ts;
  if (!compiler) return null;
  try {
    const scriptKind = ext === ".tsx" ? compiler.ScriptKind.TSX : compiler.ScriptKind.TS;
    const sourceFile: tsTypes.SourceFile = compiler.createSourceFile(
      filePath,
      rawText,
      compiler.ScriptTarget.Latest,
      false,
      scriptKind,
    );
    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown })
      .parseDiagnostics;
    if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) return null;
    return sourceFile;
  } catch {
    return null;
  }
}

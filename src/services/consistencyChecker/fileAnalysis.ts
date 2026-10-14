import { promises as fs } from "node:fs";
import path from "node:path";
import { toPosixPath } from "../../constants.js";
import {
  extractDeclaredIdentifiers,
  familyForExtension,
  stripCommentsAndStrings,
} from "./codeAnalysis.js";
import {
  collectCodeFiles,
  mapWithConcurrency,
  MAX_SCAN_CONCURRENCY,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_FILES,
} from "./scanning.js";
import { analyzeTsFile } from "./ts/tsIndex.js";
import { buildOperationIndex } from "./sequence/operationIndex.js";

const MAX_FILE_SIZE_BYTES = MAX_SCAN_FILE_BYTES; // Skip oversized generated files.

export interface ScannedFile {
  /** POSIX path relative to the searched directory. */
  relativePath: string;
  /** Lowercase file extension. */
  ext: string;
  stripped: string;
  normalized: string;
  declared: Set<string>;
  moduleName: string;
  /** Operation names visible in this file (V1: the declared set). */
  operations: Set<string>;
  /** True when a TS AST parse succeeded; whole-word fallbacks are skipped. */
  tsStrict: boolean;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
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
      operations: buildOperationIndex(declared),
      tsStrict: tsAnalysis.strict,
    };
  } catch (err: unknown) {
    // Skip files that cannot be read; anything else (analyzer-internal
    // failures) must surface instead of silently dropping evidence.
    const skippable =
      isNodeError(err) &&
      (err.code === "ENOENT" ||
        err.code === "EACCES" ||
        err.code === "EPERM" ||
        err.code === "ENOTDIR" ||
        err.code === "EISDIR");
    if (!skippable) {
      throw err;
    }
    return null;
  }
}

/** Scan the codebase: collect files, then read and analyze each one. */
export async function scanCodebase(
  codeRootDir: string,
): Promise<{ scanned: ScannedFile[]; truncated: boolean }> {
  const { files: codeFiles, truncated } = await collectCodeFiles(codeRootDir, MAX_SCAN_FILES);
  const scanned = (
    await mapWithConcurrency(codeFiles, MAX_SCAN_CONCURRENCY, (file) =>
      readScannedFile(codeRootDir, file),
    )
  ).filter((entry): entry is ScannedFile => entry !== null);
  return { scanned, truncated };
}

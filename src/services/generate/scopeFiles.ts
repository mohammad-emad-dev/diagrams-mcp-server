// Scope file listing shared by the two generators (class and sequence).
//
// Both take a scope that may be one code file or a directory under the
// project root, and both must list it the same way: a missing scope yields
// no files rather than an error, and a directory walk stops at MAX_SCAN_FILES.
// Keeping this in one module means the two tools cannot disagree on which
// files a scope covers.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectCodeFiles,
  isCodeExtension,
  MAX_SCAN_FILES,
} from "../consistencyChecker/scanning.js";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * List the code files a resolved scope covers: one file, a capped directory
 * walk, or nothing when the scope is missing or not a code file.
 */
export async function listScopeFiles(
  scopePath: string,
): Promise<{ files: string[]; truncated: boolean }> {
  let stat;
  try {
    stat = await fs.stat(scopePath);
  } catch (err: unknown) {
    // A missing or unreadable scope is not an error: it yields an empty
    // result with a note. Anything else (I/O failure) must surface.
    const skippable =
      isNodeError(err) && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM");
    if (skippable) return { files: [], truncated: false };
    throw err;
  }
  if (stat.isFile()) {
    const scoped = isCodeExtension(path.extname(scopePath).toLowerCase()) ? [scopePath] : [];
    return { files: scoped, truncated: false };
  }
  if (stat.isDirectory()) {
    return collectCodeFiles(scopePath, MAX_SCAN_FILES);
  }
  return { files: [], truncated: false };
}

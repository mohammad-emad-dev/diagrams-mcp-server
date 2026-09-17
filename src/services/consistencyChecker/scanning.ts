// Filesystem scan: ignored directories, code extensions, scan limits,
// and the recursive directory walker.
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "target",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".cs",
  ".go",
  ".rb",
  ".php",
  ".kt",
  ".rs",
  ".swift",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
]);

export function isCodeExtension(ext: string): boolean {
  return CODE_EXTENSIONS.has(ext);
}

// Scan caps shared by the consistency checker and diagram generation, so a
// capped scan reports the same bounds everywhere. Every bound is surfaced
// in-band when it bites (truncated / scan_limit / scan_warning).
export const MAX_SCAN_FILES = 5000;
export const MAX_SCAN_FILE_BYTES = 1_000_000; // Skip oversized generated files.
export const MAX_SCAN_CONCURRENCY = 32; // Bound concurrent file reads (EMFILE safety).

// Shared truncation wording; each tool names what may be incomplete.
export const SCAN_TRUNCATED_WARNING =
  "Scan reached the 5,000-file limit and stopped early; unmatched results may be incomplete. " +
  "Narrow the scanned directory or split the check to complete verification.";

export const GENERATE_SCAN_TRUNCATED_WARNING =
  "Scan reached the 5,000-file limit and stopped early; generated entities may be incomplete. " +
  "Narrow the scanned scope or split the generation to cover the rest.";

export const SEQUENCE_SCAN_TRUNCATED_WARNING =
  "Scan reached the 5,000-file limit and stopped early; generated messages may be incomplete. " +
  "Narrow the scanned scope or split the generation to cover the rest.";

/** Map inputs through an async worker with bounded concurrency, order-preserving. */
export async function mapWithConcurrency<T, R>(
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

export async function collectCodeFiles(
  rootDir: string,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  // Single cap-guard for the walk-entry, per-entry, and post-walk checks:
  // same early-exit point, same truncation flag.
  const isCapped = (): boolean => {
    if (files.length >= maxFiles) {
      truncated = true;
      return true;
    }
    return false;
  };

  const walk = async (dir: string): Promise<void> => {
    if (isCapped()) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      // Skip missing/unreadable directories; anything else (I/O errors,
      // name too long) must surface instead of silently truncating the scan.
      const skippable =
        isNodeError(err) &&
        (err.code === "ENOENT" ||
          err.code === "EACCES" ||
          err.code === "EPERM" ||
          err.code === "ENOTDIR");
      if (!skippable) {
        throw err;
      }
      return;
    }
    for (const entry of entries) {
      if (isCapped()) {
        return;
      }
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  };

  await walk(rootDir);
  isCapped();
  return { files, truncated };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

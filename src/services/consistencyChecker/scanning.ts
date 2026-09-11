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
    } catch {
      return; // unreadable directory, skip
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

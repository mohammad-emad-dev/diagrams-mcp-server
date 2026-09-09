/**
 * diagramStore: safe, filesystem-backed CRUD for diagram files.
 *
 * All paths are resolved relative to a configured root directory
 * (DIAGRAMS_ROOT). Path traversal outside that root is rejected to avoid
 * an agent accidentally (or maliciously) reading/writing arbitrary files.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { EXTENSION_TO_TYPE, toPosixPath } from "../constants.js";
import type { DiagramFile, DiagramType } from "../types.js";
import { validateDiagramSource } from "./diagramValidator.js";

export { DiagramValidationError } from "./diagramValidator.js";

export class PathTraversalError extends Error {
  constructor(attemptedPath: string) {
    super(
      `Refused to access path outside the diagrams root: '${attemptedPath}'. ` +
        `Use a relative path inside the configured diagrams directory.`,
    );
    this.name = "PathTraversalError";
  }
}

export class DiagramNotFoundError extends Error {
  constructor(relativePath: string) {
    super(`No diagram found at '${relativePath}'.`);
    this.name = "DiagramNotFoundError";
  }
}

export class UnsupportedDiagramExtensionError extends Error {
  constructor(relativePath: string) {
    super(
      `'${relativePath}' does not have a recognized diagram extension (.puml, .plantuml, .mmd, .mermaid).`,
    );
    this.name = "UnsupportedDiagramExtensionError";
  }
}

export class DiagramExistsError extends Error {
  constructor(relativePath: string) {
    super(
      `Diagram '${relativePath}' already exists. Use diagrams_update to modify it, or set overwrite=true.`,
    );
    this.name = "DiagramExistsError";
  }
}

export class DiagramStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  getRoot(): string {
    return this.root;
  }

  /** Resolve a user-supplied relative path safely inside the root. */
  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new PathTraversalError(toPosixPath(relativePath));
    }
    return resolved;
  }

  /**
   * Reject any resolved path where the target or one of its ancestor
   * directories inside the root is a symlink. The lexical check in
   * resolveSafe() cannot see through links, so without this a symlink
   * inside the root pointing outside would let read/write/delete follow
   * it to an external file. Missing path segments end the walk: there is
   * nothing left that could be a link.
   */
  private async assertNoSymlinkEscape(absolutePath: string): Promise<void> {
    const relative = path.relative(this.root, absolutePath);
    const segments = relative
      .split(path.sep)
      .filter((segment) => segment.length > 0 && segment !== ".");
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === "ENOENT") {
          return;
        }
        throw err;
      }
      if (stat.isSymbolicLink()) {
        throw new PathTraversalError(toPosixPath(relative));
      }
    }
  }

  private detectType(filePath: string): DiagramType | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_TO_TYPE[ext] ?? null;
  }

  /** Best-effort title extraction for PlantUML/Mermaid content. */
  private extractTitle(content: string, type: DiagramType): string | null {
    if (type === "plantuml") {
      const match = content.match(/^\s*title\s+(.+)$/m);
      if (match) return match[1].trim();
    } else {
      // Mermaid: look for a leading "%% title: ..." comment, or the
      // diagram declaration line as a fallback.
      const commentMatch = content.match(/^\s*%%\s*title:\s*(.+)$/m);
      if (commentMatch) return commentMatch[1].trim();
    }
    return null;
  }

  async ensureRootExists(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Recursively list all diagram files under the root. */
  async list(): Promise<DiagramFile[]> {
    await this.ensureRootExists();
    const results: DiagramFile[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isSymbolicLink()) {
          // Symlinked diagram paths are rejected by policy (see
          // assertNoSymlinkEscape), so listing skips them as well.
          continue;
        } else if (entry.isFile()) {
          const type = this.detectType(entry.name);
          if (!type) continue;
          const stat = await fs.stat(fullPath);
          const content = await fs.readFile(fullPath, "utf-8");
          results.push({
            relativePath: toPosixPath(path.relative(this.root, fullPath)),
            absolutePath: fullPath,
            type,
            title: this.extractTitle(content, type),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };

    await walk(this.root);
    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return results;
  }

  async read(relativePath: string): Promise<{ content: string; type: DiagramType }> {
    const absolutePath = this.resolveSafe(relativePath);
    await this.assertNoSymlinkEscape(absolutePath);
    const type = this.detectType(absolutePath);
    if (!type) {
      throw new UnsupportedDiagramExtensionError(toPosixPath(relativePath));
    }
    try {
      const content = await fs.readFile(absolutePath, "utf-8");
      return { content, type };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        throw new DiagramNotFoundError(toPosixPath(relativePath));
      }
      throw err;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    const absolutePath = this.resolveSafe(relativePath);
    await this.assertNoSymlinkEscape(absolutePath);
    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  async write(
    relativePath: string,
    content: string,
    options: { overwrite: boolean },
  ): Promise<void> {
    const absolutePath = this.resolveSafe(relativePath);
    await this.assertNoSymlinkEscape(absolutePath);
    const type = this.detectType(absolutePath);
    if (!type) {
      throw new UnsupportedDiagramExtensionError(toPosixPath(relativePath));
    }
    // Basic, dependency-free syntax check before any filesystem mutation, so
    // invalid content neither creates nor overwrites a file. This is not a
    // full parser: rendering remains the authoritative syntax check.
    validateDiagramSource(content, type);
    if (!options.overwrite && (await this.exists(relativePath))) {
      throw new DiagramExistsError(toPosixPath(relativePath));
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }

  async delete(relativePath: string): Promise<void> {
    const absolutePath = this.resolveSafe(relativePath);
    await this.assertNoSymlinkEscape(absolutePath);
    try {
      await fs.unlink(absolutePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        throw new DiagramNotFoundError(toPosixPath(relativePath));
      }
      throw err;
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

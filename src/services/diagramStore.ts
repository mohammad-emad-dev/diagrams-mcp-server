// Filesystem CRUD for diagram files, rooted at one directory.
// Paths escaping that root are rejected.

import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { EXTENSION_TO_TYPE, MAX_TITLE_SCAN_BYTES, toPosixPath } from "../constants.js";
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

// O_NOFOLLOW makes open fail with ELOOP instead of following a final
// symlink. Where the platform ignores it (0), the realpath checks above
// remain the enforcement.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export class DiagramStore {
  private readonly root: string;
  private rootReal: string | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private async getRootReal(): Promise<string> {
    if (this.rootReal === null) {
      try {
        this.rootReal = await fs.realpath(this.root);
      } catch {
        this.rootReal = this.root;
      }
    }
    return this.rootReal;
  }

  // realpath follows symlinks, so it sees what lstat-based checks can miss
  // in a swap-after-check race. Returns null when nothing exists there yet.
  private async realpathInsideRoot(
    absolutePath: string,
    relativeForError: string,
  ): Promise<string | null> {
    try {
      const real = await fs.realpath(absolutePath);
      const base = await this.getRootReal();
      const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
      if (real !== base && !real.startsWith(baseWithSep)) {
        throw new PathTraversalError(toPosixPath(relativeForError));
      }
      return real;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    }
  }

  getRoot(): string {
    return this.root;
  }

  // Resolve a user path inside the root. Backslashes count as
  // separators so Windows-style paths work on every platform.
  private resolveSafe(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/");
    const resolved = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new PathTraversalError(toPosixPath(relativePath));
    }
    return resolved;
  }

  // Reject paths that pass through a symlink inside the root.
  // A link pointing outside would otherwise bypass the root check.
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

  // Best-effort title from the scanned file prefix. Titles past the
  // window read as null; a title line cut at the window edge keeps its
  // scanned part with a "…" prefix (D-007) so it never passes as exact.
  private extractTitle(prefix: string, type: DiagramType, truncated: boolean): string | null {
    const pattern = type === "plantuml" ? /^\s*title\s+(.+)$/m : /^\s*%%\s*title:\s*(.+)$/m;
    const match = prefix.match(pattern);
    if (!match?.[1]) return null;
    const title = match[1].trim();
    const end = (match.index ?? 0) + match[0].length;
    const cut = truncated && end >= prefix.length;
    return cut ? `…${title}` : title;
  }

  // First bytes of a file through its already-open NOFOLLOW handle, so
  // title extraction never buffers a whole diagram and never re-opens
  // the path (no TOCTOU between the open and the read).
  private async readTitlePrefix(
    handle: FileHandle,
    size: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const length = Math.min(size, MAX_TITLE_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: buffer.toString("utf-8", 0, offset), truncated: size > offset };
  }

  async ensureRootExists(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Recursively list all diagram files under the root. */
  async list(): Promise<DiagramFile[]> {
    await this.ensureRootExists();
    const results: DiagramFile[] = [];

    const walk = async (dir: string): Promise<void> => {
      // A dir swapped to a symlink after the parent readdir must not
      // pull outside files into the listing.
      if ((await this.realpathInsideRoot(dir, path.relative(this.root, dir))) === null) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isSymbolicLink()) {
          // Skip symlinks; reads and writes reject them too.
          continue;
        } else if (entry.isFile()) {
          const type = this.detectType(entry.name);
          if (!type) continue;
          try {
            const handle = await fs.open(fullPath, fsConstants.O_RDONLY | NOFOLLOW);
            try {
              const stat = await handle.stat();
              const prefix = await this.readTitlePrefix(handle, stat.size);
              results.push({
                relativePath: toPosixPath(path.relative(this.root, fullPath)),
                absolutePath: fullPath,
                type,
                title: this.extractTitle(prefix.text, type, prefix.truncated),
                sizeBytes: stat.size,
                modifiedAt: stat.mtime.toISOString(),
              });
            } finally {
              await handle.close();
            }
          } catch (err: unknown) {
            // Swapped to a link (ELOOP) or removed (ENOENT) after readdir:
            // skip instead of following.
            if (isNodeError(err) && (err.code === "ELOOP" || err.code === "ENOENT")) continue;
            throw err;
          }
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
    // realpath sees a link swapped in after the lstat walk; null means missing.
    if ((await this.realpathInsideRoot(absolutePath, relativePath)) === null) {
      throw new DiagramNotFoundError(toPosixPath(relativePath));
    }
    let handle;
    try {
      handle = await fs.open(absolutePath, fsConstants.O_RDONLY | NOFOLLOW);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ELOOP") {
        throw new PathTraversalError(toPosixPath(relativePath));
      }
      if (isNodeError(err) && err.code === "ENOENT") {
        throw new DiagramNotFoundError(toPosixPath(relativePath));
      }
      throw err;
    }
    try {
      return { content: await handle.readFile("utf-8"), type };
    } finally {
      await handle.close();
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    const absolutePath = this.resolveSafe(relativePath);
    await this.assertNoSymlinkEscape(absolutePath);
    if ((await this.realpathInsideRoot(absolutePath, relativePath)) === null) {
      // Missing — but a dangling link still counts as an escape attempt
      // when the lstat walk saw it (preserves the symlink contract).
      return false;
    }
    let handle;
    try {
      handle = await fs.open(absolutePath, fsConstants.O_RDONLY | NOFOLLOW);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ELOOP") {
        throw new PathTraversalError(toPosixPath(relativePath));
      }
      // Only "missing" means absent; anything else (permissions, I/O)
      // is a real failure the caller must see.
      if (isNodeError(err) && err.code === "ENOENT") {
        return false;
      }
      throw err;
    }
    await handle.close();
    return true;
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
    // Validate before touching disk; invalid content writes nothing.
    validateDiagramSource(content, type);
    const parent = path.dirname(absolutePath);
    await fs.mkdir(parent, { recursive: true });
    // Parent swapped to a link after the walk must not redirect creation.
    if ((await this.realpathInsideRoot(parent, relativePath)) === null) {
      throw new PathTraversalError(toPosixPath(relativePath));
    }
    // Existing link swapped in after the walk must not be followed:
    // throws here when the link resolves outside; null (missing) is safe
    // to create. NOFOLLOW below turns a link raced in after this check
    // into ELOOP instead of a follow.
    await this.realpathInsideRoot(absolutePath, relativePath);
    const base = fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW;
    const flags = options.overwrite ? base | fsConstants.O_TRUNC : base | fsConstants.O_EXCL;
    let handle;
    try {
      // NOFOLLOW: a concurrent link loses with ELOOP instead of
      // redirecting the write outside. EXCL keeps the atomic-create
      // guarantee; a directory fails with EISDIR like before.
      handle = await fs.open(absolutePath, flags, 0o666);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ELOOP") {
        throw new PathTraversalError(toPosixPath(relativePath));
      }
      if (
        !options.overwrite &&
        isNodeError(err) &&
        (err.code === "EEXIST" || err.code === "EISDIR")
      ) {
        throw new DiagramExistsError(toPosixPath(relativePath));
      }
      throw err;
    }
    try {
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
  }

  async delete(relativePath: string): Promise<void> {
    const absolutePath = this.resolveSafe(relativePath);
    await this.assertNoSymlinkEscape(absolutePath);
    // Parent or file swapped to a link after the walk must not redirect
    // the unlink outside. realpath follows what lstat may have missed.
    const parentReal = await this.realpathInsideRoot(path.dirname(absolutePath), relativePath);
    if (parentReal === null) {
      throw new DiagramNotFoundError(toPosixPath(relativePath));
    }
    if ((await this.realpathInsideRoot(absolutePath, relativePath)) === null) {
      throw new DiagramNotFoundError(toPosixPath(relativePath));
    }
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

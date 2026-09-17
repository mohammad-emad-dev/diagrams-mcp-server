// Scope resolution for read-only tools that point at code under the project
// root. A scope is always relative; anything that resolves outside
// PROJECT_ROOT is refused before a single file is read.

import path from "node:path";
import { toPosixPath } from "../constants.js";

export class ScopeEscapeError extends Error {
  constructor(attemptedScope: string) {
    super(
      `Refused to resolve scope outside the project root: '${attemptedScope}'. ` +
        `Use a relative path inside the project root.`,
    );
    this.name = "ScopeEscapeError";
  }
}

export interface ResolvedScope {
  /** Absolute path inside the project root. */
  absolutePath: string;
  /** POSIX path relative to the project root; "." for the root itself. */
  relativePath: string;
}

// Absolute scopes are refused without echoing them: an absolute path must
// never reach user-facing output, so the refusal names the shape, not the value.
const ABSOLUTE_SCOPE_DETAIL = "an absolute path";

/**
 * Resolve a relative scope against the project root. Throws ScopeEscapeError
 * — reading nothing — when the result would land outside the root. Omitting
 * the scope means the whole project root, reported as ".".
 */
export function resolveScope(projectRoot: string, scope?: string): ResolvedScope {
  const requested = scope === undefined ? "" : scope.trim();
  const root = path.resolve(projectRoot);
  if (path.isAbsolute(requested)) {
    throw new ScopeEscapeError(ABSOLUTE_SCOPE_DETAIL);
  }
  const scopePath = requested.length === 0 ? "." : requested;
  const absolutePath = path.resolve(root, scopePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new ScopeEscapeError(toPosixPath(scopePath));
  }
  const relative = path.relative(root, absolutePath);
  return {
    absolutePath,
    relativePath: relative.length === 0 ? "." : toPosixPath(relative),
  };
}

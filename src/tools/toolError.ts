/**
 * toolError: shared MCP tool error normalization.
 *
 * Every tool distinguishes two cases:
 * - Expected domain errors (missing diagram, unsafe path, invalid source,
 *   unsupported extension, existing file, missing/broken renderer, invalid
 *   pagination/window): returned with `isError: true` and the original
 *   actionable message. These messages never contain source content,
 *   secrets, environment values, or absolute paths by construction.
 * - Unexpected programming/runtime errors (bugs, permission/IO failures):
 *   logged safely to stderr for local debugging and returned with
 *   `isError: true` plus a generic message. The user-facing text and the
 *   stderr log never include stack traces, diagram/code source, secrets,
 *   environment values, or absolute local paths.
 *
 * Handlers must never `catch (err)` with `instanceof Error` as the expected
 * branch: that hides programming bugs behind domain-error messages. Use
 * handleToolError() (typed domain set only) or handleRenderError() for the
 * diagrams_render render step, where a plain Error means a child-process
 * failure (timeout / non-zero exit / unreadable output / output limit)
 * by contract.
 */

import {
  DiagramExistsError,
  DiagramNotFoundError,
  DiagramValidationError,
  PathTraversalError,
  UnsupportedDiagramExtensionError,
} from "../services/diagramStore.js";
import { RenderError } from "../services/renderer.js";

export interface ToolErrorResult {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError: true;
  [key: string]: unknown;
}

const MAX_LOGGED_MESSAGE_CHARS = 500;

function redactAbsolutePaths(value: string): string {
  return (
    value
      // Windows drive paths (C:\..., C:/...) and UNC paths (\\host\...)
      .replace(/[A-Za-z]:[\\/][^\s"'`,;]*/g, "<redacted-path>")
      .replace(/\\\\[^\s"'`,;]*/g, "<redacted-path>")
      // POSIX absolute paths (/var/..., /tmp/x) but not relative paths (a/b)
      .replace(/(?<![\w.~+-])\/(?:[^\s"'`,;]+\/)*[^\s"'`,;]*/g, "<redacted-path>")
  );
}

function sanitizeForStderrLog(value: string): string {
  const singleLine = redactAbsolutePaths(value)
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (singleLine.length <= MAX_LOGGED_MESSAGE_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_LOGGED_MESSAGE_CHARS)}...`;
}

/** True for builtin programming-error subclasses (bugs), never domain errors. */
export function isProgrammingError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof RangeError ||
    err instanceof SyntaxError ||
    err instanceof URIError ||
    err instanceof EvalError
  );
}

/** True only for the typed domain errors each tool documents as expected. */
export function isExpectedToolError(err: unknown): err is Error {
  return (
    err instanceof DiagramNotFoundError ||
    err instanceof PathTraversalError ||
    err instanceof DiagramValidationError ||
    err instanceof DiagramExistsError ||
    err instanceof UnsupportedDiagramExtensionError ||
    err instanceof RenderError
  );
}

/**
 * Render-step classification for diagrams_render. After a successful diagram
 * read, any plain Error from renderDiagram() is a child-process failure
 * (renderer timeout, non-zero exit, unreadable output, output limit) and
 * stays expected
 * with its message. Programming-error subclasses and non-Error throws stay
 * unexpected so renderer bugs are never reported as render failures.
 */
export function isExpectedRenderError(err: unknown): err is Error {
  if (err instanceof RenderError) {
    return true;
  }
  if (err instanceof Error && !isProgrammingError(err)) {
    return true;
  }
  return false;
}

export function toExpectedToolErrorResult(err: Error): ToolErrorResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${err.message}` }],
    isError: true,
  };
}

export function toUnexpectedToolErrorResult(toolName: string): ToolErrorResult {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Error: Unexpected internal error in '${toolName}'. ` +
          `Check the server logs (stderr) for details and retry with narrower inputs.`,
      },
    ],
    isError: true,
  };
}

/**
 * Log an unexpected failure to stderr for local debugging. Logs only the
 * tool name and the error class: never call arguments (they may carry
 * diagram source), messages (they may carry secrets, code, environment
 * values, or absolute paths), stacks, or environment values.
 */
export function logUnexpectedToolError(toolName: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[${toolName}] unexpected error (${sanitizeForStderrLog(name)})`);
}

/** Normalize any caught failure: expected errors pass through, the rest get logged + generic. */
export function handleToolError(toolName: string, err: unknown): ToolErrorResult {
  if (isExpectedToolError(err)) {
    return toExpectedToolErrorResult(err);
  }
  logUnexpectedToolError(toolName, err);
  return toUnexpectedToolErrorResult(toolName);
}

/** Normalize render-step failures for diagrams_render (see isExpectedRenderError). */
export function handleRenderError(toolName: string, err: unknown): ToolErrorResult {
  if (isExpectedRenderError(err) && err instanceof Error) {
    return toExpectedToolErrorResult(err);
  }
  logUnexpectedToolError(toolName, err);
  return toUnexpectedToolErrorResult(toolName);
}

// Shared error handling for MCP tools. Expected domain errors pass
// through with their message; everything else becomes a generic error
// plus a safe stderr log. User-facing text never carries source,
// secrets, or absolute paths.

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

/** True for builtin programming-error subclasses, never domain errors. */
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

/** True only for the documented, expected domain errors. */
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

// Render-step errors for diagrams_render. After a successful read, any
// plain Error is a child-process failure and stays expected.
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

// Log an unexpected failure to stderr. Only the tool and error names;
// never arguments, messages, stacks, or environment values.
export function logUnexpectedToolError(toolName: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[${toolName}] unexpected error (${sanitizeForStderrLog(name)})`);
}

/** Expected errors pass through; the rest get logged and generalized. */
export function handleToolError(toolName: string, err: unknown): ToolErrorResult {
  if (isExpectedToolError(err)) {
    return toExpectedToolErrorResult(err);
  }
  logUnexpectedToolError(toolName, err);
  return toUnexpectedToolErrorResult(toolName);
}

/** Same as above, for the diagrams_render render step. */
export function handleRenderError(toolName: string, err: unknown): ToolErrorResult {
  if (isExpectedRenderError(err) && err instanceof Error) {
    return toExpectedToolErrorResult(err);
  }
  logUnexpectedToolError(toolName, err);
  return toUnexpectedToolErrorResult(toolName);
}

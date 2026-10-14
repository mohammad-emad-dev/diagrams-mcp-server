import { spawn } from "node:child_process";
import { MAX_RENDER_ERROR_CHARS, MAX_RENDER_OUTPUT_CHARS } from "../../constants.js";
import type { RendererDeps } from "./types.js";
import { RenderError } from "./error.js";

export async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const checker = spawn(process.platform === "win32" ? "where" : "which", [cmd]);
    checker.on("error", () => resolve(false));
    checker.on("close", (code) => resolve(code === 0));
  });
}

// Candidate names for one CLI. The bare name comes first, then Windows
// executable extensions so npm shims (e.g. `mmdc.cmd`) resolve. Detection
// and execution always use the same candidate that was found.
function resolveCandidates(cmd: string): string[] {
  return [cmd, `${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`];
}

// True when the executable itself could not be started.
function isLaunchFailure(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EINVAL") return true;
    return err.message.includes("ENOENT") || err.message.includes("EINVAL");
  }
  return false;
}

type LocalCommandOutcome = "ok" | "missing" | "unlaunchable";

// Run a local CLI using the first candidate that resolves. Falls through
// to the next candidate on launch failures; other errors propagate.
export async function runLocalCommand(
  cmd: string,
  args: string[],
  deps: Required<RendererDeps>,
): Promise<LocalCommandOutcome> {
  let detected = false;
  for (const candidate of resolveCandidates(cmd)) {
    if (!(await deps.commandExists(candidate))) continue;
    detected = true;
    try {
      await deps.runCommand(candidate, args);
      return "ok";
    } catch (err: unknown) {
      if (!isLaunchFailure(err)) throw err;
    }
  }
  return detected ? "unlaunchable" : "missing";
}

// Quote one argv element for the Windows command interpreter.
// Dual-layer quoting: MSVC C-runtime first, then cmd.exe. Safe chars pass
// through; everything else is wrapped in double quotes so & | < > ^ stay
// literal. Embedded quotes become \" (not ""), trailing backslashes double.
// % is deliberately NOT doubled: inside a quoted argument cmd.exe expands
// %VAR% regardless, so doubling only corrupts literal percent signs
// ("100%" -> "100%%") without buying any protection. The line is handed to
// cmd.exe verbatim (see runCommand), so no escaping of % is possible here.
function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(arg)) return arg;
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export interface SpawnTarget {
  cmd: string;
  args: string[];
}

// Batch shims (`.cmd`/`.bat`) cannot spawn directly, so on Windows they
// run through the command interpreter. Everything else spawns unchanged.
export function resolveSpawnTarget(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cmd)) {
    return { cmd, args };
  }
  const line = [cmd, ...args].map(quoteWindowsArg).join(" ");
  // cmd.exe /d /s /c strips the first and last quote when the command starts
  // with one. A quoted shim path (8.3 short names like C:\Users\RUNNER~1 on
  // CI, or any spaced directory) would lose its opening quote together with
  // the last argument's closing quote, failing with "The filename, directory
  // name, or volume label syntax is incorrect". An outer wrapper makes the
  // strip remove only the wrapper, leaving the inner command intact.
  const commandLine = line.startsWith('"') ? `"${line}"` : line;
  return {
    cmd: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

// Run a renderer CLI and collect stdout/stderr, each capped at
// MAX_RENDER_OUTPUT_CHARS. Over-limit output stops the child and rejects
// with a RenderError that never includes captured output. Timeouts are
// enforced by a timer (not the spawn option) so a lingering descendant
// holding the pipes cannot delay the error. A non-zero exit rejects with
// the stderr prefix (at most MAX_RENDER_ERROR_CHARS) so tool output never
// carries unbounded renderer text.
export function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ stdout: string; stderr: string }> {
  const target = resolveSpawnTarget(cmd, args);
  // When resolveSpawnTarget wrapped a .cmd/.bat shim it hand-quoted the
  // /c line; libuv must pass it through untouched or it re-quotes the
  // already-quoted path and splits every argument containing a space
  // (C:\sub dir\in.mmd arrives as three fragments with literal quotes).
  // Gated on the wrapped case only: a real executable (mmdc.exe) still
  // needs libuv's own quoting for its spaced arguments.
  const interpreter = process.env.ComSpec ?? "cmd.exe";
  const usesInterpreter = process.platform === "win32" && target.cmd === interpreter;
  return new Promise((resolve, reject) => {
    const child = spawn(target.cmd, target.args, {
      windowsHide: true,
      ...(usesInterpreter ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settleResolve = (value: { stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const stopChild = (): void => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
    };
    const stopForOverflow = (stream: "stdout" | "stderr"): void => {
      stopChild();
      settleReject(
        new RenderError(
          `Renderer output exceeded the ${MAX_RENDER_OUTPUT_CHARS}-character ` +
            `${stream} limit and the renderer was stopped. Check the diagram ` +
            `syntax or install a working local renderer CLI.`,
        ),
      );
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
      stopChild();
      settleReject(
        new RenderError(
          `Renderer timed out after ${timeoutMs}ms and was stopped. ` +
            `Check the diagram syntax or install a working local renderer CLI.`,
        ),
      );
    }, timeoutMs);
    const collect = (stream: "stdout" | "stderr", text: string): void => {
      if (settled) return;
      const kept = stream === "stdout" ? stdout : stderr;
      const room = MAX_RENDER_OUTPUT_CHARS - kept.length;
      if (text.length > room) {
        // Keep only what fits so returned content never exceeds the cap.
        if (room > 0) {
          if (stream === "stdout") stdout += text.slice(0, room);
          else stderr += text.slice(0, room);
        }
        stopForOverflow(stream);
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout.on("data", (d) => collect("stdout", d.toString()));
    child.stderr.on("data", (d) => collect("stderr", d.toString()));
    child.on("error", (err) => settleReject(err));
    child.on("close", (code) => {
      if (code === 0) {
        settleResolve({ stdout, stderr });
      } else {
        const detail =
          stderr.length > MAX_RENDER_ERROR_CHARS
            ? `${stderr.slice(0, MAX_RENDER_ERROR_CHARS)}…`
            : stderr;
        settleReject(new RenderError(detail || `Command exited with code ${code}`));
      }
    });
  });
}

/**
 * renderer: converts diagram source text into an image.
 *
 * - Mermaid: uses the local `mmdc` CLI (@mermaid-js/mermaid-cli) if
 *   installed; otherwise returns actionable guidance. Mermaid rendering is
 *   always local-only; there is no remote fallback.
 * - PlantUML: uses a local `plantuml` CLI/jar if available; otherwise
 *   falls back to the public PlantUML rendering server over HTTPS, but
 *   only when remote rendering is explicitly enabled.
 *
 * Privacy control: remote PlantUML rendering is opt-in and disabled by
 * default. Set ALLOW_REMOTE_PLANTUML=true to allow the remote fallback
 * (only the exact value "true" enables it; unset, "false", or any other
 * value keeps remote rendering disabled). DISABLE_REMOTE_PLANTUML=true
 * always disables remote rendering and takes precedence over the allow
 * flag. When remote rendering is disabled and no local `plantuml` CLI is
 * available, rendering fails with an actionable error instead of sending
 * diagram source to a remote server.
 *
 * Rendering is intentionally best-effort: if no renderer is available,
 * tools should surface a clear, actionable error rather than failing
 * silently.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { MAX_RENDER_OUTPUT_CHARS, PLANTUML_SERVER_URL } from "../constants.js";
import type { DiagramType } from "../types.js";

export type RenderFormat = "svg" | "png";

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** Minimal shape of a remote render response (kept narrow for testability). */
export interface RemoteRenderResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/**
 * Test seam for the renderer's process/network boundaries. Every field is
 * optional; omitted fields use the real implementation. Production callers
 * (including the MCP tool) pass nothing.
 */
export interface RendererDeps {
  commandExists?: (cmd: string) => Promise<boolean>;
  runCommand?: (
    cmd: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  fetchRemote?: (url: string) => Promise<RemoteRenderResponse>;
}

/**
 * Whether the remote PlantUML fallback is disabled. Remote rendering is
 * opt-in: it is enabled only when ALLOW_REMOTE_PLANTUML is exactly "true",
 * and DISABLE_REMOTE_PLANTUML=true always disables it (taking precedence
 * over the allow flag). Unset, "false", or any other value on either flag
 * leaves remote rendering disabled, so diagram source is never sent
 * remotely unless the operator explicitly opted in. Read per call so
 * concurrent renders each observe the current setting and no shared state
 * is involved.
 */
export function isRemotePlantUmlDisabled(): boolean {
  if (process.env.DISABLE_REMOTE_PLANTUML === "true") return true;
  return process.env.ALLOW_REMOTE_PLANTUML !== "true";
}

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const checker = spawn(process.platform === "win32" ? "where" : "which", [cmd]);
    checker.on("error", () => resolve(false));
    checker.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Ordered executable candidates for a CLI name. The bare name is probed
 * first; Windows-style executable extensions follow so npm command shims
 * (e.g. `mmdc.cmd`) resolve when the bare name cannot be spawned. (A
 * `.ps1` shim is deliberately excluded: it is not directly spawnable.)
 * On non-Windows the extra probes simply miss, leaving behavior there
 * unchanged.
 *
 * Detection and execution always use the same resolved candidate:
 * callers probe with `commandExists` in this order and spawn exactly
 * the candidate that was found. No `shell: true` is used anywhere, and
 * the command names passed here are hardcoded literals, never user
 * input.
 */
function resolveCandidates(cmd: string): string[] {
  return [cmd, `${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`];
}

/** Whether `err` is a launch failure (the executable could not be started). */
function isLaunchFailure(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EINVAL") return true;
    return err.message.includes("ENOENT") || err.message.includes("EINVAL");
  }
  return false;
}

type LocalCommandOutcome = "ok" | "missing" | "unlaunchable";

/**
 * Runs a local CLI with the first candidate that `commandExists`
 * resolves, spawning exactly that candidate. If a resolved candidate
 * cannot be spawned (ENOENT — e.g. an unlaunchable shim on Windows),
 * the next resolving candidate is tried. Returns "missing" when no
 * candidate resolves and "unlaunchable" when at least one resolved but
 * none could be spawned. Non-spawn failures propagate untouched.
 */
async function runLocalCommand(
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

/**
 * Quotes one argv element for the Windows command interpreter. Command
 * lines here are built only from hardcoded CLI names, fixed flags, and
 * server-generated temp paths — never from user input — so quoting only
 * needs to survive spaces in temp directory paths.
 */
function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface SpawnTarget {
  cmd: string;
  args: string[];
}

/**
 * Computes the actual spawn target for a resolved CLI candidate. Batch
 * shims (`.cmd`/`.bat`) cannot be spawned directly — Node/libuv rejects
 * them with EINVAL — so on Windows they run via the command interpreter
 * (`cmd.exe /d /s /c "<quoted line>"`). This is not `shell: true` with
 * untrusted input: the command name is a hardcoded literal resolved by
 * `runLocalCommand`, and argv elements are quoted, never parsed as
 * shell grammar. Non-Windows platforms and non-shim candidates return
 * the input unchanged.
 */
export function resolveSpawnTarget(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cmd)) {
    return { cmd, args };
  }
  const line = [cmd, ...args].map(quoteWindowsArg).join(" ");
  return {
    cmd: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", line],
  };
}

/**
 * Runs a local renderer CLI and collects its stdout/stderr, each capped at
 * MAX_RENDER_OUTPUT_CHARS characters. The bound is enforced while
 * collecting, not after: once either stream exceeds the cap, further bytes
 * are discarded, the stdio pipes are destroyed, and the child is killed,
 * so a runaway renderer cannot grow memory without bound. Overflow rejects
 * with an actionable RenderError whose message never includes captured
 * output (renderer output may echo diagram source, paths, or environment
 * values).
 *
 * Timeout is enforced by an explicit timer rather than the spawn `timeout`
 * option: the option kills the direct child but `close` still waits for
 * pipe EOF, so a descendant that inherited stdout/stderr could delay error
 * delivery indefinitely. The timer instead destroys our ends of the pipes
 * and kills the child, then rejects with an explicit timeout RenderError
 * whose message carries only the timeout budget (never captured output,
 * paths, source, or environment values). A killed renderer's orphaned
 * descendants may survive this; the MCP error no longer waits on them.
 *
 * Windows shim handling, temp-dir cleanup (by callers), and the non-zero
 * exit contract are unchanged: a non-zero exit rejects with a plain Error
 * carrying the bounded stderr text. No `shell: true` is used; see
 * resolveSpawnTarget. Exported so tests can exercise the real collector
 * hermetically (the RendererDeps seam keeps renderDiagram itself stubbed).
 */
export function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ stdout: string; stderr: string }> {
  const target = resolveSpawnTarget(cmd, args);
  return new Promise((resolve, reject) => {
    const child = spawn(target.cmd, target.args);
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
        settleReject(new Error(stderr || `Command exited with code ${code}`));
      }
    });
  });
}

async function renderMermaid(
  source: string,
  format: RenderFormat,
  deps: Required<RendererDeps>,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-mcp-"));
  const inputPath = path.join(tmpDir, "input.mmd");
  const outputPath = path.join(tmpDir, `output.${format}`);

  try {
    await fs.writeFile(inputPath, source, "utf-8");
    const outcome = await runLocalCommand(
      "mmdc",
      ["-i", inputPath, "-o", outputPath, "-b", "transparent"],
      deps,
    );
    if (outcome === "missing") {
      throw new RenderError(
        "Mermaid rendering requires the 'mmdc' CLI, which is not installed. " +
          "Install it with: npm install -g @mermaid-js/mermaid-cli",
      );
    }
    if (outcome === "unlaunchable") {
      throw new RenderError(
        "Mermaid rendering found an 'mmdc' command that could not be executed. " +
          "On Windows this usually means only an npm shim is on PATH; " +
          "reinstall with: npm install -g @mermaid-js/mermaid-cli " +
          "and ensure the npm global bin directory is on PATH.",
      );
    }
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** PlantUML's "deflate + custom base64" encoding for its HTTP rendering API. */
function encodePlantUmlForUrl(source: string): string {
  const deflated = zlib.deflateRawSync(Buffer.from(source, "utf-8"), {
    level: 9,
  });
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

  let result = "";
  for (let i = 0; i < deflated.length; i += 3) {
    const b1 = deflated[i];
    const b2 = i + 1 < deflated.length ? deflated[i + 1] : 0;
    const b3 = i + 2 < deflated.length ? deflated[i + 2] : 0;

    result += alphabet[b1 >> 2];
    result += alphabet[((b1 & 0x3) << 4) | (b2 >> 4)];
    if (i + 1 < deflated.length) {
      result += alphabet[((b2 & 0xf) << 2) | (b3 >> 6)];
    }
    if (i + 2 < deflated.length) {
      result += alphabet[b3 & 0x3f];
    }
  }
  return result;
}

async function renderPlantUmlLocal(
  source: string,
  format: RenderFormat,
  deps: Required<RendererDeps>,
): Promise<Buffer | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-mcp-"));
  const inputPath = path.join(tmpDir, "input.puml");

  try {
    await fs.writeFile(inputPath, source, "utf-8");
    const flag = format === "svg" ? "-tsvg" : "-tpng";
    const outcome = await runLocalCommand("plantuml", [flag, inputPath], deps);
    if (outcome === "missing") return null;
    if (outcome === "unlaunchable") {
      throw new RenderError(
        "PlantUML rendering found a 'plantuml' command that could not be executed. " +
          "Install a working local 'plantuml' CLI for offline rendering.",
      );
    }
    const outputPath = path.join(tmpDir, `input.${format}`);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function defaultFetchRemote(url: string): Promise<RemoteRenderResponse> {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    arrayBuffer: () => response.arrayBuffer(),
  };
}

async function renderPlantUmlRemote(
  source: string,
  format: RenderFormat,
  deps: Required<RendererDeps>,
): Promise<Buffer> {
  const encoded = encodePlantUmlForUrl(source);
  const url = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;

  const response = await deps.fetchRemote(url);
  if (!response.ok) {
    throw new RenderError(
      `PlantUML rendering server responded with ${response.status}. ` +
        `Install a local 'plantuml' CLI for offline rendering, or check the diagram syntax.`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function renderDiagram(
  source: string,
  type: DiagramType,
  format: RenderFormat = "svg",
  deps?: RendererDeps,
): Promise<Buffer> {
  const resolved: Required<RendererDeps> = {
    commandExists: deps?.commandExists ?? commandExists,
    runCommand: deps?.runCommand ?? runCommand,
    fetchRemote: deps?.fetchRemote ?? defaultFetchRemote,
  };

  if (type === "mermaid") {
    return renderMermaid(source, format, resolved);
  }

  const local = await renderPlantUmlLocal(source, format, resolved);
  if (local) return local;
  if (isRemotePlantUmlDisabled()) {
    throw new RenderError(
      "PlantUML rendering requires a local 'plantuml' CLI, which was not found, " +
        "and remote rendering is disabled by default. " +
        "Install a local 'plantuml' CLI for offline rendering, or set " +
        "ALLOW_REMOTE_PLANTUML=true to allow the configured remote fallback " +
        "(DISABLE_REMOTE_PLANTUML=true always disables it).",
    );
  }
  return renderPlantUmlRemote(source, format, resolved);
}

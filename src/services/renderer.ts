// Turns diagram source into images via local CLIs.
// Mermaid uses a local `mmdc` install. PlantUML prefers a local install
// and only falls back to the public render server when explicitly enabled
// with ALLOW_REMOTE_PLANTUML=true. DISABLE_REMOTE_PLANTUML=true always wins.

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

// Minimal remote-render response shape, kept narrow for tests.
export interface RemoteRenderResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

// Seams for the process/network edges. Omitted fields use the real
// implementation; callers in production pass nothing.
export interface RendererDeps {
  commandExists?: (cmd: string) => Promise<boolean>;
  runCommand?: (
    cmd: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  fetchRemote?: (url: string) => Promise<RemoteRenderResponse>;
}

// Remote rendering is opt-in: enabled only by ALLOW_REMOTE_PLANTUML=true,
// and always off when DISABLE_REMOTE_PLANTUML=true. Read per call so
// concurrent renders never share the setting.
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

// Quote one argv element for the Windows command interpreter.
function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
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
  return {
    cmd: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", line],
  };
}

// Run a renderer CLI and collect stdout/stderr, each capped at
// MAX_RENDER_OUTPUT_CHARS. Over-limit output stops the child and rejects
// with a RenderError that never includes captured output. Timeouts are
// enforced by a timer (not the spawn option) so a lingering descendant
// holding the pipes cannot delay the error. A non-zero exit rejects with
// the bounded stderr text.
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

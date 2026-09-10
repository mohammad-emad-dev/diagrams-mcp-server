// Guided installer: registers this server with an MCP client so users
// skip hand-editing JSON. Usage:
//   npx diagrams-mcp-server setup [--client <name>]
//     [--project-root <dir>] [--scope global|project] [--yes]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SETUP_VERSION = "0.5.2"; // Keep in sync with package.json (checked at release).

// Wrap text in an ANSI style in capable terminals only: piped output and
// NO_COLOR stay plain so logs and scripts never see escape codes.
export function paint(code: string, text: string): string {
  if (process.env.NO_COLOR !== undefined) return text;
  if (process.stdout.isTTY !== true) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

// Visible cell width: strip ANSI escapes, count pictographs as double.
export function visibleWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of plain) {
    width += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return width;
}

function padCenter(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  const left = Math.floor(pad / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
}

// Double-lined terminal card. Width fits the widest line plus padding.
export function box(lines: string[], title?: string): string {
  const inner = Math.max(
    0,
    ...lines.map(visibleWidth),
    title === undefined ? 0 : visibleWidth(title) + 4,
  );
  const width = inner + 4;
  const top =
    title === undefined
      ? `╔${"═".repeat(width)}╗`
      : `╔═ ${title} ${"═".repeat(Math.max(0, width - visibleWidth(title) - 3))}╗`;
  const body = lines.map(
    (line) => `║  ${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - 2))}║`,
  );
  return [top, ...body, `╚${"═".repeat(width)}╝`].join("\n");
}

export function renderBanner(title: string, version: string): string {
  return box([padCenter(`${title}  v${version}`, 40)]);
}

export interface SelectOption {
  label: string;
  hint?: string;
}

export function renderSelect(message: string, options: SelectOption[], active: number): string {
  const lines = [paint("36", `◇ ${message}`)];
  options.forEach((option, index) => {
    const hint = option.hint === undefined ? "" : paint("2", `  ${option.hint}`);
    if (index === active) {
      lines.push(`❯ ${paint("1;36", option.label)}${hint}`);
    } else {
      lines.push(`  ${paint("2", option.label)}${hint}`);
    }
  });
  lines.push(paint("2", "↑↓ to move · Enter to confirm · 1-9 jumps · Esc cancels"));
  return lines.join("\n");
}

export function renderConfirm(message: string, yesActive: boolean): string {
  const yes = yesActive ? `❯ ${paint("1;36", "[ Yes ]")}` : `  ${paint("2", "[ Yes ]")}`;
  const no = yesActive ? `  ${paint("2", "[ No ]")}` : `❯ ${paint("1;36", "[ No ]")}`;
  return [
    `${paint("36", "◇")} ${message}`,
    `${yes}   ${no}`,
    paint("2", "←/→ to toggle · y/n · Enter to confirm"),
  ].join("\n");
}

export type PromptKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "submit" }
  | { kind: "cancel" }
  | { kind: "digit"; value: number }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "other" };

export interface Keypress {
  name?: string;
  ctrl?: boolean;
}

export function normalizeKey(key: Keypress): PromptKey {
  if (key.ctrl === true && key.name === "c") return { kind: "cancel" };
  switch (key.name) {
    case "up":
      return { kind: "up" };
    case "down":
      return { kind: "down" };
    case "left":
      return { kind: "left" };
    case "right":
      return { kind: "right" };
    case "return":
    case "enter":
      return { kind: "submit" };
    case "escape":
      return { kind: "cancel" };
    case "y":
      return { kind: "yes" };
    case "n":
      return { kind: "no" };
    default:
      break;
  }
  if (key.name !== undefined && /^[1-9]$/.test(key.name)) {
    return { kind: "digit", value: Number(key.name) };
  }
  return { kind: "other" };
}

// Frozen confirmation line after a prompt resolves. Messages already
// ending in : or ? keep their punctuation instead of gaining another.
export function frozenLine(message: string, value: string): string {
  const head = paint("36", "◇");
  if (/[?:]$/.test(message)) return `${head} ${message} ${value}`;
  return `${head} ${message}: ${value}`;
}

export interface SelectResult {
  active: number;
  done: boolean;
  cancelled: boolean;
}

export function selectNext(count: number, active: number, key: PromptKey): SelectResult {
  switch (key.kind) {
    case "up":
      return { active: (active - 1 + count) % count, done: false, cancelled: false };
    case "down":
      return { active: (active + 1) % count, done: false, cancelled: false };
    case "submit":
      return { active, done: true, cancelled: false };
    case "cancel":
      return { active, done: false, cancelled: true };
    case "digit":
      if (key.value >= 1 && key.value <= count) {
        return { active: key.value - 1, done: true, cancelled: false };
      }
      return { active, done: false, cancelled: false };
    default:
      return { active, done: false, cancelled: false };
  }
}

export interface ConfirmResult {
  yes: boolean;
  done: boolean;
  cancelled: boolean;
}

export function confirmNext(yes: boolean, key: PromptKey): ConfirmResult {
  switch (key.kind) {
    case "left":
    case "right":
      return { yes: !yes, done: false, cancelled: false };
    case "yes":
      return { yes: true, done: true, cancelled: false };
    case "no":
      return { yes: false, done: true, cancelled: false };
    case "submit":
      return { yes, done: true, cancelled: false };
    case "cancel":
      return { yes, done: false, cancelled: true };
    default:
      return { yes, done: false, cancelled: false };
  }
}

function setRawModeSafe(mode: boolean): boolean {
  const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => void };
  if (typeof stdin.setRawMode !== "function") return false;
  try {
    stdin.setRawMode(mode);
    return true;
  } catch {
    return false;
  }
}

let keypressEventsEnabled = false;

// Byte stream for a frame transition: move up over every owned line and
// explicitly clear each one before writing. Padding short replacements
// with blank clears is what prevents ghost text: finalizing a selection
// redraws one frozen line over an N-line frame, and without the padding
// the other N-1 stale lines would survive underneath the next output.
export function frameTransition(lineCount: number, lines: string[]): string {
  let out = `\x1b[${lineCount}A`;
  for (let index = 0; index < lineCount; index += 1) {
    const line = index < lines.length ? lines[index] : "";
    out += `\r\x1b[2K${line}\n`;
  }
  return out;
}

function rewriteFrame(lineCount: number, lines: string[]): void {
  process.stdout.write(frameTransition(lineCount, lines));
}

async function selectPromptLegacy(
  message: string,
  options: SelectOption[],
  initial: number,
): Promise<number> {
  console.log(message);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}`);
  });
  for (;;) {
    const answer = await ask(`Choose 1-${options.length} [${initial + 1}]: `, String(initial + 1));
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
      return choice - 1;
    }
    console.log(`Enter a number between 1 and ${options.length}.`);
  }
}

async function selectPrompt(
  message: string,
  options: SelectOption[],
  initial = 0,
): Promise<number | undefined> {
  if (process.stdin.isTTY !== true || !setRawModeSafe(true)) {
    return selectPromptLegacy(message, options, initial);
  }
  if (!keypressEventsEnabled) {
    readline.emitKeypressEvents(process.stdin);
    keypressEventsEnabled = true;
  }
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");
  let active = initial;
  const lineCount = renderSelect(message, options, active).split("\n").length;
  process.stdout.write(`${renderSelect(message, options, active)}\n`);
  try {
    return await new Promise<number | undefined>((resolve) => {
      const onKey = (_chunk: unknown, key: Keypress): void => {
        const next = selectNext(options.length, active, normalizeKey(key));
        active = next.active;
        if (next.cancelled || next.done) {
          process.stdin.removeListener("keypress", onKey);
          if (next.done) {
            rewriteFrame(lineCount, [frozenLine(message, options[active].label)]);
          }
          resolve(next.done ? active : undefined);
          return;
        }
        rewriteFrame(lineCount, renderSelect(message, options, active).split("\n"));
      };
      process.stdin.on("keypress", onKey);
    });
  } finally {
    setRawModeSafe(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h");
  }
}

async function askConfirmLegacy(question: string, initialYes: boolean): Promise<boolean> {
  const fallback = initialYes ? "y" : "n";
  for (;;) {
    const answer = (await ask(`${question} [${initialYes ? "Y/n" : "y/N"}]: `, fallback))
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Enter y or n.");
  }
}

async function confirmPrompt(question: string, initialYes = true): Promise<boolean> {
  if (process.stdin.isTTY !== true || !setRawModeSafe(true)) {
    return askConfirmLegacy(question, initialYes);
  }
  if (!keypressEventsEnabled) {
    readline.emitKeypressEvents(process.stdin);
    keypressEventsEnabled = true;
  }
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");
  let yes = initialYes;
  const lineCount = renderConfirm(question, yes).split("\n").length;
  process.stdout.write(`${renderConfirm(question, yes)}\n`);
  try {
    return await new Promise<boolean>((resolve) => {
      const onKey = (_chunk: unknown, key: Keypress): void => {
        const next = confirmNext(yes, normalizeKey(key));
        yes = next.yes;
        if (next.cancelled) {
          process.stdin.removeListener("keypress", onKey);
          resolve(false);
          return;
        }
        if (next.done) {
          process.stdin.removeListener("keypress", onKey);
          rewriteFrame(lineCount, [frozenLine(question, yes ? "Yes" : "No")]);
          resolve(yes);
          return;
        }
        rewriteFrame(lineCount, renderConfirm(question, yes).split("\n"));
      };
      process.stdin.on("keypress", onKey);
    });
  } finally {
    setRawModeSafe(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h");
  }
}

function abortSetup(): never {
  console.log(paint("31", "✖ Setup cancelled."));
  process.exit(1);
}

export const SETUP_CLIENTS = [
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "opencode",
  "antigravity",
] as const;

export type SetupClient = (typeof SETUP_CLIENTS)[number];

type FileSetupClient = "cursor" | "vscode" | "antigravity";

const FILE_CLIENTS: ReadonlySet<string> = new Set(["cursor", "vscode", "antigravity"]);

const CLIENT_LABELS: Record<SetupClient, string> = {
  "claude-code": "Claude Code (runs claude mcp add)",
  codex: "Codex (runs codex mcp add)",
  cursor: "Cursor (writes mcp.json)",
  vscode: "VS Code (writes .vscode/mcp.json in this project)",
  opencode: "OpenCode (prints the command to run)",
  antigravity: "Antigravity (writes mcp_config.json)",
};

export interface PathLookupOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  windowsExtensions?: string[];
  exists?: (candidate: string) => boolean;
}

// Cross-platform PATH lookup without executing anything. Returns the
// first matching candidate or undefined. Filesystem access goes through
// the injectable exists check so tests can stub it.
export function findOnPath(command: string, opts: PathLookupOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const dirs = pathEnv.split(platform === "win32" ? ";" : ":").filter((d) => d.length > 0);
  const suffixes =
    platform === "win32"
      ? [
          "",
          ...(opts.windowsExtensions ?? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")),
        ]
      : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${command}${suffix}`);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

// Add-command for CLI-based clients. Project scope pins PROJECT_ROOT as
// an explicit --env flag (supported by both CLIs); global scope leaves
// it out so the server follows the client's working directory. Names are
// hardcoded literals, never user input, and spawn without a shell.
export function cliAddCommand(client: "claude-code" | "codex", projectRoot?: string): string[] {
  const bin = client === "codex" ? "codex" : "claude";
  const argv = [bin, "mcp", "add", "diagrams"];
  if (projectRoot !== undefined) {
    argv.push("--env", `PROJECT_ROOT=${projectRoot}`);
  }
  return [...argv, "--", "npx", "-y", "diagrams-mcp-server"];
}

export interface SetupOptions {
  client?: string;
  projectRoot: string;
  projectRootExplicit: boolean;
  scope: "global" | "project";
  scopeExplicit: boolean;
  yes: boolean;
  help: boolean;
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const opts: SetupOptions = {
    projectRoot: process.cwd(),
    projectRootExplicit: false,
    scope: "global",
    scopeExplicit: false,
    yes: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--yes" || arg === "-y") {
      opts.yes = true;
    } else if (arg === "--client" && i + 1 < args.length) {
      i += 1;
      opts.client = args[i];
    } else if (arg.startsWith("--client=")) {
      opts.client = arg.slice("--client=".length);
    } else if (arg === "--project-root" && i + 1 < args.length) {
      i += 1;
      opts.projectRoot = args[i];
      opts.projectRootExplicit = true;
    } else if (arg.startsWith("--project-root=")) {
      opts.projectRoot = arg.slice("--project-root=".length);
      opts.projectRootExplicit = true;
    } else if (arg === "--scope" && i + 1 < args.length) {
      i += 1;
      opts.scope = parseScope(args[i]);
      opts.scopeExplicit = true;
    } else if (arg.startsWith("--scope=")) {
      opts.scope = parseScope(arg.slice("--scope=".length));
      opts.scopeExplicit = true;
    } else {
      throw new Error(`Unknown setup flag '${arg}'. Run with --help.`);
    }
  }
  return opts;
}

function parseScope(value: string): "global" | "project" {
  if (value === "global" || value === "project") return value;
  throw new Error(`Invalid --scope '${value}': expected global or project.`);
}

export function isSetupClient(value: string): value is SetupClient {
  return (SETUP_CLIENTS as ReadonlyArray<string>).includes(value);
}

// Config file and root key per file-based client. Home and cwd are
// parameters so tests can cover every OS.
export function resolveConfigFile(
  client: FileSetupClient,
  scope: "global" | "project",
  home: string = os.homedir(),
  cwd: string = process.cwd(),
): { file: string; rootKey: "mcpServers" | "servers" } {
  if (client === "cursor") {
    if (scope === "project") {
      return { file: path.join(cwd, ".cursor", "mcp.json"), rootKey: "mcpServers" };
    }
    return { file: path.join(home, ".cursor", "mcp.json"), rootKey: "mcpServers" };
  }
  if (client === "vscode") {
    return { file: path.join(cwd, ".vscode", "mcp.json"), rootKey: "servers" };
  }
  if (scope === "project") {
    return { file: path.join(cwd, ".agents", "mcp_config.json"), rootKey: "mcpServers" };
  }
  return { file: path.join(home, ".gemini", "config", "mcp_config.json"), rootKey: "mcpServers" };
}

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// The config entry written for file-based clients: run via npx so no
// local checkout is needed. Global scope writes a clean entry without
// env (the server then uses the client's working directory); project
// scope pins one PROJECT_ROOT.
export function diagramsServerEntry(projectRoot?: string): ServerEntry {
  const entry: ServerEntry = {
    command: "npx",
    args: ["-y", "diagrams-mcp-server"],
  };
  if (projectRoot !== undefined) {
    entry.env = { PROJECT_ROOT: projectRoot };
  }
  return entry;
}

// Merge one server entry into existing config JSON. Refuses non-object
// configs instead of overwriting them.
export function mergeServerConfig(
  existing: unknown,
  rootKey: string,
  name: string,
  entry: ServerEntry,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing === undefined ? {} : (existing as Record<string, unknown>);
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw new Error("Existing config is not a JSON object; refusing to overwrite it.");
  }
  const table: Record<string, unknown> =
    base[rootKey] === undefined ? {} : (base[rootKey] as Record<string, unknown>);
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error(`Existing config key '${rootKey}' is not an object; refusing to overwrite it.`);
  }
  return { ...base, [rootKey]: { ...table, [name]: entry } };
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// Write the diagrams entry to a file-based client's config, creating
// parent directories. Returns the file written.
export async function writeFileClientConfig(
  client: FileSetupClient,
  opts: SetupOptions,
  projectRoot: string | undefined,
): Promise<string> {
  const target = resolveConfigFile(client, opts.scope);
  let existing: unknown;
  try {
    existing = JSON.parse(await fs.readFile(target.file, "utf-8"));
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") {
      existing = undefined;
    } else {
      throw new Error(`Cannot parse ${target.file}; fix or delete it, then retry.`);
    }
  }
  const merged = mergeServerConfig(
    existing,
    target.rootKey,
    "diagrams",
    diagramsServerEntry(projectRoot),
  );
  await fs.mkdir(path.dirname(target.file), { recursive: true });
  await fs.writeFile(target.file, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  return target.file;
}

async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  } finally {
    rl.close();
  }
}

export interface PathPromptDeps {
  exists: (path: string) => boolean;
  mkdir: (path: string) => Promise<void>;
  confirm: (question: string) => Promise<boolean>;
  reprompt: (question: string, fallback: string) => Promise<string>;
}

// Loop until root names an existing directory: offer to create a
// missing one, otherwise re-ask. A failed mkdir falls back to
// re-prompting so a permission error never strands the user.
export async function ensureProjectRoot(root: string, deps: PathPromptDeps): Promise<string> {
  let current = root;
  for (;;) {
    if (deps.exists(current)) return current;
    console.log(paint("33", `⚠ Directory does not exist: ${current}`));
    if (await deps.confirm("Create this directory?")) {
      try {
        await deps.mkdir(current);
        console.log(paint("32", `✔ Created ${current}`));
        return current;
      } catch (err: unknown) {
        console.log(
          paint("31", `✖ Could not create directory: ${err instanceof Error ? err.message : err}`),
        );
      }
    }
    const next = (await deps.reprompt(`Project root [${current}]: `, current)).trim();
    current = next.length > 0 ? next : current;
  }
}

async function pickClient(): Promise<SetupClient> {
  const index =
    (await selectPrompt(
      "Which client should use diagrams-mcp-server?",
      SETUP_CLIENTS.map((client) => ({ label: CLIENT_LABELS[client] })),
    )) ?? abortSetup();
  return SETUP_CLIENTS[index];
}

function runAddCommand(
  client: "claude-code" | "codex",
  projectRoot: string | undefined,
): Promise<void> {
  const argv = cliAddCommand(client, projectRoot);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${argv[0]} exited with code ${code}`));
    });
  });
}

// Quote one argv element for copy-paste display only; spawn itself
// never uses a shell.
function shellQuote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function printSetupHelp(): void {
  console.log(`diagrams-mcp-server setup

Register this server with an MCP client without hand-editing JSON.

Usage:
  diagrams-mcp-server setup [--client <name>] [--project-root <dir>]
                            [--scope global|project] [--yes]

  --scope global (default): clean config without PROJECT_ROOT; the
    server attaches to the client's working directory.
  --scope project: bake PROJECT_ROOT into the config for one project.

  Pre-flight checks verify the client CLI and project path automatically.

Clients: ${SETUP_CLIENTS.join(", ")}

Examples:
  diagrams-mcp-server setup
  diagrams-mcp-server setup --client codex --yes
  diagrams-mcp-server setup --client cursor --scope project
`);
}

// Global scope writes a clean config and follows the working directory;
// project scope pins one PROJECT_ROOT. An explicit --project-root always
// wins over the global default.
export function shouldBakeProjectRoot(opts: SetupOptions): boolean {
  return opts.scope === "project" || opts.projectRootExplicit;
}

async function pickScope(): Promise<"global" | "project"> {
  const index =
    (await selectPrompt("Setup scope:", [
      { label: "Global (Recommended)", hint: "clean config, follows the working directory" },
      { label: "Project-specific", hint: "pins PROJECT_ROOT for this project" },
    ])) ?? abortSetup();
  return index === 0 ? "global" : "project";
}

function printSummary(client: string, scope: string, target: string, status: string): void {
  console.log("");
  console.log(paint("36", "◇ Summary"));
  console.log(`  Target client:       ${client}`);
  console.log(`  Configuration scope: ${scope}`);
  console.log(`  Touched:             ${target}`);
  console.log(`  Status:              ${status}`);
}

export async function runSetup(args: string[]): Promise<void> {
  const opts = parseSetupArgs(args);
  if (opts.help) {
    printSetupHelp();
    return;
  }
  console.log(renderBanner("📐 DIAGRAMS MCP SERVER", SETUP_VERSION));
  console.log("");
  let client = opts.client;
  if (client === undefined) {
    if (!process.stdin.isTTY || opts.yes) {
      throw new Error("Pass --client <name> outside interactive use.");
    }
    client = await pickClient();
  }
  if (!isSetupClient(client)) {
    throw new Error(`Unknown client '${client}'. Expected one of: ${SETUP_CLIENTS.join(", ")}.`);
  }
  const interactive = process.stdin.isTTY && !opts.yes;
  if (interactive && !opts.scopeExplicit) {
    opts.scope = await pickScope();
  }
  if (interactive && opts.scope === "project") {
    console.log("Project root is the target project/repo: diagrams are stored and scanned there.");
    const initial = await ask(`Project root [${opts.projectRoot}]: `, opts.projectRoot);
    opts.projectRoot = await ensureProjectRoot(initial, {
      exists: existsSync,
      mkdir: async (p) => {
        await fs.mkdir(p, { recursive: true });
      },
      confirm: (question) => confirmPrompt(question, true),
      reprompt: (question, fallback) => ask(question, fallback),
    });
  }
  const projectRoot = shouldBakeProjectRoot(opts) ? opts.projectRoot : undefined;
  if (!interactive && projectRoot !== undefined && !existsSync(projectRoot)) {
    console.log(
      paint("33", `⚠ Warning: ${projectRoot} does not exist; continuing with it anyway.`),
    );
  }
  if (FILE_CLIENTS.has(client)) {
    const file = await writeFileClientConfig(client as FileSetupClient, opts, projectRoot);
    console.log(paint("32", `✔ Wrote the diagrams entry to ${file}.`));
    printSummary(client, opts.scope, file, paint("32", `✔ Restart ${client} to load it.`));
    return;
  }
  if (client === "claude-code" || client === "codex") {
    const bin = client === "codex" ? "codex" : "claude";
    const display = cliAddCommand(client, projectRoot).map(shellQuote).join(" ");
    if (findOnPath(bin) === undefined) {
      console.log(paint("33", `⚠ ${bin} CLI not detected in PATH.`));
      console.log(box([display], "Manual setup"));
      printSummary(
        client,
        opts.scope,
        "manual command (see above)",
        paint("33", "⚠ Manual step required."),
      );
      return;
    }
    try {
      await runAddCommand(client, projectRoot);
    } catch (err: unknown) {
      console.log(
        paint("31", `✖ Could not run the ${bin} CLI: ${err instanceof Error ? err.message : err}`),
      );
      console.log(box([display], "Manual setup"));
      printSummary(
        client,
        opts.scope,
        "manual command (see above)",
        paint("33", "⚠ Manual step required."),
      );
      return;
    }
    console.log(paint("32", `✔ Registered diagrams with ${client}.`));
    printSummary(client, opts.scope, `${bin} CLI configuration`, paint("32", "✔ Ready to use."));
    return;
  }
  console.log(
    box(
      ["opencode mcp add", "Choose Local, then enter:", "  npx -y diagrams-mcp-server"],
      "Manual setup",
    ),
  );
  printSummary(
    client,
    opts.scope,
    "manual command (see above)",
    paint("33", "⚠ Manual step required."),
  );
}

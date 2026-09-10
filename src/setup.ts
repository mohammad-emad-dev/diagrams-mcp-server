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
    console.log(`⚠ Directory does not exist: ${current}`);
    if (await deps.confirm("Create this directory? [Y/n]: ")) {
      try {
        await deps.mkdir(current);
        console.log(`✔ Created ${current}`);
        return current;
      } catch (err: unknown) {
        console.log(`✖ Could not create directory: ${err instanceof Error ? err.message : err}`);
      }
    }
    const next = (await deps.reprompt(`Project root [${current}]: `, current)).trim();
    current = next.length > 0 ? next : current;
  }
}

async function askConfirm(question: string): Promise<boolean> {
  for (;;) {
    const answer = (await ask(question, "y")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Enter y or n.");
  }
}

async function pickClient(): Promise<SetupClient> {
  console.log("Which client should use diagrams-mcp-server?");
  SETUP_CLIENTS.forEach((client, index) => {
    console.log(`  ${index + 1}. ${CLIENT_LABELS[client]}`);
  });
  for (;;) {
    const answer = await ask(`Choose 1-${SETUP_CLIENTS.length}: `, "");
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= SETUP_CLIENTS.length) {
      return SETUP_CLIENTS[choice - 1];
    }
    console.log(`Enter a number between 1 and ${SETUP_CLIENTS.length}.`);
  }
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
  console.log("Setup scope:");
  console.log("  1. Global (Recommended) — clean config, follows the working directory");
  console.log("  2. Project-specific — pins PROJECT_ROOT for this project");
  for (;;) {
    const answer = await ask("Choose 1-2 [1]: ", "1");
    if (answer === "1") return "global";
    if (answer === "2") return "project";
    console.log("Enter 1 or 2.");
  }
}

function printSummary(client: string, scope: string, target: string, status: string): void {
  console.log("");
  console.log("◇ Summary");
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
  console.log("◇ diagrams-mcp-server setup");
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
      confirm: askConfirm,
      reprompt: (question, fallback) => ask(question, fallback),
    });
  }
  const projectRoot = shouldBakeProjectRoot(opts) ? opts.projectRoot : undefined;
  if (!interactive && projectRoot !== undefined && !existsSync(projectRoot)) {
    console.log(`⚠ Warning: ${projectRoot} does not exist; continuing with it anyway.`);
  }
  if (FILE_CLIENTS.has(client)) {
    const file = await writeFileClientConfig(client as FileSetupClient, opts, projectRoot);
    console.log(`✔ Wrote the diagrams entry to ${file}.`);
    printSummary(client, opts.scope, file, `✔ Restart ${client} to load it.`);
    return;
  }
  if (client === "claude-code" || client === "codex") {
    const bin = client === "codex" ? "codex" : "claude";
    const display = cliAddCommand(client, projectRoot).map(shellQuote).join(" ");
    if (findOnPath(bin) === undefined) {
      console.log(`⚠ ${bin} CLI not detected in PATH.`);
      console.log("Run this instead:");
      console.log(`  ${display}`);
      printSummary(client, opts.scope, "manual command (see above)", "⚠ Manual step required.");
      return;
    }
    try {
      await runAddCommand(client, projectRoot);
    } catch (err: unknown) {
      console.log(`✖ Could not run the ${bin} CLI: ${err instanceof Error ? err.message : err}`);
      console.log("Run this instead:");
      console.log(`  ${display}`);
      printSummary(client, opts.scope, "manual command (see above)", "⚠ Manual step required.");
      return;
    }
    console.log(`✔ Registered diagrams with ${client}.`);
    printSummary(client, opts.scope, `${bin} CLI configuration`, "✔ Ready to use.");
    return;
  }
  console.log("Run this in your terminal:");
  console.log("  opencode mcp add");
  console.log("Choose Local, then enter: npx -y diagrams-mcp-server");
  printSummary(client, opts.scope, "manual command (see above)", "⚠ Manual step required.");
}

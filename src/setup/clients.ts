// Keep the setup entry point compatible while parsing and persistence
// live in dedicated modules.
import { existsSync } from "node:fs";
import path from "node:path";

export { parseSetupArgs } from "./arguments.js";
export type { SetupOptions } from "./arguments.js";
export {
  diagramsServerEntry,
  mergeServerConfig,
  resolveConfigFile,
  writeFileClientConfig,
} from "./configuration.js";
export type { ServerEntry } from "./configuration.js";
export { ensureProjectRoot, shouldBakeProjectRoot } from "./projectRoot.js";
export type { PathPromptDeps } from "./projectRoot.js";

export const SETUP_CLIENTS = [
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "opencode",
  "antigravity",
] as const;

export type SetupClient = (typeof SETUP_CLIENTS)[number];

export type FileSetupClient = "cursor" | "vscode" | "antigravity";

export const FILE_CLIENTS: ReadonlySet<string> = new Set(["cursor", "vscode", "antigravity"]);

export const CLIENT_LABELS: Record<SetupClient, string> = {
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

export function isSetupClient(value: string): value is SetupClient {
  return (SETUP_CLIENTS as ReadonlyArray<string>).includes(value);
}

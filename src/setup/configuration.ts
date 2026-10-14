import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SetupOptions } from "./arguments.js";
import type { FileSetupClient } from "./clients.js";

// Config file and root key per file-based client. Home and cwd ride in an
// options bag (lazily defaulted per call) so tests can cover every OS.
export function resolveConfigFile(
  client: FileSetupClient,
  scope: "global" | "project",
  env: { home?: string; cwd?: string } = {},
): { file: string; rootKey: "mcpServers" | "servers" } {
  const { home = os.homedir(), cwd = process.cwd() } = env;
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
  target: { rootKey: string; name: string; entry: ServerEntry },
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing === undefined ? {} : (existing as Record<string, unknown>);
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw new Error("Existing config is not a JSON object; refusing to overwrite it.");
  }
  const table: Record<string, unknown> =
    base[target.rootKey] === undefined ? {} : (base[target.rootKey] as Record<string, unknown>);
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error(
      `Existing config key '${target.rootKey}' is not an object; refusing to overwrite it.`,
    );
  }
  return { ...base, [target.rootKey]: { ...table, [target.name]: target.entry } };
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
  const merged = mergeServerConfig(existing, {
    rootKey: target.rootKey,
    name: "diagrams",
    entry: diagramsServerEntry(projectRoot),
  });
  await fs.mkdir(path.dirname(target.file), { recursive: true });
  await fs.writeFile(target.file, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  return target.file;
}

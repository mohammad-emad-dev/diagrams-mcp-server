// Guided installer: registers this server with an MCP client so users
// skip hand-editing JSON. Orchestrator only: terminal rendering, prompt
// drivers, and client-config logic live in ./terminal.js, ./prompts.js,
// and ./clients.js. Usage:
//   npx diagrams-mcp-server setup [--client <name>]
//     [--project-root <dir>] [--scope global|project] [--yes]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import {
  FILE_CLIENTS,
  SETUP_CLIENTS,
  cliAddCommand,
  ensureProjectRoot,
  findOnPath,
  isSetupClient,
  parseSetupArgs,
  shouldBakeProjectRoot,
  writeFileClientConfig,
} from "./clients.js";
import type { FileSetupClient } from "./clients.js";
import { ask, confirmPrompt, pickClient, pickScope } from "./prompts.js";
import { box, paint, renderBanner } from "./terminal.js";

const SETUP_VERSION = "0.5.2"; // Keep in sync with package.json (checked at release).

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

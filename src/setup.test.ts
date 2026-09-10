import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  cliAddCommand,
  diagramsServerEntry,
  isSetupClient,
  mergeServerConfig,
  parseSetupArgs,
  resolveConfigFile,
  shouldBakeProjectRoot,
} from "./setup.js";

describe("parseSetupArgs", () => {
  it("defaults to cwd, global scope, and interactive mode", () => {
    const opts = parseSetupArgs([]);
    assert.equal(opts.projectRoot, process.cwd());
    assert.equal(opts.scope, "global");
    assert.equal(opts.yes, false);
    assert.equal(opts.help, false);
    assert.equal(opts.client, undefined);
  });

  it("reads --client, --project-root, --scope, and --yes in both forms", () => {
    const spaced = parseSetupArgs([
      "--client",
      "cursor",
      "--project-root",
      "/proj",
      "--scope",
      "project",
      "--yes",
    ]);
    assert.equal(spaced.client, "cursor");
    assert.equal(spaced.projectRoot, "/proj");
    assert.equal(spaced.scope, "project");
    assert.equal(spaced.yes, true);

    const equals = parseSetupArgs(["--client=vscode", "--project-root=/p", "--scope=global", "-y"]);
    assert.equal(equals.client, "vscode");
    assert.equal(equals.projectRoot, "/p");
    assert.equal(equals.scope, "global");
    assert.equal(equals.yes, true);
  });

  it("rejects unknown flags and bad scopes", () => {
    assert.throws(() => parseSetupArgs(["--bogus"]), /Unknown setup flag/);
    assert.throws(() => parseSetupArgs(["--scope", "wide"]), /Invalid --scope/);
  });

  it("records whether scope and project root were explicit", () => {
    const fresh = parseSetupArgs([]);
    assert.equal(fresh.scopeExplicit, false);
    assert.equal(fresh.projectRootExplicit, false);

    const scoped = parseSetupArgs(["--scope", "project"]);
    assert.equal(scoped.scope, "project");
    assert.equal(scoped.scopeExplicit, true);
    assert.equal(scoped.projectRootExplicit, false);

    const rooted = parseSetupArgs(["--project-root=/p"]);
    assert.equal(rooted.projectRoot, "/p");
    assert.equal(rooted.projectRootExplicit, true);
    assert.equal(rooted.scopeExplicit, false);
  });
});

describe("isSetupClient", () => {
  it("accepts known clients and rejects the rest", () => {
    assert.equal(isSetupClient("claude-code"), true);
    assert.equal(isSetupClient("opencode"), true);
    assert.equal(isSetupClient("claude-desktop"), false);
    assert.equal(isSetupClient("not-a-client"), false);
    assert.equal(isSetupClient(""), false);
  });
});

describe("cliAddCommand", () => {
  it("carries PROJECT_ROOT as an explicit --env flag for claude-code", () => {
    assert.deepEqual(cliAddCommand("claude-code", "C:\\proj"), [
      "claude",
      "mcp",
      "add",
      "diagrams",
      "--env",
      "PROJECT_ROOT=C:\\proj",
      "--",
      "npx",
      "-y",
      "diagrams-mcp-server",
    ]);
  });

  it("carries PROJECT_ROOT as an explicit --env flag for codex", () => {
    assert.deepEqual(cliAddCommand("codex", "/home/u/proj"), [
      "codex",
      "mcp",
      "add",
      "diagrams",
      "--env",
      "PROJECT_ROOT=/home/u/proj",
      "--",
      "npx",
      "-y",
      "diagrams-mcp-server",
    ]);
  });

  it("omits --env entirely for a clean global entry", () => {
    for (const client of ["claude-code", "codex"] as const) {
      const bin = client === "codex" ? "codex" : "claude";
      assert.deepEqual(cliAddCommand(client), [
        bin,
        "mcp",
        "add",
        "diagrams",
        "--",
        "npx",
        "-y",
        "diagrams-mcp-server",
      ]);
    }
  });
});

describe("shouldBakeProjectRoot", () => {
  it("stays clean for the global default", () => {
    assert.equal(shouldBakeProjectRoot(parseSetupArgs([])), false);
  });

  it("bakes PROJECT_ROOT for project scope", () => {
    assert.equal(shouldBakeProjectRoot(parseSetupArgs(["--scope", "project"])), true);
  });

  it("honors an explicit --project-root even under global scope", () => {
    assert.equal(shouldBakeProjectRoot(parseSetupArgs(["--project-root", "/p"])), true);
  });
});

describe("resolveConfigFile", () => {
  it("separates global and project scopes for cursor and antigravity", () => {
    const cursorGlobal = resolveConfigFile("cursor", "global", "/home/u", "/proj");
    assert.equal(cursorGlobal.file, path.join("/home/u", ".cursor", "mcp.json"));

    const cursorProject = resolveConfigFile("cursor", "project", "/home/u", "/proj");
    assert.equal(cursorProject.file, path.join("/proj", ".cursor", "mcp.json"));

    const gravityProject = resolveConfigFile("antigravity", "project", "/home/u", "/proj");
    assert.equal(gravityProject.file, path.join("/proj", ".agents", "mcp_config.json"));

    const gravityGlobal = resolveConfigFile("antigravity", "global", "/home/u", "/proj");
    assert.equal(gravityGlobal.file, path.join("/home/u", ".gemini", "config", "mcp_config.json"));
  });

  it("always uses the project .vscode file with the servers key", () => {
    const target = resolveConfigFile("vscode", "global", "/home/u", "/proj");
    assert.equal(target.file, path.join("/proj", ".vscode", "mcp.json"));
    assert.equal(target.rootKey, "servers");
  });
});

describe("diagramsServerEntry", () => {
  it("runs the published package via npx with the project root", () => {
    assert.deepEqual(diagramsServerEntry("/proj"), {
      command: "npx",
      args: ["-y", "diagrams-mcp-server"],
      env: { PROJECT_ROOT: "/proj" },
    });
  });

  it("omits env entirely for a clean global entry", () => {
    assert.deepEqual(diagramsServerEntry(), {
      command: "npx",
      args: ["-y", "diagrams-mcp-server"],
    });
  });
});

describe("mergeServerConfig", () => {
  it("creates the root key from scratch", () => {
    assert.deepEqual(
      mergeServerConfig(undefined, "mcpServers", "diagrams", diagramsServerEntry("/p")),
      {
        mcpServers: { diagrams: diagramsServerEntry("/p") },
      },
    );
  });

  it("keeps existing servers and replaces the same name", () => {
    const existing = { mcpServers: { other: { command: "x" }, diagrams: { command: "old" } } };
    const merged = mergeServerConfig(existing, "mcpServers", "diagrams", diagramsServerEntry("/p"));
    assert.deepEqual(merged, {
      mcpServers: { other: { command: "x" }, diagrams: diagramsServerEntry("/p") },
    });
  });

  it("refuses non-object configs instead of overwriting them", () => {
    assert.throws(
      () => mergeServerConfig([], "mcpServers", "diagrams", diagramsServerEntry("/p")),
      /not a JSON object/,
    );
    assert.throws(
      () => mergeServerConfig("text", "mcpServers", "diagrams", diagramsServerEntry("/p")),
      /not a JSON object/,
    );
    assert.throws(
      () =>
        mergeServerConfig(
          { mcpServers: ["x"] },
          "mcpServers",
          "diagrams",
          diagramsServerEntry("/p"),
        ),
      /not an object/,
    );
  });
});

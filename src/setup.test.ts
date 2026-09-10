import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  box,
  cliAddCommand,
  confirmNext,
  diagramsServerEntry,
  ensureProjectRoot,
  findOnPath,
  frameTransition,
  frozenLine,
  isSetupClient,
  mergeServerConfig,
  normalizeKey,
  paint,
  parseSetupArgs,
  renderBanner,
  renderConfirm,
  renderSelect,
  resolveConfigFile,
  selectNext,
  shouldBakeProjectRoot,
  visibleWidth,
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

describe("paint", () => {
  it("stays plain when NO_COLOR is set", () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      assert.equal(paint("32", "✔ done"), "✔ done");
    } finally {
      if (previous === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previous;
      }
    }
  });

  it("stays plain on piped output", () => {
    if (process.stdout.isTTY === true) return;
    assert.equal(paint("32", "✔ done"), "✔ done");
  });
});

describe("visibleWidth", () => {
  it("counts plain text by characters", () => {
    assert.equal(visibleWidth("hello"), 5);
  });

  it("ignores ANSI escapes and counts pictographs double", () => {
    assert.equal(visibleWidth("a\x1b[36mb\x1b[0m"), 2);
    assert.equal(visibleWidth("📐ab"), 4);
  });
});

describe("box", () => {
  it("frames content in double lines with a title", () => {
    const out = box(["opencode mcp add", "second line"], "Manual setup");
    const lines = out.split("\n");
    assert.ok(lines[0].startsWith("╔═ Manual setup "));
    assert.ok(lines[0].endsWith("╗"));
    assert.ok(lines[lines.length - 1].startsWith("╚"));
    assert.ok(lines[lines.length - 1].endsWith("╝"));
    assert.ok(lines.some((line) => line.includes("opencode mcp add")));
    const widths = new Set(lines.map(visibleWidth));
    assert.equal(widths.size, 1);
  });

  it("works without a title", () => {
    const out = box(["only"]);
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("╔"));
    const widths = new Set(lines.map(visibleWidth));
    assert.equal(widths.size, 1);
  });
});

describe("renderBanner", () => {
  it("centers the title and version in a uniform box", () => {
    const out = renderBanner("📐 DIAGRAMS MCP SERVER", "0.5.0");
    assert.ok(out.includes("📐 DIAGRAMS MCP SERVER"));
    assert.ok(out.includes("v0.5.0"));
    const lines = out.split("\n");
    const widths = new Set(lines.map(visibleWidth));
    assert.equal(widths.size, 1);
  });
});

describe("renderSelect", () => {
  const options = [
    { label: "Global (Recommended)", hint: "clean config" },
    { label: "Project-specific", hint: "pins root" },
  ];

  it("marks the active option and shows hints", () => {
    const lines = renderSelect("Setup scope:", options, 1).split("\n");
    assert.ok(lines[0].includes("Setup scope:"));
    assert.ok(lines[1].startsWith("  "));
    assert.ok(lines[1].includes("Global (Recommended)"));
    assert.ok(lines[2].startsWith("❯"));
    assert.ok(lines[2].includes("Project-specific"));
    assert.ok(lines[2].includes("pins root"));
  });
});

describe("renderConfirm", () => {
  it("toggles the focus marker between Yes and No", () => {
    const yes = renderConfirm("Create this directory?", true).split("\n");
    assert.ok(yes[1].includes("❯") && yes[1].indexOf("❯") < yes[1].indexOf("[ No ]"));
    const no = renderConfirm("Create this directory?", false).split("\n");
    assert.ok(no[1].includes("❯") && no[1].indexOf("❯") > no[1].indexOf("[ Yes ]"));
  });
});

describe("normalizeKey", () => {
  it("maps navigation, submit, cancel, digits, and shortcuts", () => {
    assert.deepEqual(normalizeKey({ name: "up" }), { kind: "up" });
    assert.deepEqual(normalizeKey({ name: "down" }), { kind: "down" });
    assert.deepEqual(normalizeKey({ name: "left" }), { kind: "left" });
    assert.deepEqual(normalizeKey({ name: "right" }), { kind: "right" });
    assert.deepEqual(normalizeKey({ name: "return" }), { kind: "submit" });
    assert.deepEqual(normalizeKey({ name: "escape" }), { kind: "cancel" });
    assert.deepEqual(normalizeKey({ name: "c", ctrl: true }), { kind: "cancel" });
    assert.deepEqual(normalizeKey({ name: "3" }), { kind: "digit", value: 3 });
    assert.deepEqual(normalizeKey({ name: "y" }), { kind: "yes" });
    assert.deepEqual(normalizeKey({ name: "n" }), { kind: "no" });
    assert.deepEqual(normalizeKey({ name: "q" }), { kind: "other" });
    assert.deepEqual(normalizeKey({}), { kind: "other" });
  });
});

describe("selectNext", () => {
  it("moves with wraparound and submits", () => {
    assert.deepEqual(selectNext(3, 0, { kind: "up" }), {
      active: 2,
      done: false,
      cancelled: false,
    });
    assert.deepEqual(selectNext(3, 2, { kind: "down" }), {
      active: 0,
      done: false,
      cancelled: false,
    });
    assert.deepEqual(selectNext(3, 1, { kind: "submit" }), {
      active: 1,
      done: true,
      cancelled: false,
    });
    assert.deepEqual(selectNext(3, 1, { kind: "cancel" }), {
      active: 1,
      done: false,
      cancelled: true,
    });
  });

  it("jumps on in-range digits and ignores the rest", () => {
    assert.deepEqual(selectNext(3, 0, { kind: "digit", value: 2 }), {
      active: 1,
      done: true,
      cancelled: false,
    });
    assert.deepEqual(selectNext(3, 0, { kind: "digit", value: 9 }), {
      active: 0,
      done: false,
      cancelled: false,
    });
    assert.deepEqual(selectNext(3, 0, { kind: "other" }), {
      active: 0,
      done: false,
      cancelled: false,
    });
  });
});

describe("frozenLine", () => {
  it("never doubles trailing punctuation", () => {
    assert.equal(frozenLine("Setup scope:", "Project-specific"), "◇ Setup scope: Project-specific");
    assert.equal(
      frozenLine("Which client should use diagrams-mcp-server?", "Cursor"),
      "◇ Which client should use diagrams-mcp-server? Cursor",
    );
    assert.equal(frozenLine("Create this directory?", "Yes"), "◇ Create this directory? Yes");
    assert.equal(frozenLine("Pick one", "A"), "◇ Pick one: A");
  });
});

describe("frameTransition", () => {
  const clears = (out: string): number => out.match(/\x1b\[2K/g)?.length ?? 0;

  it("clears every owned line on full rewrites", () => {
    const out = frameTransition(4, ["a", "b", "c", "d"]);
    assert.ok(out.startsWith("\x1b[4A"));
    assert.equal(clears(out), 4);
    assert.ok(out.includes("a") && out.includes("d"));
    assert.ok(out.endsWith("\n"));
  });

  it("clears stale lines when a short frame replaces a tall one", () => {
    const frame = renderSelect(
      "Setup scope:",
      [{ label: "Global (Recommended)" }, { label: "Project-specific" }],
      0,
    ).split("\n");
    assert.ok(frame.length > 2);
    const out = frameTransition(frame.length, ["◇ Setup scope: Global (Recommended)"]);
    assert.equal(clears(out), frame.length);
  });

  it("leaves the cursor below the cleared block", () => {
    const out = frameTransition(3, ["only"]);
    assert.equal(clears(out), 3);
    assert.equal(out.split("\n").length, 4);
  });
});

describe("confirmNext", () => {
  it("toggles, shortcuts, submits, and cancels", () => {
    assert.deepEqual(confirmNext(true, { kind: "right" }), {
      yes: false,
      done: false,
      cancelled: false,
    });
    assert.deepEqual(confirmNext(false, { kind: "left" }), {
      yes: true,
      done: false,
      cancelled: false,
    });
    assert.deepEqual(confirmNext(false, { kind: "yes" }), {
      yes: true,
      done: true,
      cancelled: false,
    });
    assert.deepEqual(confirmNext(true, { kind: "no" }), {
      yes: false,
      done: true,
      cancelled: false,
    });
    assert.deepEqual(confirmNext(true, { kind: "submit" }), {
      yes: true,
      done: true,
      cancelled: false,
    });
    assert.deepEqual(confirmNext(true, { kind: "cancel" }), {
      yes: true,
      done: false,
      cancelled: true,
    });
  });
});

describe("findOnPath", () => {
  it("finds a Windows binary via PATHEXT, bare name first", () => {
    const seen = new Set([path.join("C:\\tools", "codex.EXE")]);
    const calls: string[] = [];
    const found = findOnPath("codex", {
      platform: "win32",
      pathEnv: "C:\\tools;D:\\bin",
      windowsExtensions: [".EXE"],
      exists: (p) => {
        calls.push(p);
        return seen.has(p);
      },
    });
    assert.equal(found, path.join("C:\\tools", "codex.EXE"));
    assert.equal(calls[0], path.join("C:\\tools", "codex"));
  });

  it("returns undefined when the Windows binary is absent", () => {
    const found = findOnPath("codex", {
      platform: "win32",
      pathEnv: "C:\\tools",
      windowsExtensions: [".EXE"],
      exists: () => false,
    });
    assert.equal(found, undefined);
  });

  it("finds a POSIX binary on PATH", () => {
    const found = findOnPath("codex", {
      platform: "linux",
      pathEnv: "/usr/local/bin:/usr/bin",
      exists: (p) => p === path.join("/usr/local/bin", "codex"),
    });
    assert.equal(found, path.join("/usr/local/bin", "codex"));
  });

  it("returns undefined when the POSIX binary is absent", () => {
    const found = findOnPath("codex", {
      platform: "linux",
      pathEnv: "/usr/local/bin",
      exists: () => false,
    });
    assert.equal(found, undefined);
  });
});

describe("ensureProjectRoot", () => {
  it("returns an existing directory without prompting", async () => {
    let prompted = 0;
    const out = await ensureProjectRoot("/proj", {
      exists: () => true,
      mkdir: async () => {
        throw new Error("must not mkdir");
      },
      confirm: async () => {
        prompted += 1;
        return true;
      },
      reprompt: async () => {
        prompted += 1;
        return "/other";
      },
    });
    assert.equal(out, "/proj");
    assert.equal(prompted, 0);
  });

  it("creates a missing directory after confirmation", async () => {
    const created: string[] = [];
    const out = await ensureProjectRoot("/new", {
      exists: () => false,
      mkdir: async (p) => {
        created.push(p);
      },
      confirm: async () => true,
      reprompt: async () => {
        throw new Error("must not reprompt");
      },
    });
    assert.equal(out, "/new");
    assert.deepEqual(created, ["/new"]);
  });

  it("re-prompts when creation is declined", async () => {
    const out = await ensureProjectRoot("/missing", {
      exists: (p) => p === "/valid",
      mkdir: async () => {
        throw new Error("must not mkdir");
      },
      confirm: async () => false,
      reprompt: async () => "/valid",
    });
    assert.equal(out, "/valid");
  });

  it("re-prompts when creation fails", async () => {
    const questions: string[] = [];
    const out = await ensureProjectRoot("/denied", {
      exists: (p) => p === "/fallback",
      mkdir: async () => {
        throw new Error("EACCES");
      },
      confirm: async () => true,
      reprompt: async (q) => {
        questions.push(q);
        return "/fallback";
      },
    });
    assert.equal(out, "/fallback");
    assert.equal(questions.length, 1);
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

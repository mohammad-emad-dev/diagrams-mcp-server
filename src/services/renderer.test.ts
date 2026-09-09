import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "./diagramStore.js";
import { registerDiagramsRender } from "../tools/diagramsRender.js";
import {
  RenderError,
  isRemotePlantUmlDisabled,
  renderDiagram,
  resolveSpawnTarget,
  runCommand,
  type RemoteRenderResponse,
  type RendererDeps,
} from "./renderer.js";
import { MAX_RENDER_OUTPUT_CHARS } from "../constants.js";

const DISABLE_FLAG = "DISABLE_REMOTE_PLANTUML";
const ALLOW_FLAG = "ALLOW_REMOTE_PLANTUML";
const SECRET_SOURCE = "@startuml\nclass SecretWidgetDoodad\n@enduml\n";
const LOCAL_SVG = Buffer.from("<svg>fake-local-render</svg>", "utf-8");
const REMOTE_SVG = Buffer.from("<svg>fake-remote-render</svg>", "utf-8");

function toArrayBuffer(data: Buffer): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function okRemote(body: Buffer): RemoteRenderResponse {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(toArrayBuffer(body)),
  };
}

function setFlag(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[DISABLE_FLAG];
  } else {
    process.env[DISABLE_FLAG] = value;
  }
}

function setAllow(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ALLOW_FLAG];
  } else {
    process.env[ALLOW_FLAG] = value;
  }
}

/** Deps with no local CLIs; remote calls the given stub (never the network). */
function offlineDeps(fetchRemote?: RendererDeps["fetchRemote"]): Required<RendererDeps> {
  return {
    commandExists: () => Promise.resolve(false),
    runCommand: () => Promise.reject(new Error("command should not run")),
    fetchRemote: fetchRemote ?? (() => Promise.reject(new Error("network access attempted"))),
  };
}

/** Deps where a local `plantuml` CLI succeeds and writes `image`. */
function localPlantUmlDeps(image: Buffer): {
  deps: RendererDeps;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    deps: {
      commandExists: (cmd) => Promise.resolve(cmd === "plantuml"),
      runCommand: async (_cmd, args) => {
        calls.push({ cmd: _cmd, args });
        const inputPath = args[args.length - 1];
        const format = args[0] === "-tpng" ? "png" : "svg";
        await fs.writeFile(path.join(path.dirname(inputPath), `input.${format}`), image);
        return { stdout: "", stderr: "" };
      },
    },
  };
}

/** Deps where a local `mmdc` CLI succeeds and writes `image` to `-o`. */
function localMermaidDeps(image: Buffer): RendererDeps {
  return {
    commandExists: (cmd) => Promise.resolve(cmd === "mmdc"),
    runCommand: async (_cmd, args) => {
      const outIndex = args.indexOf("-o");
      await fs.writeFile(args[outIndex + 1], image);
      return { stdout: "", stderr: "" };
    },
  };
}

async function leakedRenderDirs(before: Set<string>): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((entry) => entry.startsWith("diagrams-mcp-") && !before.has(entry));
}

async function snapshotRenderDirs(): Promise<Set<string>> {
  const entries = await fs.readdir(os.tmpdir());
  return new Set(entries.filter((entry) => entry.startsWith("diagrams-mcp-")));
}

/** Signal-0 existence probe for a process this suite spawned. */
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("renderer PlantUML remote control", () => {
  let savedFlag: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[DISABLE_FLAG];
    savedAllow = process.env[ALLOW_FLAG];
  });

  afterEach(() => {
    setFlag(savedFlag);
    setAllow(savedAllow);
  });

  it("exposes the flag state: remote is disabled unless explicitly allowed", () => {
    setFlag(undefined);
    setAllow(undefined);
    assert.equal(isRemotePlantUmlDisabled(), true);
    setAllow("false");
    assert.equal(isRemotePlantUmlDisabled(), true);
    for (const malformed of ["TRUE", "1", "yes", " true", ""]) {
      setAllow(malformed);
      assert.equal(isRemotePlantUmlDisabled(), true, `allow=${malformed}`);
    }
    setAllow("true");
    assert.equal(isRemotePlantUmlDisabled(), false);
    // DISABLE takes precedence over ALLOW.
    setFlag("true");
    assert.equal(isRemotePlantUmlDisabled(), true);
  });

  it("renders via local plantuml when available and cleans up temp dirs", async () => {
    setFlag(undefined);
    const before = await snapshotRenderDirs();
    const { deps, calls } = localPlantUmlDeps(LOCAL_SVG);

    const result = await renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps);

    assert.deepEqual(result, LOCAL_SVG);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "plantuml");
    assert.deepEqual(await leakedRenderDirs(before), []);
  });

  it("blocks the remote fallback by default when the allow flag is unset (stub only, no network)", async () => {
    setFlag(undefined);
    setAllow(undefined);
    let fetchCalls = 0;
    const deps = offlineDeps(async () => {
      fetchCalls += 1;
      return okRemote(REMOTE_SVG);
    });

    await assert.rejects(renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps), (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.match(err.message, /local 'plantuml' CLI/);
      assert.match(err.message, /remote rendering is disabled/);
      assert.match(err.message, /ALLOW_REMOTE_PLANTUML/);
      assert.ok(!err.message.includes("SecretWidgetDoodad"));
      return true;
    });
    assert.equal(fetchCalls, 0);
  });

  it("allows the remote fallback only with ALLOW_REMOTE_PLANTUML=true (stub only, no network)", async () => {
    setFlag(undefined);
    setAllow("true");
    const urls: string[] = [];
    const deps = offlineDeps(async (url) => {
      urls.push(url);
      return okRemote(REMOTE_SVG);
    });

    const result = await renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps);

    assert.deepEqual(result, REMOTE_SVG);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/svg\//);
  });

  it("DISABLE_REMOTE_PLANTUML=true takes precedence over the allow flag", async () => {
    setFlag("true");
    setAllow("true");
    let fetchCalls = 0;
    const deps = offlineDeps(async () => {
      fetchCalls += 1;
      return okRemote(REMOTE_SVG);
    });

    await assert.rejects(
      renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps),
      /remote rendering is disabled/,
    );
    assert.equal(fetchCalls, 0);
  });

  it("blocks the remote fallback when the flag is 'true' and local is missing", async () => {
    setFlag("true");
    let fetchCalls = 0;
    const deps = offlineDeps(async () => {
      fetchCalls += 1;
      return okRemote(REMOTE_SVG);
    });

    await assert.rejects(renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps), (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.match(err.message, /local 'plantuml' CLI/);
      assert.match(err.message, /remote rendering is disabled/);
      assert.match(err.message, /DISABLE_REMOTE_PLANTUML/);
      return true;
    });
    assert.equal(fetchCalls, 0);
  });

  it("treats malformed allow values as remote-disabled", async () => {
    setFlag(undefined);
    for (const malformed of ["TRUE", "1", "yes", " true", ""]) {
      setAllow(malformed);
      let fetchCalls = 0;
      const deps = offlineDeps(async () => {
        fetchCalls += 1;
        return okRemote(REMOTE_SVG);
      });

      await assert.rejects(
        renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps),
        /remote rendering is disabled/,
        `allow=${malformed}`,
      );
      assert.equal(fetchCalls, 0, `allow=${malformed}`);
    }
  });

  it("keeps remote errors actionable without leaking diagram source", async () => {
    setFlag(undefined);
    setAllow("true");
    const deps = offlineDeps(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        arrayBuffer: () => Promise.reject(new Error("no body")),
      }),
    );

    await assert.rejects(renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps), (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.match(err.message, /responded with 500/);
      assert.ok(!err.message.includes("SecretWidgetDoodad"));
      return true;
    });
  });

  it("disabled-remote error exposes no source, env values, or secrets", async () => {
    setFlag("true");
    process.env.RENDERER_TEST_SECRET = "top-secret-value-123";
    try {
      const deps = offlineDeps();
      let message = "";
      try {
        await renderDiagram(SECRET_SOURCE, "plantuml", "png", deps);
      } catch (err: unknown) {
        assert.ok(err instanceof RenderError);
        message = err.message;
      }
      assert.ok(message.length > 0);
      assert.ok(!message.includes("SecretWidgetDoodad"));
      assert.ok(!message.includes("top-secret-value-123"));
      assert.ok(!message.includes("https://"));
    } finally {
      delete process.env.RENDERER_TEST_SECRET;
    }
  });

  it("cleans up temp dirs when the local plantuml command fails", async () => {
    setFlag("true");
    const before = await snapshotRenderDirs();
    const deps: RendererDeps = {
      commandExists: () => Promise.resolve(true),
      runCommand: () => Promise.reject(new Error("plantuml failed")),
    };

    await assert.rejects(renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps));
    assert.deepEqual(await leakedRenderDirs(before), []);
  });

  it("handles concurrent renders without shared-state interference", async () => {
    setFlag("true");
    let fetchCalls = 0;
    const blocked = offlineDeps(async () => {
      fetchCalls += 1;
      return okRemote(REMOTE_SVG);
    });
    const { deps: localDeps } = localPlantUmlDeps(LOCAL_SVG);

    const [first, second] = await Promise.all([
      assert
        .rejects(
          renderDiagram(SECRET_SOURCE, "plantuml", "svg", blocked),
          /remote rendering is disabled/,
        )
        .then(() => "blocked-a"),
      assert
        .rejects(
          renderDiagram(SECRET_SOURCE, "plantuml", "png", blocked),
          /remote rendering is disabled/,
        )
        .then(() => "blocked-b"),
    ]);
    assert.deepEqual([first, second], ["blocked-a", "blocked-b"]);
    assert.equal(fetchCalls, 0);

    const [svg, png] = await Promise.all([
      renderDiagram(SECRET_SOURCE, "plantuml", "svg", localDeps),
      renderDiagram(SECRET_SOURCE, "plantuml", "png", localDeps),
    ]);
    assert.deepEqual(svg, LOCAL_SVG);
    assert.deepEqual(png, LOCAL_SVG);
  });
});

describe("renderer mermaid unchanged", () => {
  let savedFlag: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[DISABLE_FLAG];
    savedAllow = process.env[ALLOW_FLAG];
  });

  afterEach(() => {
    setFlag(savedFlag);
    setAllow(savedAllow);
  });

  it("still requires the local mmdc CLI, even with remote disabled", async () => {
    setFlag("true");
    await assert.rejects(
      renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", offlineDeps()),
      (err: unknown) => {
        assert.ok(err instanceof RenderError);
        assert.match(err.message, /'mmdc' CLI/);
        return true;
      },
    );
  });

  it("renders via local mmdc when available and cleans up temp dirs", async () => {
    setFlag(undefined);
    const before = await snapshotRenderDirs();

    const result = await renderDiagram(
      "graph TD\n  A-->B\n",
      "mermaid",
      "svg",
      localMermaidDeps(LOCAL_SVG),
    );

    assert.deepEqual(result, LOCAL_SVG);
    assert.deepEqual(await leakedRenderDirs(before), []);
  });

  it("cleans up temp dirs when mmdc fails", async () => {
    setFlag(undefined);
    const before = await snapshotRenderDirs();
    const deps: RendererDeps = {
      commandExists: () => Promise.resolve(true),
      runCommand: () => Promise.reject(new Error("mmdc failed")),
    };

    await assert.rejects(renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", deps));
    assert.deepEqual(await leakedRenderDirs(before), []);
  });
});

describe("renderer command resolution (Windows npm shims)", () => {
  let savedFlag: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[DISABLE_FLAG];
    savedAllow = process.env[ALLOW_FLAG];
  });

  afterEach(() => {
    setFlag(savedFlag);
    setAllow(savedAllow);
  });

  function enoent(cmd: string): Error {
    return Object.assign(new Error(`spawn ${cmd} ENOENT`), {
      code: "ENOENT",
    });
  }

  it("detection and execution use the same resolved shim command", async () => {
    setFlag(undefined);
    const before = await snapshotRenderDirs();
    const commands: string[] = [];
    const deps: RendererDeps = {
      // Simulate Windows: only the `mmdc.cmd` npm shim resolves.
      commandExists: (cmd) => Promise.resolve(cmd === "mmdc.cmd"),
      runCommand: async (cmd, args) => {
        commands.push(cmd);
        const outIndex = args.indexOf("-o");
        await fs.writeFile(args[outIndex + 1], LOCAL_SVG);
        return { stdout: "", stderr: "" };
      },
    };

    const result = await renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", deps);

    assert.deepEqual(result, LOCAL_SVG);
    assert.deepEqual(commands, ["mmdc.cmd"]);
    assert.deepEqual(await leakedRenderDirs(before), []);
  });

  it("falls through from an unlaunchable bare name to the shim on ENOENT", async () => {
    setFlag(undefined);
    const commands: string[] = [];
    const deps: RendererDeps = {
      commandExists: (cmd) => Promise.resolve(cmd === "mmdc" || cmd === "mmdc.cmd"),
      runCommand: async (cmd, args) => {
        commands.push(cmd);
        if (cmd === "mmdc") throw enoent(cmd);
        const outIndex = args.indexOf("-o");
        await fs.writeFile(args[outIndex + 1], LOCAL_SVG);
        return { stdout: "", stderr: "" };
      },
    };

    const result = await renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", deps);

    assert.deepEqual(result, LOCAL_SVG);
    assert.deepEqual(commands, ["mmdc", "mmdc.cmd"]);
  });

  it("returns an actionable error when a detected mmdc cannot be executed", async () => {
    setFlag(undefined);
    const deps: RendererDeps = {
      commandExists: () => Promise.resolve(true),
      runCommand: () => Promise.reject(enoent("mmdc")),
    };

    await assert.rejects(
      renderDiagram("graph TD\n  SecretWidgetDoodad-->B\n", "mermaid", "svg", deps),
      (err: unknown) => {
        assert.ok(err instanceof RenderError);
        assert.match(err.message, /mmdc/);
        assert.match(err.message, /could not be executed/);
        assert.ok(!err.message.includes("spawn mmdc ENOENT"));
        assert.ok(!err.message.includes("SecretWidgetDoodad"));
        return true;
      },
    );
  });

  it("returns an actionable error without remote fallback when local plantuml cannot be executed", async () => {
    setFlag(undefined);
    let fetchCalls = 0;
    const deps: RendererDeps = {
      commandExists: () => Promise.resolve(true),
      runCommand: () => Promise.reject(enoent("plantuml")),
      fetchRemote: async () => {
        fetchCalls += 1;
        return okRemote(REMOTE_SVG);
      },
    };

    await assert.rejects(renderDiagram(SECRET_SOURCE, "plantuml", "svg", deps), (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.match(err.message, /plantuml/);
      assert.match(err.message, /could not be executed/);
      assert.ok(!err.message.includes("spawn plantuml ENOENT"));
      assert.ok(!err.message.includes("SecretWidgetDoodad"));
      return true;
    });
    assert.equal(fetchCalls, 0);
  });

  it("does not retry candidates on non-spawn failures", async () => {
    setFlag(undefined);
    const commands: string[] = [];
    const deps: RendererDeps = {
      commandExists: () => Promise.resolve(true),
      runCommand: async (cmd) => {
        commands.push(cmd);
        throw new Error("mmdc failed: bad diagram syntax");
      },
    };

    await assert.rejects(
      renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", deps),
      /bad diagram syntax/,
    );
    assert.deepEqual(commands, ["mmdc"]);
  });

  it("falls through to the shim when the bare name fails with EINVAL", async () => {
    setFlag(undefined);
    const commands: string[] = [];
    const einval = Object.assign(new Error("spawn EINVAL"), {
      code: "EINVAL",
    });
    const deps: RendererDeps = {
      commandExists: (cmd) => Promise.resolve(cmd === "mmdc" || cmd === "mmdc.cmd"),
      runCommand: async (cmd, args) => {
        commands.push(cmd);
        if (cmd === "mmdc") throw einval;
        const outIndex = args.indexOf("-o");
        await fs.writeFile(args[outIndex + 1], LOCAL_SVG);
        return { stdout: "", stderr: "" };
      },
    };

    const result = await renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", deps);

    assert.deepEqual(result, LOCAL_SVG);
    assert.deepEqual(commands, ["mmdc", "mmdc.cmd"]);
  });

  it("resolveSpawnTarget wraps shims for cmd.exe on win32 only", () => {
    const interpreter = process.env.ComSpec ?? "cmd.exe";

    const wrapped = resolveSpawnTarget(
      "mmdc.cmd",
      ["-i", "C:\\Temp\\a b\\input.mmd", "-o", "C:\\Temp\\a b\\output.svg"],
      "win32",
    );
    assert.equal(wrapped.cmd, interpreter);
    assert.deepEqual(wrapped.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(
      wrapped.args[3],
      'mmdc.cmd -i "C:\\Temp\\a b\\input.mmd" -o "C:\\Temp\\a b\\output.svg"',
    );

    const bat = resolveSpawnTarget("plantuml.bat", ["-tsvg", "in.puml"], "win32");
    assert.equal(bat.cmd, interpreter);
    assert.deepEqual(bat.args.slice(0, 3), ["/d", "/s", "/c"]);

    // Bare names, real executables, and non-Windows platforms are untouched.
    assert.deepEqual(resolveSpawnTarget("mmdc", ["-i", "in.mmd"], "win32"), {
      cmd: "mmdc",
      args: ["-i", "in.mmd"],
    });
    assert.deepEqual(resolveSpawnTarget("plantuml.exe", ["-tsvg", "in.puml"], "win32"), {
      cmd: "plantuml.exe",
      args: ["-tsvg", "in.puml"],
    });
    assert.deepEqual(resolveSpawnTarget("mmdc.cmd", ["-i", "in.mmd"], "linux"), {
      cmd: "mmdc.cmd",
      args: ["-i", "in.mmd"],
    });
  });
});

describe("renderer bounded child-process output", () => {
  const nodeCmd = process.execPath;

  it("exposes the output cap as a documented positive bound", () => {
    assert.ok(Number.isInteger(MAX_RENDER_OUTPUT_CHARS));
    assert.ok(MAX_RENDER_OUTPUT_CHARS > 0);
  });

  it("returns normal stdout and stderr for diagnostics", async () => {
    const result = await runCommand(nodeCmd, [
      "-e",
      "process.stdout.write('diag-out');process.stderr.write('diag-err');",
    ]);

    assert.equal(result.stdout, "diag-out");
    assert.equal(result.stderr, "diag-err");
  });

  it("accepts output exactly at the cap", async () => {
    const result = await runCommand(nodeCmd, [
      "-e",
      `process.stdout.write('a'.repeat(${MAX_RENDER_OUTPUT_CHARS}));`,
    ]);

    assert.equal(result.stdout.length, MAX_RENDER_OUTPUT_CHARS);
  });

  it(
    "stops an over-limit stdout flood with a bounded RenderError",
    { timeout: 20_000 },
    async () => {
      const marker = "BoundMarkerZulu9";
      let message = "";
      try {
        await runCommand(nodeCmd, [
          "-e",
          `const s='${marker}-'.padEnd(65536,'x');process.stdout.write(s);setInterval(()=>process.stdout.write(s),1);`,
        ]);
        assert.fail("expected an output-limit RenderError");
      } catch (err: unknown) {
        assert.ok(err instanceof RenderError);
        message = err.message;
      }

      assert.match(message, /exceeded/);
      assert.match(message, /limit/);
      assert.ok(message.includes(String(MAX_RENDER_OUTPUT_CHARS)));
      assert.ok(!message.includes(marker));
      assert.ok(message.length < MAX_RENDER_OUTPUT_CHARS);
    },
  );

  it("caps over-limit stderr without leaking content", async () => {
    const marker = "BoundMarkerYankee4";
    let message = "";
    try {
      await runCommand(nodeCmd, [
        "-e",
        `for(let i=0;i<64;i++)process.stderr.write('${marker}-'.padEnd(65536,'x'));`,
      ]);
      assert.fail("expected an output-limit RenderError");
    } catch (err: unknown) {
      assert.ok(err instanceof RenderError);
      message = err.message;
    }

    assert.match(message, /exceeded/);
    assert.match(message, /limit/);
    assert.ok(!message.includes(marker));
    assert.ok(message.length < MAX_RENDER_OUTPUT_CHARS);
  });

  it("preserves non-zero exit with the stderr message", async () => {
    await assert.rejects(
      runCommand(nodeCmd, ["-e", "process.stderr.write('diag-line');process.exit(3);"]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof RenderError));
        assert.equal(err.message, "diag-line");
        return true;
      },
    );
  });

  it("rejects a hung renderer with an explicit timeout RenderError", async () => {
    const started = Date.now();
    let message = "";
    try {
      await runCommand(nodeCmd, ["-e", "setTimeout(()=>{},30000);"], 300);
      assert.fail("expected a timeout RenderError");
    } catch (err: unknown) {
      assert.ok(err instanceof RenderError);
      message = err.message;
    }

    assert.match(message, /timed out/);
    assert.ok(message.includes("300"));
    assert.ok(!message.includes("exited with code"));
    assert.ok(Date.now() - started < 10_000);
  });

  it("delivers the timeout error promptly when a descendant holds the pipe open", async () => {
    // The child spawns a grandchild that inherits stdout/stderr and outlives
    // the timeout. Error delivery must not wait for those pipes to close.
    const started = Date.now();
    let message = "";
    try {
      await runCommand(
        nodeCmd,
        [
          "-e",
          "const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>{},20000);",
        ],
        300,
      );
      assert.fail("expected a timeout RenderError");
    } catch (err: unknown) {
      assert.ok(err instanceof RenderError);
      message = err.message;
    }

    assert.match(message, /timed out/);
    assert.ok(Date.now() - started < 10_000);
  });

  it(
    "delivers the timeout error when the killed shim wrapper leaves a descendant holding the pipes",
    { timeout: 10_000 },
    async (t) => {
      if (process.platform !== "win32") {
        t.skip("Windows shim chains (cmd.exe wrappers) do not exist on this platform");
        return;
      }
      // Regression for the release-verification delay: Windows npm shims run
      // via `cmd.exe /d /s /c <renderer>`, so the timeout kill stops the
      // wrapper while its grandchild (the real renderer process) keeps the
      // inherited stdout/stderr handles open. Delivery must not wait for
      // those pipes to close; the pre-fix code only rejected with
      // "Command exited with code null" once the descendant released them.
      const started = Date.now();
      let message = "";
      try {
        await runCommand(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", "ping -n 7 127.0.0.1"],
          300,
        );
        assert.fail("expected a timeout RenderError");
      } catch (err: unknown) {
        assert.ok(err instanceof RenderError);
        message = err.message;
      }

      assert.match(message, /timed out/);
      assert.ok(!message.includes("exited with code"));
      assert.ok(Date.now() - started < 5000);
    },
  );

  it("stops the renderer process itself after the timeout", { timeout: 10_000 }, async () => {
    const pidFile = path.join(os.tmpdir(), `diagrams-mcp-pid-${process.pid}-${Date.now()}.txt`);
    try {
      await assert.rejects(
        runCommand(
          nodeCmd,
          [
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
              "setTimeout(()=>{},30000);",
          ],
          1000,
        ),
        (err: unknown) => err instanceof RenderError,
      );
      // The child writes its own pid before hanging, so the handle to the
      // killed process can be checked directly instead of inferred.
      let pid = 0;
      for (let i = 0; i < 20 && pid === 0; i += 1) {
        try {
          pid = Number(await fs.readFile(pidFile, "utf-8"));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.ok(Number.isInteger(pid) && pid > 0);
      // The killed child's handle is released shortly after the stop; poll
      // briefly so the check is deterministic without waiting on pid reuse.
      let stopped = false;
      for (let i = 0; i < 20 && !stopped; i += 1) {
        stopped = !(await isProcessAlive(pid));
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(stopped, "the timed-out renderer process should be stopped");
    } finally {
      await fs.rm(pidFile, { force: true });
    }
  });

  it("cleans up the render temp directory after a timeout", async () => {
    const hangingRun: NonNullable<RendererDeps["runCommand"]> = () =>
      runCommand(nodeCmd, ["-e", "setTimeout(()=>{},30000);"], 300);
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("diagrams-mcp-"));

    await assert.rejects(
      renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", {
        commandExists: () => Promise.resolve(true),
        runCommand: hangingRun,
      }),
      (err: unknown) => {
        assert.ok(err instanceof RenderError);
        assert.match(err.message, /timed out/);
        return true;
      },
    );

    const leaked = (await fs.readdir(os.tmpdir()))
      .filter((n) => n.startsWith("diagrams-mcp-"))
      .filter((n) => !before.includes(n));
    assert.deepEqual(leaked, []);
  });

  it("cleans up the render temp directory after a non-zero exit", async () => {
    const failingRun: NonNullable<RendererDeps["runCommand"]> = () =>
      Promise.reject(new Error("diag-boom"));
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("diagrams-mcp-"));

    await assert.rejects(
      renderDiagram("graph TD\n  A-->B\n", "mermaid", "svg", {
        commandExists: () => Promise.resolve(true),
        runCommand: failingRun,
      }),
      /diag-boom/,
    );

    const leaked = (await fs.readdir(os.tmpdir()))
      .filter((n) => n.startsWith("diagrams-mcp-"))
      .filter((n) => !before.includes(n));
    assert.deepEqual(leaked, []);
  });
});

describe("diagrams_render MCP error behavior", () => {
  let tmpRoot: string;
  let savedFlag: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-render-"));
    savedFlag = process.env[DISABLE_FLAG];
    savedAllow = process.env[ALLOW_FLAG];
  });

  afterEach(async () => {
    setFlag(savedFlag);
    setAllow(savedAllow);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  interface CapturedRenderTool {
    name: string;
    handler: (params: { relative_path: string; format?: "svg" | "png" }) => Promise<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
  }

  function captureTool(ctx: ServerContext): CapturedRenderTool {
    const captured = {} as CapturedRenderTool;
    const fakeServer = {
      registerTool: (
        name: string,
        config: unknown,
        handler: CapturedRenderTool["handler"],
      ): void => {
        captured.name = name;
        void config;
        captured.handler = handler;
      },
    } as unknown as McpServer;
    registerDiagramsRender(fakeServer, ctx);
    return captured;
  }

  it("returns isError with the disabled-remote message and no source leak", async (t) => {
    setFlag("true");
    const ctx: ServerContext = {
      diagramStore: new DiagramStore(tmpRoot),
      codeRootDir: tmpRoot,
    };
    await ctx.diagramStore.write("models/private.puml", SECRET_SOURCE, {
      overwrite: false,
    });

    // Probe with real deps: if a local plantuml CLI exists the MCP handler
    // would succeed instead of hitting the disabled-remote error.
    try {
      await renderDiagram(SECRET_SOURCE, "plantuml", "svg");
      t.skip("local plantuml CLI is installed; disabled-remote MCP path not reachable here");
      return;
    } catch (err: unknown) {
      if (!(err instanceof RenderError) || !/remote rendering is disabled/.test(err.message)) {
        t.skip(`unexpected renderer environment: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    const tool = captureTool(ctx);
    assert.equal(tool.name, "diagrams_render");
    const result = await tool.handler({ relative_path: "models/private.puml" });

    assert.equal(result.isError, true);
    const text = result.content[0].text ?? "";
    assert.match(text, /remote rendering is disabled/);
    assert.match(text, /local 'plantuml' CLI/);
    assert.ok(!text.includes("SecretWidgetDoodad"));
  });
});

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { validateDiagramSource } from "../services/diagramValidator.js";
import { ScopeEscapeError } from "../services/scopeResolve.js";
import type { GenerateDeps } from "../services/generate/collectEntities.js";
import {
  diagramsGenerateSequenceInputSchema,
  registerDiagramsGenerateSequence,
} from "./diagramsGenerateSequence.js";

// The tool is read-only: this snapshot proves no file appears under the
// project root (or the diagrams root) as a result of a call.
async function listAllFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listAllFiles(absolute, base)));
    } else {
      found.push(path.relative(base, absolute));
    }
  }
  return found;
}

interface CapturedToolResult {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

function captureTool(
  register: (server: McpServer, ctx: ServerContext, deps?: GenerateDeps) => void,
  ctx: ServerContext,
  deps?: GenerateDeps,
): { handler: CapturedToolHandler } {
  const captured = {} as { handler: CapturedToolHandler };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx, deps);
  return captured;
}

/**
 * Call a captured handler the way the server does: the SDK runs safeParse on
 * the input schema first, which is what applies the documented defaults.
 */
async function callHandler(
  tool: { handler: CapturedToolHandler },
  args: Record<string, unknown>,
): Promise<CapturedToolResult> {
  const parsed = diagramsGenerateSequenceInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface SequenceMessage {
  from: string;
  to: string;
  message: string;
  line: number;
  via_callback: boolean;
}

interface SequenceOutput {
  scope: string;
  format: string;
  source: string;
  participants: string[];
  participants_included: number;
  participants_available: number;
  participants_capped: boolean;
  participant_limit: number;
  messages: SequenceMessage[];
  messages_included: number;
  messages_available: number;
  messages_capped: boolean;
  message_limit: number;
  deferred_count: number;
  unresolved_callees: string[];
  files_scanned: number;
  truncated: boolean;
  scan_limit: number;
  scan_warning: string | null;
  confidence: string;
  heuristic_warning: string;
  written: boolean;
}

/** Typed view of a successful result's structuredContent. */
function structuredOf(result: CapturedToolResult): SequenceOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as SequenceOutput;
}

/**
 * Assert no emitted message is a deferred one. Takes the array untyped on
 * purpose: assert.deepEqual(x, []) narrows x to never[], which would make the
 * element type useless here.
 */
function assertAllSequenced(messages: unknown): void {
  assert.ok(Array.isArray(messages), "messages must be an array");
  for (const message of messages as Array<{ via_callback: boolean }>) {
    assert.equal(message.via_callback, false);
  }
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf-8");
  }
}

// A caller importing two callees: the AST ignores import specifiers when
// collecting declarations, so "charge" and "ship" resolve to their declarers.
const CALLER =
  "import { charge } from './payment.js';\nimport { ship } from './shipping.js';\n\n" +
  "export function checkout() {\n  charge();\n  ship();\n}\n";
const PAYMENT = "export function charge() {\n  return 1;\n}\n";
const SHIPPING = "export function ship() {\n  return 2;\n}\n";

/** Deps that report no compiler, exercising the regex union fallback. */
const NO_COMPILER: GenerateDeps = { loadTsModule: async () => null };

describe("diagrams_generate_sequence", () => {
  let projectRoot: string;
  let ctx: ServerContext;
  let filesBefore: Set<string>;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "seq-tool-"));
    await writeFiles(path.join(projectRoot, "src"), {
      "checkout.ts": CALLER,
      "payment.ts": PAYMENT,
      "shipping.ts": SHIPPING,
    });
    ctx = {
      diagramStore: new DiagramStore(path.join(projectRoot, "diagrams")),
      codeRootDir: projectRoot,
    };
    filesBefore = new Set(await listAllFiles(projectRoot));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("sequences a two-callee conversation and emits validated PlantUML", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "src" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.scope, "src");
    assert.equal(structured.format, "puml");
    assert.deepEqual(structured.participants, ["checkout", "payment", "shipping"]);
    assert.equal(structured.participants_included, 3);
    assert.equal(structured.participants_available, 3);
    assert.equal(structured.participants_capped, false);
    assert.equal(structured.participant_limit, 8);
    assert.deepEqual(structured.messages, [
      { from: "checkout", to: "payment", message: "charge", line: 5, via_callback: false },
      { from: "checkout", to: "shipping", message: "ship", line: 6, via_callback: false },
    ]);
    assert.equal(structured.messages_included, 2);
    // Deferred calls are counted, never sequenced.
    assertAllSequenced(structured.messages);
    assert.equal(structured.messages_available, 2);
    assert.equal(structured.messages_capped, false);
    assert.equal(structured.message_limit, 20);
    assert.equal(structured.deferred_count, 0);
    assert.deepEqual(structured.unresolved_callees, []);
    assert.equal(structured.files_scanned, 3);
    assert.equal(structured.truncated, false);
    assert.equal(structured.scan_limit, 5000);
    assert.equal(structured.scan_warning, null);
    assert.equal(structured.confidence, "heuristic");
    assert.ok(structured.heuristic_warning.length > 0);
    assert.equal(structured.written, false);
    // The text block is the generated source itself.
    assert.equal(result.content[0].text, structured.source);
    validateDiagramSource(structured.source, "plantuml");
    assert.ok(structured.source.includes("checkout -> payment : charge"));
  });

  it("emits the same conversation as validated Mermaid", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "src", format: "mermaid" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.format, "mermaid");
    assert.deepEqual(structured.participants, ["checkout", "payment", "shipping"]);
    validateDiagramSource(structured.source, "mermaid");
    assert.ok(structured.source.startsWith("sequenceDiagram\n"));
    assert.ok(structured.source.includes("checkout->>payment: charge"));
  });

  it("reports the participant cap in-band and drops messages to capped boxes", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "src", max_participants: 1 });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.participants, ["checkout"]);
    assert.equal(structured.participants_included, 1);
    assert.equal(structured.participants_available, 3);
    assert.equal(structured.participants_capped, true);
    assert.equal(structured.participant_limit, 1);
    // A sequence must never message an undeclared box, so the two messages
    // to capped participants are dropped and the drop is reported.
    assert.deepEqual(structured.messages, []);
    assert.equal(structured.messages_included, 0);
    assert.equal(structured.messages_available, 2);
    assert.equal(structured.messages_capped, true);
    validateDiagramSource(structured.source, "plantuml");
  });

  it("reports the message cap in-band while keeping every participant", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "src", max_messages: 1 });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.participants, ["checkout", "payment", "shipping"]);
    assert.equal(structured.participants_capped, false);
    assert.equal(structured.messages_included, 1);
    assert.equal(structured.messages_available, 2);
    assert.equal(structured.messages_capped, true);
    assert.equal(structured.message_limit, 1);
    assert.equal(structured.messages[0].message, "charge");
    validateDiagramSource(structured.source, "plantuml");
  });

  it("counts a setTimeout callback as deferred and never sequences it", async () => {
    const timerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "seq-cb-"));
    try {
      await writeFiles(timerRoot, {
        "timer.ts":
          "import { charge } from './payment.js';\n\nexport function schedule() {\n  setTimeout(() => charge(), 10);\n}\n",
        "payment.ts": PAYMENT,
      });
      const timerCtx: ServerContext = {
        diagramStore: new DiagramStore(path.join(timerRoot, "diagrams")),
        codeRootDir: timerRoot,
      };
      const tool = captureTool(registerDiagramsGenerateSequence, timerCtx);
      const result = await callHandler(tool, { scope: "." });
      const structured = structuredOf(result);

      assert.equal(result.isError, undefined);
      assert.deepEqual(structured.messages, []);
      assert.equal(structured.messages_available, 0);
      // Both the wrapper and the call inside it sit on a deferred line.
      assert.equal(structured.deferred_count, 2);
      validateDiagramSource(structured.source, "plantuml");
    } finally {
      await fs.rm(timerRoot, { recursive: true, force: true });
    }
  });

  it("counts a promise .then callback as deferred too", async () => {
    const promiseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "seq-then-"));
    try {
      await writeFiles(promiseRoot, {
        "async.ts":
          "import { charge } from './payment.js';\n\nexport function after() {\n  Promise.resolve().then(() => charge());\n}\n",
        "payment.ts": PAYMENT,
      });
      const promiseCtx: ServerContext = {
        diagramStore: new DiagramStore(path.join(promiseRoot, "diagrams")),
        codeRootDir: promiseRoot,
      };
      const tool = captureTool(registerDiagramsGenerateSequence, promiseCtx);
      const result = await callHandler(tool, { scope: "." });
      const structured = structuredOf(result);

      assert.equal(result.isError, undefined);
      assert.deepEqual(structured.messages, []);
      assert.ok(structured.deferred_count >= 1, "the deferred call must be counted");
      // No emitted message is ever a deferred one.
      assertAllSequenced(structured.messages);
    } finally {
      await fs.rm(promiseRoot, { recursive: true, force: true });
    }
  });

  it("reports unresolved callees instead of inventing a participant", async () => {
    const noisyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "seq-unresolved-"));
    try {
      await writeFiles(noisyRoot, {
        "noisy.ts": "export function run() {\n  console.log('x');\n  debug();\n}\n",
      });
      const noisyCtx: ServerContext = {
        diagramStore: new DiagramStore(path.join(noisyRoot, "diagrams")),
        codeRootDir: noisyRoot,
      };
      const tool = captureTool(registerDiagramsGenerateSequence, noisyCtx);
      const result = await callHandler(tool, { scope: "." });
      const structured = structuredOf(result);

      assert.equal(result.isError, undefined);
      assert.deepEqual(structured.messages, []);
      assert.equal(structured.messages_available, 0);
      // Neither callee is declared anywhere in the scope, so both are
      // reported — never turned into a participant.
      assert.deepEqual(structured.unresolved_callees, ["log", "debug"]);
      assert.deepEqual(structured.participants, []);
      validateDiagramSource(structured.source, "plantuml");
    } finally {
      await fs.rm(noisyRoot, { recursive: true, force: true });
    }
  });

  it("quotes a dashed participant in PlantUML and sanitizes it in Mermaid", async () => {
    const dashedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "seq-dash-"));
    try {
      await writeFiles(dashedRoot, {
        "my-checkout.ts":
          "import { charge } from './payment.js';\n\nexport function run() {\n  charge();\n}\n",
        "payment.ts": PAYMENT,
      });
      const dashedCtx: ServerContext = {
        diagramStore: new DiagramStore(path.join(dashedRoot, "diagrams")),
        codeRootDir: dashedRoot,
      };
      const tool = captureTool(registerDiagramsGenerateSequence, dashedCtx);

      const puml = await callHandler(tool, { scope: "." });
      const pumlStructured = structuredOf(puml);
      assert.equal(puml.isError, undefined);
      assert.deepEqual(pumlStructured.participants, ["my-checkout", "payment"]);
      validateDiagramSource(pumlStructured.source, "plantuml");
      assert.ok(pumlStructured.source.includes('participant "my-checkout"'));
      // Only the unsafe name is quoted; "payment" stays bare.
      assert.ok(pumlStructured.source.includes('"my-checkout" -> payment : charge'));

      const mmd = await callHandler(tool, { scope: ".", format: "mermaid" });
      const mmdStructured = structuredOf(mmd);
      assert.equal(mmd.isError, undefined);
      // Mermaid has no quoted names, so the dash becomes an identifier; the
      // reported participants are exactly what the source renders.
      assert.deepEqual(mmdStructured.participants, ["my_checkout", "payment"]);
      validateDiagramSource(mmdStructured.source, "mermaid");
      assert.ok(mmdStructured.source.includes("participant my_checkout"));
      assert.ok(mmdStructured.source.includes("my_checkout->>payment: charge"));
    } finally {
      await fs.rm(dashedRoot, { recursive: true, force: true });
    }
  });

  it("refuses a scope outside the project root with the shared typed error", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "../outside" });

    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /^Error: Refused to resolve scope outside the project root: '\.\.\/outside'\./,
    );
  });

  it("reuses the exact scope resolver error class and message", async () => {
    // Same error feature 1 ships; no second implementation.
    assert.throws(
      () => {
        throw new ScopeEscapeError("../outside");
      },
      (err: unknown) =>
        err instanceof ScopeEscapeError &&
        err.message ===
          "Refused to resolve scope outside the project root: '../outside'. " +
            "Use a relative path inside the project root.",
    );

    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "../../etc/passwd" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Refused to resolve scope outside the project root/);
  });

  it("bounds max_participants and max_messages to the documented ranges", () => {
    // Ranges are enforced by the schema, before the handler is reached: the
    // SDK's safeParse is what turns these into Invalid arguments errors.
    for (const [field, ceiling] of [
      ["max_participants", 20],
      ["max_messages", 50],
    ] as const) {
      for (const bad of [0, ceiling + 1, 100]) {
        const parsed = diagramsGenerateSequenceInputSchema.safeParse({
          scope: "src",
          [field]: bad,
        });
        assert.equal(parsed.success, false, `${field}=${bad} must be rejected`);
        assert.ok(
          !parsed.success && JSON.stringify(parsed.error.issues).includes(field),
          `${field}=${bad} rejection must name the field`,
        );
      }
      for (const good of [1, ceiling]) {
        const parsed = diagramsGenerateSequenceInputSchema.safeParse({
          scope: "src",
          [field]: good,
        });
        assert.equal(parsed.success, true, `${field}=${good} must be accepted`);
      }
    }
  });

  it("rejects unknown arguments under the strict schema", () => {
    const parsed = diagramsGenerateSequenceInputSchema.safeParse({
      scope: "src",
      output_dir: "diagrams",
    });
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && JSON.stringify(parsed.error.issues).includes("output_dir"),
      "the strict schema must name the unrecognized key",
    );
  });

  it("keeps messages, never throwing, when the compiler is missing", async () => {
    const tool = captureTool(
      (server, context) => registerDiagramsGenerateSequence(server, context, NO_COMPILER),
      ctx,
    );
    const result = await callHandler(tool, { scope: "src" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.participants, ["checkout", "payment", "shipping"]);
    assert.equal(structured.messages_included, 2);
    validateDiagramSource(structured.source, "plantuml");
  });

  it("emits a valid empty diagram for a scope without code files", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "nonexistent-dir" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.participants, []);
    assert.equal(structured.participants_available, 0);
    assert.equal(structured.participants_capped, false);
    assert.deepEqual(structured.messages, []);
    assert.equal(structured.messages_available, 0);
    assert.equal(structured.deferred_count, 0);
    assert.equal(structured.files_scanned, 0);
    validateDiagramSource(structured.source, "plantuml");
  });

  it("reports the scan cap in-band when the file limit is reached", async () => {
    // Same trip wire as the consistency checker's truncation test: enough
    // files to cross MAX_SCAN_FILES. Each calls into a participant the cap
    // also removes, so the result stays bounded while files_scanned hits
    // the cap.
    const bulkDir = path.join(projectRoot, "bulk");
    await fs.mkdir(bulkDir, { recursive: true });
    for (let index = 0; index < 5005; index += 1) {
      await fs.writeFile(
        path.join(bulkDir, `file${index}.js`),
        "export function checkout() {\n  charge();\n}\n",
      );
    }

    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    const result = await callHandler(tool, { scope: "bulk" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.truncated, true);
    assert.equal(structured.scan_limit, 5000);
    assert.ok(
      structured.files_scanned <= structured.scan_limit,
      `files_scanned ${structured.files_scanned} must not exceed the cap`,
    );
    // The warning is the sequence-specific wording, not the checker's.
    assert.match(structured.scan_warning ?? "", /generated messages may be incomplete/i);
    validateDiagramSource(structured.source, "plantuml");
  });

  it("never writes a file under the project root or the diagrams root", async () => {
    const tool = captureTool(registerDiagramsGenerateSequence, ctx);
    for (const args of [
      { scope: "src" },
      { scope: "src", format: "mermaid" as const },
      { scope: "src", max_participants: 1 },
      { scope: "src", max_messages: 1 },
      { scope: "nonexistent-dir" },
      {},
    ]) {
      const result = await callHandler(tool, args);
      assert.equal(result.isError, undefined, JSON.stringify(args));
      assert.equal(structuredOf(result).written, false);
    }

    // The diagrams root is created lazily by the store; a read-only tool must
    // not be the reason it exists, and no other file may appear.
    const filesAfter = new Set(await listAllFiles(projectRoot));
    assert.deepEqual([...filesAfter].sort(), [...filesBefore].sort());
    assert.ok(!filesAfter.has("diagrams"));
  });
});

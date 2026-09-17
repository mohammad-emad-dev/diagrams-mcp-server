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
import { diagramsGenerateInputSchema, registerDiagramsGenerate } from "./diagramsGenerate.js";
import type { GenerateDeps } from "../services/generate/collectEntities.js";

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
  register: (server: McpServer, ctx: ServerContext) => void,
  ctx: ServerContext,
): { handler: CapturedToolHandler } {
  const captured = {} as { handler: CapturedToolHandler };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx);
  return captured;
}

const FIXTURES = {
  "base.ts":
    "export interface Named {\n  name: string;\n}\n\nexport class Base {\n  id: number;\n}\n",
  "widget.ts":
    "import { Base } from './base';\n\nexport class Widget extends Base implements Named {\n  id: number;\n}\n",
  "service.py": "class Service:\n    def handle(self):\n        pass\n",
};

/** Deps that report no compiler, exercising the regex fallback. */
const NO_COMPILER: GenerateDeps = { loadTsModule: async () => null };

/**
 * Call a captured handler the way the server does: the SDK runs safeParse on
 * the input schema first, which is what applies the documented defaults.
 */
async function callHandler(
  tool: { handler: CapturedToolHandler },
  args: Record<string, unknown>,
): Promise<CapturedToolResult> {
  const parsed = diagramsGenerateInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface GenerateOutput {
  scope: string;
  format: string;
  source: string;
  entities: string[];
  entities_included: number;
  entities_available: number;
  entities_capped: boolean;
  entity_limit: number;
  relations: Array<{ from: string; to: string; kind: string }>;
  relations_included: number;
  relations_available: number;
  relations_capped: boolean;
  relation_limit: number;
  files_scanned: number;
  truncated: boolean;
  scan_limit: number;
  scan_warning: string | null;
  dialect_note: string | null;
  confidence: string;
  heuristic_warning: string;
  written: boolean;
}

/** Typed view of a successful result's structuredContent. */
function structuredOf(result: CapturedToolResult): GenerateOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as GenerateOutput;
}

describe("diagrams_generate", () => {
  let projectRoot: string;
  let ctx: ServerContext;
  let filesBefore: Set<string>;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gen-tool-"));
    for (const [relativePath, content] of Object.entries(FIXTURES)) {
      const absolute = path.join(projectRoot, "src", relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf-8");
    }
    ctx = {
      diagramStore: new DiagramStore(path.join(projectRoot, "diagrams")),
      codeRootDir: projectRoot,
    };
    filesBefore = new Set(await listAllFiles(projectRoot));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("generates a PlantUML diagram with entities and evidenced relations", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "src" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.scope, "src");
    assert.equal(structured.format, "puml");
    // Emission order is POSIX path order, then within-file order: base.ts
    // (Named, Base), service.py (Service, handle — the heuristic also picks up
    // `def` names), widget.ts (Widget).
    assert.deepEqual(structured.entities, ["Named", "Base", "Service", "handle", "Widget"]);
    assert.equal(structured.entities_included, 5);
    assert.equal(structured.entities_available, 5);
    assert.equal(structured.entities_capped, false);
    assert.equal(structured.entity_limit, 30);
    assert.deepEqual(structured.relations, [
      { from: "Widget", to: "Base", kind: "extends" },
      { from: "Widget", to: "Named", kind: "implements" },
    ]);
    assert.equal(structured.relations_included, 2);
    assert.equal(structured.relations_available, 2);
    assert.equal(structured.relations_capped, false);
    assert.equal(structured.relation_limit, 60);
    assert.equal(structured.files_scanned, 3);
    assert.equal(structured.truncated, false);
    assert.equal(structured.scan_limit, 5000);
    assert.equal(structured.scan_warning, null);
    assert.equal(structured.dialect_note, null);
    assert.equal(structured.confidence, "heuristic");
    assert.ok(structured.heuristic_warning.length > 0);
    assert.equal(structured.written, false);
  });

  it("defaults the scope to the whole project root as '.'", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, {});
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.scope, ".");
    assert.ok(structured.entities.includes("Widget"));
  });

  it("emits Mermaid that passes the same gate as diagrams_create", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "src", format: "mermaid" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.format, "mermaid");
    assert.ok(structured.source.startsWith("classDiagram\n"));
    assert.ok(structured.source.includes("class Widget"));
    assert.ok(structured.source.includes("Widget --|> Base"));
    validateDiagramSource(structured.source, "mermaid");
  });

  it("emits PlantUML that passes the same gate as diagrams_create", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "src", format: "puml" });
    const structured = structuredOf(result);

    validateDiagramSource(structured.source, "plantuml");
    assert.ok(structured.source.startsWith("@startuml\n"));
    assert.ok(structured.source.trimEnd().endsWith("@enduml"));
    // The text block is the primary payload: identical to structured source.
    assert.equal(result.content[0].text, structured.source);
  });

  it("reports the entity cap in-band when max_entities is exceeded", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "src", max_entities: 1 });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.entities, ["Named"]);
    assert.equal(structured.entities_included, 1);
    assert.equal(structured.entities_available, 5);
    assert.equal(structured.entities_capped, true);
    assert.equal(structured.entity_limit, 1);
    // Widget is past the cap, so its edges have an undeclared endpoint.
    assert.deepEqual(structured.relations, []);
    assert.equal(structured.relations_available, 2);
    assert.equal(structured.relations_capped, true);
    validateDiagramSource(structured.source, "plantuml");
  });

  it("clamps an oversized max_entities to the documented ceiling", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    // The schema bounds max_entities at 60, so a request at the ceiling is
    // the largest legal value; the applied cap must equal it exactly.
    const result = await callHandler(tool, { scope: "src", max_entities: 60 });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.entity_limit, 60);
    assert.equal(structured.entities_capped, false);
  });

  it("rejects max_entities outside the documented 1-60 range", () => {
    // Ranges are enforced by the schema, before the handler is reached: the
    // SDK's safeParse is what turns these into Invalid arguments errors.
    for (const bad of [0, 61, 100]) {
      const parsed = diagramsGenerateInputSchema.safeParse({
        scope: "src",
        max_entities: bad,
      });
      assert.equal(parsed.success, false, `max_entities=${bad} must be rejected`);
      assert.ok(
        !parsed.success && JSON.stringify(parsed.error.issues).includes("max_entities"),
        `max_entities=${bad} rejection must name the field`,
      );
    }
    // The bounds are the documented ones, inclusively.
    for (const good of [1, 30, 60]) {
      const parsed = diagramsGenerateInputSchema.safeParse({
        scope: "src",
        max_entities: good,
      });
      assert.equal(parsed.success, true, `max_entities=${good} must be accepted`);
    }
  });

  it("rejects unknown arguments under the strict schema", () => {
    const parsed = diagramsGenerateInputSchema.safeParse({
      scope: "src",
      output_dir: "diagrams",
    });
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && JSON.stringify(parsed.error.issues).includes("output_dir"),
      "the strict schema must name the unrecognized key",
    );
  });

  it("omits relations with a note when include_relations is false", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "src", include_relations: false });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.relations, []);
    assert.equal(structured.relations_available, 0);
    assert.equal(structured.relations_capped, false);
    assert.match(structured.dialect_note ?? "", /include_relations is false/);
    validateDiagramSource(structured.source, "plantuml");
  });

  it("keeps entities and a note, never throwing, when the compiler is missing", async () => {
    const tool = captureTool(
      (server, context) => registerDiagramsGenerate(server, context, NO_COMPILER),
      ctx,
    );
    const result = await callHandler(tool, { scope: "src", include_relations: true });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.ok(structured.entities.includes("Widget"));
    assert.deepEqual(structured.relations, []);
    assert.equal(structured.relations_available, 0);
    assert.match(
      structured.dialect_note ?? "",
      /relations unavailable: the TypeScript compiler is not installed; entities only/,
    );
    validateDiagramSource(structured.source, "plantuml");
  });

  it("refuses a scope outside the project root with the shared typed error", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "../outside" });

    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /^Error: Refused to resolve scope outside the project root: '\.\.\/outside'\./,
    );
  });

  it("reuses the exact scope resolver error class and message", async () => {
    // Same error Step 1 ships; no second implementation.
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

    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "../../etc/passwd" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Refused to resolve scope outside the project root/);
  });

  it("never writes a file under the project root or the diagrams root", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    for (const args of [
      { scope: "src" },
      { scope: "src", format: "mermaid" as const },
      { scope: "src", max_entities: 1 },
      { scope: "src", include_relations: false as const },
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

  it("reports an empty result with a note for a scope without code files", async () => {
    const tool = captureTool(registerDiagramsGenerate, ctx);
    const empty = await callHandler(tool, { scope: "nonexistent-dir" });
    const emptyStructured = structuredOf(empty);

    assert.equal(empty.isError, undefined);
    assert.deepEqual(emptyStructured.entities, []);
    assert.equal(emptyStructured.entities_included, 0);
    assert.equal(emptyStructured.entities_available, 0);
    assert.equal(emptyStructured.entities_capped, false);
    assert.equal(emptyStructured.files_scanned, 0);
    assert.match(emptyStructured.dialect_note ?? "", /no code files found in the scanned scope/);
    validateDiagramSource(emptyStructured.source, "plantuml");
  });

  it("reports the scan cap in-band when the file limit is reached", async () => {
    // Same trip wire as the consistency checker's truncation test: enough
    // files to cross MAX_SCAN_FILES. Every file declares the same name, so
    // the entity list stays bounded while files_scanned hits the cap.
    const bulkDir = path.join(projectRoot, "bulk");
    await fs.mkdir(bulkDir, { recursive: true });
    for (let index = 0; index < 5005; index += 1) {
      await fs.writeFile(path.join(bulkDir, `file${index}.js`), "export class Widget {}\n");
    }

    const tool = captureTool(registerDiagramsGenerate, ctx);
    const result = await callHandler(tool, { scope: "bulk" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.truncated, true);
    assert.equal(structured.scan_limit, 5000);
    assert.ok(
      structured.files_scanned <= structured.scan_limit,
      `files_scanned ${structured.files_scanned} must not exceed the cap`,
    );
    // The warning is the generate-specific wording, not the checker's.
    assert.match(structured.scan_warning ?? "", /generated entities may be incomplete/i);
    assert.deepEqual(structured.entities, ["Widget"]);
    validateDiagramSource(structured.source, "plantuml");
  });
});

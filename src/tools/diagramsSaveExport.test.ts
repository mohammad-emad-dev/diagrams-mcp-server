import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import type { RendererDeps } from "../services/renderer.js";
import { buildSizedExportBundle } from "../services/export/htmlBundle.js";
import { MAX_EXPORT_HTML_BYTES, MAX_LOCAL_IMAGE_BYTES } from "../constants.js";
import { diagramsSaveExportInputSchema, registerDiagramsSaveExport } from "./diagramsSaveExport.js";
import { isExpectedToolError } from "./toolError.js";
import { UnsupportedHtmlExportExtensionError } from "../services/diagramStore.js";

const PUML_PATH = "models/order.puml";
const PUML_SOURCE = "@startuml\ntitle Order\nclass Order\n@enduml\n";
const MERMAID_PATH = "models/order.mmd";
const MERMAID_SOURCE = "classDiagram\nclass Order\n";
const OUTPUT_PATH = "exports/order.html";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="16" ' +
  'viewBox="0 0 40 16"><rect width="40" height="16" fill="#f5f5f5"/></svg>';

const DISABLE_FLAG = "DISABLE_REMOTE_PLANTUML";
const ALLOW_FLAG = "ALLOW_REMOTE_PLANTUML";

interface CapturedToolResult {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

function captureTool(ctx: ServerContext): { handler: CapturedToolHandler } {
  const captured = {} as { handler: CapturedToolHandler };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.handler = handler;
    },
  } as unknown as McpServer;
  registerDiagramsSaveExport(fakeServer, ctx);
  return captured;
}

async function callHandler(
  tool: { handler: CapturedToolHandler },
  args: Record<string, unknown>,
): Promise<CapturedToolResult> {
  const parsed = diagramsSaveExportInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface SaveExportOutput {
  relative_path: string;
  output_path: string;
  diagram_type: "plantuml" | "mermaid";
  format: string;
  bytes: number;
  svg_chars: number;
  source_included: boolean;
  truncated: boolean;
  rendered_with: string;
}

function structuredOf(result: CapturedToolResult): SaveExportOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as SaveExportOutput;
}

function localPlantUmlDeps(image: string): RendererDeps {
  return {
    commandExists: (cmd) => Promise.resolve(cmd === "plantuml"),
    runCommand: async (_cmd, args) => {
      const inputPath = args[args.length - 1];
      await fs.writeFile(path.join(path.dirname(inputPath), "input.svg"), image);
      return { stdout: "", stderr: "" };
    },
  };
}

function localMermaidDeps(image: string): RendererDeps {
  return {
    commandExists: (cmd) => Promise.resolve(cmd === "mmdc"),
    runCommand: async (_cmd, args) => {
      const outIndex = args.indexOf("-o");
      await fs.writeFile(args[outIndex + 1], image);
      return { stdout: "", stderr: "" };
    },
  };
}

function offlineDeps(fetchRemote?: RendererDeps["fetchRemote"]): RendererDeps {
  return {
    commandExists: () => Promise.resolve(false),
    runCommand: () => Promise.reject(new Error("command should not run")),
    fetchRemote: fetchRemote ?? (() => Promise.reject(new Error("network access attempted"))),
  };
}

describe("diagrams_save_export", () => {
  let projectRoot: string;
  let diagramsRoot: string;
  let ctx: ServerContext;
  let savedDisable: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "save-export-tool-"));
    diagramsRoot = path.join(projectRoot, "diagrams");
    ctx = {
      diagramStore: new DiagramStore(diagramsRoot),
      codeRootDir: projectRoot,
      rendererDeps: localPlantUmlDeps(SVG),
    };
    savedDisable = process.env[DISABLE_FLAG];
    savedAllow = process.env[ALLOW_FLAG];
    process.env[DISABLE_FLAG] = "true";
    delete process.env[ALLOW_FLAG];
  });

  afterEach(async () => {
    if (savedDisable === undefined) delete process.env[DISABLE_FLAG];
    else process.env[DISABLE_FLAG] = savedDisable;
    if (savedAllow === undefined) delete process.env[ALLOW_FLAG];
    else process.env[ALLOW_FLAG] = savedAllow;
    assert.equal(path.dirname(path.resolve(projectRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(projectRoot).startsWith("save-export-tool-"));
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("registers as a writing, non-idempotent, open-world tool", () => {
    const captured = {} as {
      name: string;
      config: {
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
          openWorldHint?: boolean;
        };
      };
    };
    const fakeServer = {
      registerTool: (name: string, config: unknown): void => {
        captured.name = name;
        captured.config = config as (typeof captured)["config"];
      },
    } as unknown as McpServer;
    registerDiagramsSaveExport(fakeServer, ctx);

    assert.equal(captured.name, "diagrams_save_export");
    assert.equal(captured.config.annotations?.readOnlyHint, false);
    assert.equal(captured.config.annotations?.destructiveHint, false);
    assert.equal(captured.config.annotations?.idempotentHint, false);
    assert.equal(captured.config.annotations?.openWorldHint, true);
  });

  it("classifies the HTML-extension error as expected", () => {
    assert.equal(
      isExpectedToolError(new UnsupportedHtmlExportExtensionError("exports/a.txt")),
      true,
    );
  });

  it("saves exact on-disk HTML for a PlantUML diagram", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: OUTPUT_PATH,
    });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.relative_path, PUML_PATH);
    assert.equal(structured.output_path, OUTPUT_PATH);
    assert.equal(structured.diagram_type, "plantuml");
    assert.equal(structured.format, "html");
    assert.equal(structured.source_included, true);
    assert.equal(structured.truncated, false);
    assert.equal(structured.rendered_with, "local-plantuml");

    const expected = buildSizedExportBundle({
      relativePath: PUML_PATH,
      diagramType: "plantuml",
      svg: SVG,
      source: PUML_SOURCE,
      renderedWith: "local-plantuml",
    });
    assert.equal(structured.bytes, expected.byteLength);
    assert.equal(structured.svg_chars, expected.svgChars);
    assert.equal(structured.bytes, Buffer.byteLength(expected.html, "utf-8"));

    const onDisk = await fs.readFile(path.join(diagramsRoot, OUTPUT_PATH), "utf-8");
    assert.equal(onDisk, expected.html);

    // The save response is a small acknowledgement, never the artifact.
    const text = result.content[0].text;
    assert.ok(text.includes(PUML_PATH));
    assert.ok(text.includes(OUTPUT_PATH));
    assert.ok(!text.includes(expected.html.slice(0, 200)));
    assert.ok(!text.includes(Buffer.from(SVG, "utf-8").toString("base64")));
    assert.equal(result.structuredContent?.html, undefined);
  });

  it("saves nested HTML and normalizes backslash output paths to POSIX", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: "exports\\nested\\order.html",
    });

    assert.equal(result.isError, undefined);
    assert.equal(structuredOf(result).output_path, "exports/nested/order.html");
    assert.equal(
      await fs.readFile(path.join(diagramsRoot, "exports", "nested", "order.html"), "utf-8"),
      buildSizedExportBundle({
        relativePath: PUML_PATH,
        diagramType: "plantuml",
        svg: SVG,
        source: PUML_SOURCE,
        renderedWith: "local-plantuml",
      }).html,
    );
  });

  it("omits the source block when include_source is false", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: OUTPUT_PATH,
      include_source: false,
    });
    const structured = structuredOf(result);

    assert.equal(structured.source_included, false);
    const onDisk = await fs.readFile(path.join(diagramsRoot, OUTPUT_PATH), "utf-8");
    assert.ok(!onDisk.includes("<details"));
    assert.ok(!onDisk.includes(PUML_SOURCE.trimEnd()));
    assert.ok(onDisk.includes(Buffer.from(SVG, "utf-8").toString("base64")));

    const expected = buildSizedExportBundle({
      relativePath: PUML_PATH,
      diagramType: "plantuml",
      svg: SVG,
      source: null,
      renderedWith: "local-plantuml",
    });
    assert.equal(onDisk, expected.html);
    assert.equal(structured.bytes, expected.byteLength);
  });

  it("saves a Mermaid diagram and reports the mmdc provenance", async () => {
    ctx.rendererDeps = localMermaidDeps(SVG);
    await ctx.diagramStore.write(MERMAID_PATH, MERMAID_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: MERMAID_PATH,
      output_path: "exports/mermaid.html",
    });

    assert.equal(result.isError, undefined);
    assert.equal(structuredOf(result).diagram_type, "mermaid");
    assert.equal(structuredOf(result).rendered_with, "mmdc");
    assert.ok(
      (await fs.readFile(path.join(diagramsRoot, "exports", "mermaid.html"), "utf-8")).includes(
        "Mermaid diagram exported",
      ),
    );
  });

  it("refuses to overwrite an existing export", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    await ctx.diagramStore.writeHtmlExport(OUTPUT_PATH, "<html>original</html>");
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: OUTPUT_PATH,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already exists/);
    assert.doesNotMatch(result.content[0].text, /diagrams_update|overwrite=true/);
    assert.equal(
      await fs.readFile(path.join(diagramsRoot, OUTPUT_PATH), "utf-8"),
      "<html>original</html>",
    );
  });

  it("rejects a non-html output path without creating directories", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: "exports/notes.txt",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /\.html/);
    await assert.rejects(fs.access(path.join(diagramsRoot, "exports")), { code: "ENOENT" });
  });

  it("rejects traversal output paths without writing outside", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: "../escape.html",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside the diagrams root/);
    await assert.rejects(fs.access(path.join(projectRoot, "escape.html")), { code: "ENOENT" });
  });

  it("refuses an over-cap bundle with zero writes", async () => {
    // Base64 expansion must exceed the HTML ceiling without hitting the image cap first.
    const payloadBytes = Math.floor((MAX_EXPORT_HTML_BYTES * 3) / 4);
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${"A".repeat(payloadBytes)}</svg>`;
    assert.ok(Buffer.byteLength(huge) <= MAX_LOCAL_IMAGE_BYTES);
    ctx.rendererDeps = localPlantUmlDeps(huge);
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: PUML_PATH,
      output_path: "cap/nested/huge.html",
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const text = result.content[0].text;
    assert.ok(text.startsWith("Error: "));
    assert.ok(text.includes(`${MAX_EXPORT_HTML_BYTES}-byte limit`));
    assert.ok(text.includes(PUML_PATH));
    assert.ok(!text.includes("@startuml"));
    assert.ok(!text.includes(projectRoot));
    await assert.rejects(fs.access(path.join(diagramsRoot, "cap")), { code: "ENOENT" });
  });

  it("writes nothing when the diagram is missing", async () => {
    ctx.rendererDeps = offlineDeps();
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: "models/ghost.puml",
      output_path: OUTPUT_PATH,
    });

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Error: No diagram found at 'models/ghost.puml'.");
    await assert.rejects(fs.access(path.join(diagramsRoot, OUTPUT_PATH)), { code: "ENOENT" });
  });

  it("writes nothing when rendering fails", async () => {
    ctx.rendererDeps = offlineDeps();
    await ctx.diagramStore.write(MERMAID_PATH, MERMAID_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, {
      relative_path: MERMAID_PATH,
      output_path: OUTPUT_PATH,
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("Mermaid rendering requires the 'mmdc' CLI"));
    await assert.rejects(fs.access(path.join(diagramsRoot, OUTPUT_PATH)), { code: "ENOENT" });
  });

  it("rejects unknown arguments under the strict schema", () => {
    const parsed = diagramsSaveExportInputSchema.safeParse({
      relative_path: PUML_PATH,
      output_path: OUTPUT_PATH,
      overwrite: true,
    });
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && JSON.stringify(parsed.error.issues).includes("overwrite"),
      "no overwrite option exists; existing targets are always refused",
    );
  });

  it("requires output_path and applies the include_source default", () => {
    const missing = diagramsSaveExportInputSchema.safeParse({ relative_path: PUML_PATH });
    assert.equal(missing.success, false);

    const empty = diagramsSaveExportInputSchema.safeParse({
      relative_path: PUML_PATH,
      output_path: "",
    });
    assert.equal(empty.success, false);

    const parsed = diagramsSaveExportInputSchema.safeParse({
      relative_path: PUML_PATH,
      output_path: OUTPUT_PATH,
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.include_source, true);
    }
  });
});

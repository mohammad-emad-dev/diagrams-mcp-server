import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import type { RendererDeps } from "../services/renderer.js";
import { buildExportBundle } from "../services/export/htmlBundle.js";
import { MAX_EXPORT_HTML_BYTES } from "../constants.js";
import { diagramsExportInputSchema, registerDiagramsExport } from "./diagramsExport.js";

const PUML_PATH = "models/order.puml";
const PUML_SOURCE = "@startuml\ntitle Order\nclass Order\n@enduml\n";
const MERMAID_PATH = "models/order.mmd";
const MERMAID_SOURCE = "classDiagram\nclass Order\n";

// Small, but a realistic renderer shape: a namespaced root element with a shape.
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
  registerDiagramsExport(fakeServer, ctx);
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
  const parsed = diagramsExportInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface ExportOutput {
  relative_path: string;
  diagram_type: "plantuml" | "mermaid";
  format: string;
  bytes: number;
  svg_chars: number;
  source_included: boolean;
  truncated: boolean;
  rendered_with: string;
}

/** Typed view of a successful result's structuredContent. */
function structuredOf(result: CapturedToolResult): ExportOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as ExportOutput;
}

/** Local `plantuml` stub: writes `image` to the file the renderer reads back. */
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

/** Local `mmdc` stub: writes `image` to the path after -o. */
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

/** No CLIs; remote uses the given stub, never the network. */
function offlineDeps(fetchRemote?: RendererDeps["fetchRemote"]): RendererDeps {
  return {
    commandExists: () => Promise.resolve(false),
    runCommand: () => Promise.reject(new Error("command should not run")),
    fetchRemote: fetchRemote ?? (() => Promise.reject(new Error("network access attempted"))),
  };
}

/** True when `html` is free of anything a browser would fetch. */
function hasNoExternalResources(html: string): boolean {
  return (
    !/src\s*=/i.test(html) &&
    !/href\s*=/i.test(html) &&
    !/@import/i.test(html) &&
    !/<script[\s>]/i.test(html) &&
    !/url\(/i.test(html)
  );
}

// The SVG namespace is an XML identifier, not a resource: nothing resolves it.
// It is the one URL-shaped string a renderer always emits, so it is carved out
// before the absolute-path checks rather than silently tolerated by them.
function withoutNamespaces(html: string): string {
  return html.replace(/xmlns(?::\w+)?="[^"]*"/g, "");
}

describe("diagrams_export", () => {
  let projectRoot: string;
  let ctx: ServerContext;
  let savedDisable: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "export-tool-"));
    ctx = {
      diagramStore: new DiagramStore(path.join(projectRoot, "diagrams")),
      codeRootDir: projectRoot,
      // CI runs with no global renderer, so the tool is covered through stubs.
      rendererDeps: localPlantUmlDeps(SVG),
    };
    savedDisable = process.env[DISABLE_FLAG];
    savedAllow = process.env[ALLOW_FLAG];
    // The CI environment sets this; local-first here too, so a stubbed local
    // render is the only path the tests ever exercise.
    process.env[DISABLE_FLAG] = "true";
    delete process.env[ALLOW_FLAG];
  });

  afterEach(async () => {
    if (savedDisable === undefined) delete process.env[DISABLE_FLAG];
    else process.env[DISABLE_FLAG] = savedDisable;
    if (savedAllow === undefined) delete process.env[ALLOW_FLAG];
    else process.env[ALLOW_FLAG] = savedAllow;
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("registers read-only, non-destructive, idempotent, and open-world", () => {
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
    registerDiagramsExport(fakeServer, ctx);

    assert.equal(captured.name, "diagrams_export");
    // Same four annotations as diagrams_render: it reads and renders, writes
    // nothing, is stable for a fixed input, but may reach a CLI or the opt-in
    // remote fallback.
    assert.equal(captured.config.annotations?.readOnlyHint, true);
    assert.equal(captured.config.annotations?.destructiveHint, false);
    assert.equal(captured.config.annotations?.idempotentHint, true);
    assert.equal(captured.config.annotations?.openWorldHint, true);
  });

  it("bundles a PlantUML diagram with a local render into self-contained HTML", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });
    const structured = structuredOf(result);
    const html = result.content[0].text;

    assert.equal(result.isError, undefined);
    assert.equal(structured.relative_path, PUML_PATH);
    assert.equal(structured.diagram_type, "plantuml");
    assert.equal(structured.format, "html");
    assert.equal(structured.bytes, Buffer.byteLength(html, "utf-8"));
    assert.equal(structured.svg_chars, SVG.length);
    assert.equal(structured.source_included, true);
    assert.equal(structured.truncated, false);
    assert.equal(structured.rendered_with, "local-plantuml");

    // The text block is the artifact itself, byte for byte.
    assert.equal(html, html.trimEnd() + "\n");
    assert.ok(html.startsWith("<!DOCTYPE html>\n"), "the bundle is one HTML document");
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.ok(html.includes(`<title>${PUML_PATH}</title>`));
    assert.ok(html.includes(SVG), "the SVG is inlined as markup");
    assert.ok(
      html.includes("<pre><code>") && html.includes(PUML_SOURCE.trimEnd()),
      "the source block is embedded",
    );
  });

  it("bundles a Mermaid diagram and reports the mmdc provenance", async () => {
    ctx.rendererDeps = localMermaidDeps(SVG);
    await ctx.diagramStore.write(MERMAID_PATH, MERMAID_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: MERMAID_PATH });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.diagram_type, "mermaid");
    assert.equal(structured.rendered_with, "mmdc");
    assert.equal(structured.source_included, true);
    assert.ok(result.content[0].text.includes("Mermaid diagram exported"));
  });

  it("fetches, imports, and references nothing external", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });
    const html = result.content[0].text;

    assert.ok(
      hasNoExternalResources(html),
      "the bundle must carry no src=/href=/@import/<script>/url() a browser would fetch",
    );
    assert.ok(
      !/https?:\/\//i.test(withoutNamespaces(html)),
      "no URL may remain once the SVG namespace identifier is set aside",
    );
  });

  it("carries no absolute path anywhere in the bundle", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });
    const html = result.content[0].text;

    // The POSIX relative path is the only path; the tmp roots the diagram was
    // read from must not leak into the artifact.
    assert.ok(!html.includes(projectRoot), "the project root must not appear");
    assert.ok(!html.includes(ctx.diagramStore.getRoot()), "the diagrams root must not appear");
    assert.ok(!html.includes("\\"), "Windows separators must not appear");
    assert.ok(
      !/[A-Za-z]:[\\/]/.test(withoutNamespaces(html)),
      "no drive-letter or POSIX absolute path may appear",
    );
  });

  it("embeds the source by default and omits the block when asked", async () => {
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);

    // include_source is optional and defaults to true.
    const withDefault = await callHandler(tool, { relative_path: PUML_PATH });
    assert.equal(structuredOf(withDefault).source_included, true);
    assert.ok(withDefault.content[0].text.includes('<details class="source">'));

    const without = await callHandler(tool, { relative_path: PUML_PATH, include_source: false });
    const structured = structuredOf(without);
    assert.equal(structured.source_included, false);
    const html = without.content[0].text;
    assert.ok(!html.includes("<details"), "no source disclosure when disabled");
    assert.ok(!html.includes(PUML_SOURCE.trimEnd()), "no diagram source in the body");
    assert.ok(html.includes(SVG), "the SVG is still inlined");
  });

  it("escapes source markup so it cannot break out of the block", async () => {
    const tricky = "@startuml\nclass A\nA --> B : a > b & c < d\n@enduml\n";
    await ctx.diagramStore.write(PUML_PATH, tricky, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });
    const html = result.content[0].text;

    assert.ok(html.includes("a &gt; b &amp; c &lt; d"), "markup characters must be escaped");
    assert.ok(!html.includes("a > b & c < d"), "raw markup must not survive");
  });

  it("refuses an over-cap bundle rather than returning a cut file", async () => {
    // One byte past the whole-document ceiling: the wrapper itself is what
    // pushes it over, so this is the smallest honest over-cap input.
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${"A".repeat(MAX_EXPORT_HTML_BYTES)}</svg>`;
    ctx.rendererDeps = localPlantUmlDeps(huge);
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined, "no partial result may be reported");
    const text = result.content[0].text;
    assert.ok(text.startsWith("Error: "), "an over-cap result is an error, not a warning");
    assert.ok(
      text.includes(`${MAX_EXPORT_HTML_BYTES}-byte limit`),
      "the message must state the ceiling",
    );
    assert.ok(text.includes(PUML_PATH), "the message must name the diagram");
    assert.ok(
      !text.includes("@startuml") && !text.includes("class Order"),
      "the message must never carry diagram source",
    );
    assert.ok(!text.includes(projectRoot), "the message must carry no absolute path");
  });

  it("reports a missing diagram before any render attempt", async () => {
    // Offline deps: a render attempt would fail with a renderer error, so
    // reaching the not-found message proves the render step never ran.
    ctx.rendererDeps = offlineDeps();
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: "models/ghost.puml" });

    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "Error: No diagram found at 'models/ghost.puml'.",
      "the read step fails with the existing not-found message",
    );
  });

  it("surfaces the existing missing-mmdc message for Mermaid", async () => {
    ctx.rendererDeps = offlineDeps();
    await ctx.diagramStore.write(MERMAID_PATH, MERMAID_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: MERMAID_PATH });

    assert.equal(result.isError, true);
    assert.ok(
      result.content[0].text.includes("Mermaid rendering requires the 'mmdc' CLI"),
      "the wording is the renderer's, not a new one",
    );
    assert.ok(!result.content[0].text.includes("classDiagram"), "no source in the error");
  });

  it("surfaces the existing disabled-remote message for PlantUML", async () => {
    ctx.rendererDeps = offlineDeps();
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });

    assert.equal(result.isError, true);
    assert.ok(
      result.content[0].text.includes("remote rendering is disabled by default"),
      "the wording is the renderer's, not a new one",
    );
    assert.ok(
      result.content[0].text.includes("ALLOW_REMOTE_PLANTUML=true"),
      "the opt-in must be named so the failure is actionable",
    );
  });

  it("surfaces the existing remote non-2xx message", async () => {
    process.env[DISABLE_FLAG] = undefined;
    process.env[ALLOW_FLAG] = "true";
    ctx.rendererDeps = offlineDeps(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });

    assert.equal(result.isError, true);
    assert.ok(
      result.content[0].text.includes("PlantUML rendering server responded with 503"),
      "the wording is the renderer's, not a new one",
    );
  });

  it("takes no network path when a local plantuml CLI is available", async () => {
    // CI's environment: remote hard-disabled, local CLI present.
    process.env[DISABLE_FLAG] = "true";
    let networkAttempted = false;
    ctx.rendererDeps = {
      commandExists: (cmd) => Promise.resolve(cmd === "plantuml"),
      runCommand: async (_cmd, args) => {
        const inputPath = args[args.length - 1];
        await fs.writeFile(path.join(path.dirname(inputPath), "input.svg"), SVG);
        return { stdout: "", stderr: "" };
      },
      fetchRemote: () => {
        networkAttempted = true;
        return Promise.reject(new Error("network access attempted"));
      },
    };
    await ctx.diagramStore.write(PUML_PATH, PUML_SOURCE, { overwrite: false });
    const tool = captureTool(ctx);
    const result = await callHandler(tool, { relative_path: PUML_PATH });

    assert.equal(result.isError, undefined);
    assert.equal(structuredOf(result).rendered_with, "local-plantuml");
    assert.equal(networkAttempted, false, "no remote request may be made");
  });

  it("strips an XML preamble and DOCTYPE from renderer SVG", () => {
    const prolog =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      SVG;
    const { html, svgChars } = buildExportBundle({
      relativePath: PUML_PATH,
      diagramType: "plantuml",
      svg: prolog,
      source: null,
      renderedWith: "local-plantuml",
    });

    assert.ok(!html.includes("<?xml"), "an XML declaration is invalid inside HTML");
    assert.ok(!html.includes("<!DOCTYPE svg"), "a mid-document DOCTYPE is dropped");
    assert.equal(svgChars, SVG.length, "the count measures what was actually inlined");
  });

  it("rejects unknown arguments under the strict schema", () => {
    const parsed = diagramsExportInputSchema.safeParse({
      relative_path: PUML_PATH,
      output_format: "html",
    });
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && JSON.stringify(parsed.error.issues).includes("output_format"),
      "the strict schema must name the unrecognized key",
    );
  });
});

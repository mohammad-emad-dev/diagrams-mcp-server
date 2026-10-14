import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { MAX_TEMPLATE_SCAN_ENTRIES } from "../constants.js";
import { TEMPLATE_KINDS } from "../services/templates/skeletons.js";
import {
  diagramsListTemplatesInputSchema,
  registerDiagramsListTemplates,
} from "./diagramsListTemplates.js";
import { registerDiagramsTemplate } from "./diagramsTemplate.js";

// The tool is read-only: this snapshot proves no file
// appears under the project root (or the diagrams root) as a result of a call.
async function listAllFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  const entries: Dirent[] = await fs.readdir(dir, { withFileTypes: true });
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

function captureListTemplates(ctx: ServerContext): {
  name: string;
  config: {
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
  handler: CapturedToolHandler;
} {
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
    handler: CapturedToolHandler;
  };
  const fakeServer = {
    registerTool: (name: string, config: unknown, handler: CapturedToolHandler): void => {
      captured.name = name;
      captured.config = config as (typeof captured)["config"];
      captured.handler = handler;
    },
  } as unknown as McpServer;
  registerDiagramsListTemplates(fakeServer, ctx);
  return captured;
}

/**
 * Call the captured handler the way the server does: the SDK runs safeParse
 * on the input schema first.
 */
async function callHandler(
  tool: { handler: CapturedToolHandler },
  args: Record<string, unknown>,
): Promise<CapturedToolResult> {
  const parsed = diagramsListTemplatesInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface DiscoveryOutput {
  built_in: Array<{ template: string; formats: string[] }>;
  custom: Array<{ template: string; custom_template: string; relative_path: string }>;
  custom_count: number;
  entries_scanned: number;
  scan_limit: number;
  truncated: boolean;
  scan_warning: string | null;
  written: boolean;
}

/** Typed view of a successful result's structuredContent. */
function structuredOf(result: CapturedToolResult): DiscoveryOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as DiscoveryOutput;
}

describe("diagrams_list_templates", () => {
  let projectRoot: string;
  let ctx: ServerContext;
  let filesBefore: Set<string>;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "list-templates-tool-"));
    ctx = {
      diagramStore: new DiagramStore(path.join(projectRoot, "diagrams")),
      codeRootDir: projectRoot,
    };
    filesBefore = new Set(await listAllFiles(projectRoot));
  });

  afterEach(async () => {
    assert.equal(path.dirname(projectRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(projectRoot).startsWith("list-templates-tool-"));
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("rejects unknown arguments under the strict schema", () => {
    const parsed = diagramsListTemplatesInputSchema.safeParse({ output_dir: "diagrams" });
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && JSON.stringify(parsed.error.issues).includes("output_dir"),
      "the strict schema must name the unrecognized key",
    );
  });

  it("registers read-only, non-destructive, idempotent, and closed-world", () => {
    const tool = captureListTemplates(ctx);
    assert.equal(tool.name, "diagrams_list_templates");
    assert.equal(tool.config.annotations?.readOnlyHint, true);
    assert.equal(tool.config.annotations?.destructiveHint, false);
    assert.equal(tool.config.annotations?.idempotentHint, true);
    assert.equal(tool.config.annotations?.openWorldHint, false);
  });

  it("discovers built-ins and custom candidates without writing files", async () => {
    const directory = path.join(projectRoot, ".diagrams-templates");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "alpha.json"),
      JSON.stringify({ puml: { source: "s", entity: "e" } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(directory, "beta.json"),
      JSON.stringify({ puml: { source: "s", entity: "e" } }),
      "utf-8",
    );
    await fs.writeFile(path.join(directory, "notes.txt"), "not a template", "utf-8");
    await fs.writeFile(path.join(directory, "bad name.json"), "{}", "utf-8");
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "nested", "inner.json"), "{}", "utf-8");

    const before = await listAllFiles(projectRoot);
    const tool = captureListTemplates(ctx);
    const result = await callHandler(tool, {});
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    // Built-ins come from TEMPLATE_KINDS, in documented order, each with both dialects.
    assert.deepEqual(
      structured.built_in,
      [...TEMPLATE_KINDS].map((template) => ({ template, formats: ["puml", "mermaid"] })),
    );
    // Only the two valid top-level .json identifiers survive, sorted.
    assert.deepEqual(
      structured.custom.map((entry) => entry.custom_template),
      ["alpha", "beta"],
    );
    for (const entry of structured.custom) {
      assert.equal(entry.template, "custom");
      assert.equal(entry.relative_path, `.diagrams-templates/${entry.custom_template}.json`);
      assert.ok(!entry.relative_path.includes("\\"), "relative paths must be POSIX");
    }
    assert.equal(structured.custom_count, 2);
    assert.equal(structured.entries_scanned, 5);
    assert.equal(structured.scan_limit, MAX_TEMPLATE_SCAN_ENTRIES);
    assert.equal(structured.truncated, false);
    assert.equal(structured.scan_warning, null);
    assert.equal(structured.written, false);
    // Text summarizes the same names; warning state matches structuredContent.
    assert.ok(result.content[0].text.includes("class"));
    assert.ok(result.content[0].text.includes("alpha"));
    assert.ok(result.content[0].text.includes("beta"));
    assert.ok(result.content[0].text.includes("no truncation"));
    // Read-only: nothing was created, removed, or changed.
    assert.deepEqual(await listAllFiles(projectRoot), before);
    const filesAfter = new Set(await listAllFiles(projectRoot));
    assert.deepEqual([...filesAfter].sort(), [...new Set(before)].sort());
    assert.deepEqual(filesBefore, new Set([]));
  });

  it("returns builtin-only discovery when the template directory is missing", async () => {
    const tool = captureListTemplates(ctx);
    const before = await listAllFiles(projectRoot);
    const result = await callHandler(tool, {});
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.built_in.length, 3);
    assert.deepEqual(structured.custom, []);
    assert.equal(structured.custom_count, 0);
    assert.equal(structured.entries_scanned, 0);
    assert.equal(structured.scan_limit, MAX_TEMPLATE_SCAN_ENTRIES);
    assert.equal(structured.truncated, false);
    assert.equal(structured.scan_warning, null);
    assert.equal(structured.written, false);
    assert.ok(result.content[0].text.includes("none found"));
    assert.deepEqual(await listAllFiles(projectRoot), before);
  });

  it("lists candidate names usable in diagrams_template", async () => {
    const directory = path.join(projectRoot, ".diagrams-templates");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "team-model.json"),
      JSON.stringify({
        puml: {
          source: "@startuml\ntitle {{title}}\n{{entities}}\n@enduml\n",
          entity: "class {{name}}",
        },
      }),
      "utf-8",
    );
    const tool = captureListTemplates(ctx);
    const result = await callHandler(tool, {});
    const structured = structuredOf(result);
    assert.deepEqual(
      structured.custom.map((entry) => entry.custom_template),
      ["team-model"],
    );
    assert.equal(structured.custom[0].relative_path, ".diagrams-templates/team-model.json");

    // The candidate round-trips through the template tool: definition, dialect,
    // and syntax are validated there, not during discovery.
    const captured = {} as { handler: CapturedToolHandler };
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
        captured.handler = handler;
      },
    } as unknown as McpServer;
    registerDiagramsTemplate(fakeServer, ctx);
    const { diagramsTemplateInputSchema } = await import("./diagramsTemplate.js");
    const parsed = diagramsTemplateInputSchema.safeParse({
      template: "custom",
      custom_template: structured.custom[0].custom_template,
      entities: ["Widget"],
    });
    assert.equal(parsed.success, true);
    const templated = await captured.handler(parsed.data);
    assert.equal(templated.isError, undefined);
    assert.ok(String(templated.content[0].text).includes("class Widget"));
  });

  it("reports bounded scan metadata when the entry cap is reached", async () => {
    const directory = path.join(projectRoot, ".diagrams-templates");
    await fs.mkdir(directory);
    const total = MAX_TEMPLATE_SCAN_ENTRIES + 1;
    for (let index = 0; index < total; index += 1) {
      const name = `t${String(index).padStart(4, "0")}.json`;
      await fs.writeFile(path.join(directory, name), "{}", "utf-8");
    }

    const tool = captureListTemplates(ctx);
    const result = await callHandler(tool, {});
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.truncated, true);
    assert.equal(structured.entries_scanned, MAX_TEMPLATE_SCAN_ENTRIES);
    assert.equal(structured.scan_limit, MAX_TEMPLATE_SCAN_ENTRIES);
    assert.equal(structured.custom_count, MAX_TEMPLATE_SCAN_ENTRIES);
    assert.ok(
      typeof structured.scan_warning === "string" && structured.scan_warning.length > 0,
      "a capped scan must carry a warning",
    );
    assert.match(String(structured.scan_warning), /1,?000/);
    assert.match(String(structured.scan_warning).toLowerCase(), /incomplete/);
    // The warning in text matches the structured warning consistently.
    assert.ok(result.content[0].text.includes(String(structured.scan_warning)));
    // Sorted within the capped subset; every path stays relative POSIX.
    const names = structured.custom.map((entry) => entry.custom_template);
    assert.deepEqual([...names].sort(), names);
    for (const entry of structured.custom) {
      assert.ok(!entry.relative_path.includes("\\"));
      assert.ok(entry.relative_path.startsWith(".diagrams-templates/"));
    }
    assert.equal(structured.written, false);
  });

  it("never writes a file under the project root", async () => {
    const tool = captureListTemplates(ctx);
    await callHandler(tool, {});
    const filesAfter = new Set(await listAllFiles(projectRoot));
    assert.deepEqual([...filesAfter].sort(), [...filesBefore].sort());
  });
});

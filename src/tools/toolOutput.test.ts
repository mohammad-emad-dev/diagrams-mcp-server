import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { registerDiagramsList } from "./diagramsList.js";
import { registerDiagramsGet } from "./diagramsGet.js";
import { registerDiagramsCreate } from "./diagramsCreate.js";
import { registerDiagramsUpdate } from "./diagramsUpdate.js";
import { registerDiagramsDelete } from "./diagramsDelete.js";
import { registerDiagramsCheckConsistency } from "./diagramsCheckConsistency.js";

interface CapturedTextContent {
  type: string;
  text: string;
}

interface CapturedToolResult {
  content: CapturedTextContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

function captureTool(
  register: (server: McpServer, ctx: ServerContext) => void,
  ctx: ServerContext,
): { name: string; handler: CapturedToolHandler } {
  const captured = {} as { name: string; handler: CapturedToolHandler };
  const fakeServer = {
    registerTool: (name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.name = name;
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx);
  return captured;
}

describe("MCP user-facing relative paths use POSIX separators", () => {
  let tmpRoot: string;
  let ctx: ServerContext;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-posix-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("diagrams_list returns POSIX relative_path for nested diagrams", async () => {
    await ctx.diagramStore.write("models/nested/widget.puml", "@startuml\nclass Widget\n@enduml", {
      overwrite: false,
    });

    const tool = captureTool(registerDiagramsList, ctx);
    const result = await tool.handler({ type_filter: "all" });

    assert.equal(result.structuredContent.count, 1);
    const diagrams = result.structuredContent.diagrams as Array<{ relative_path: string }>;
    const relativePath = diagrams[0].relative_path;
    assert.equal(relativePath, "models/nested/widget.puml");
    assert.ok(!relativePath.includes("\\"));
    assert.ok(result.content[0].text.includes("models/nested/widget.puml"));
  });

  it("mutating tools echo backslash input as POSIX in outputs", async () => {
    const create = captureTool(registerDiagramsCreate, ctx);
    const created = await create.handler({
      relative_path: "models\\echo.puml",
      content: "@startuml\nclass Echo\n@enduml",
    });
    assert.equal(created.structuredContent.relative_path, "models/echo.puml");
    assert.ok(created.content[0].text.includes("models/echo.puml"));

    const get = captureTool(registerDiagramsGet, ctx);
    const gotten = await get.handler({ relative_path: "models\\echo.puml" });
    assert.equal(gotten.structuredContent.relative_path, "models/echo.puml");

    const update = captureTool(registerDiagramsUpdate, ctx);
    const updated = await update.handler({
      relative_path: "models\\echo.puml",
      content: "@startuml\nclass Echo2\n@enduml",
    });
    assert.equal(updated.structuredContent.relative_path, "models/echo.puml");

    const check = captureTool(registerDiagramsCheckConsistency, ctx);
    const checked = await check.handler({ relative_path: "models\\echo.puml" });
    assert.equal(checked.structuredContent.diagram_path, "models/echo.puml");
    assert.ok(!String(checked.content[0].text).includes("\\"));

    const del = captureTool(registerDiagramsDelete, ctx);
    const deleted = await del.handler({ relative_path: "models\\echo.puml" });
    assert.equal(deleted.structuredContent.relative_path, "models/echo.puml");
  });

  it("DiagramStore.list() never returns backslash separators", async () => {
    await ctx.diagramStore.write("a/b/c.puml", "@startuml\nclass Deep\n@enduml", {
      overwrite: false,
    });
    const listed = await ctx.diagramStore.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].relativePath, "a/b/c.puml");
    assert.ok(!listed[0].relativePath.includes("\\"));
  });
});

describe("MCP tool responses return full content without truncation", () => {
  let tmpRoot: string;
  let ctx: ServerContext;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-limits-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("diagrams_get returns diagram source larger than the legacy 25,000-character limit intact", async () => {
    const largeBody = `@startuml\n${"class Widget\n".repeat(2500)}@enduml\n`;
    assert.ok(
      largeBody.length > 25_000,
      `fixture must exceed legacy limit, got ${largeBody.length}`,
    );

    await ctx.diagramStore.write("models/large.puml", largeBody, { overwrite: false });

    const stored = await ctx.diagramStore.read("models/large.puml");
    assert.equal(stored.content.length, largeBody.length);
    assert.equal(stored.content, largeBody);

    const tool = captureTool(registerDiagramsGet, ctx);
    const result = await tool.handler({ relative_path: "models/large.puml" });

    assert.equal(result.structuredContent.content, largeBody);
    assert.equal(result.content[0].text, largeBody);
    assert.equal(result.structuredContent.relative_path, "models/large.puml");
  });
});

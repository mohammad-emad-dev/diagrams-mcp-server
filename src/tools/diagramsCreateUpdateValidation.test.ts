import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { registerDiagramsCreate } from "./diagramsCreate.js";
import { registerDiagramsUpdate } from "./diagramsUpdate.js";

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
): { handler: CapturedToolHandler } {
  const captured = {} as {
    handler: CapturedToolHandler;
  };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx);
  return captured;
}

const VALID_PLANTUML = "@startuml\ntitle Widget Model\nclass Widget {\n  +id: int\n}\n@enduml\n";
const VALID_PLANTUML_V2 =
  "@startuml\ntitle Widget Model\nclass Widget {\n  +id: int\n  +label: string\n}\n@enduml\n";
const VALID_MERMAID =
  "sequenceDiagram\n    participant Customer\n    Customer->>OrderService: Create order\n";
const VALID_MERMAID_V2 =
  "sequenceDiagram\n    participant Customer\n    Customer->>OrderService: Updated order\n";

describe("diagrams_create/update safe syntax validation", () => {
  let tmpRoot: string;
  let ctx: ServerContext;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-validate-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("creates and updates a valid PlantUML diagram", async () => {
    const create = captureTool(registerDiagramsCreate, ctx);
    const created = await create.handler({
      relative_path: "models/widget.puml",
      content: VALID_PLANTUML,
    });
    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent.created, true);
    assert.deepEqual(
      Object.keys(created.structuredContent).sort(),
      ["created", "relative_path"],
      "diagrams_create structuredContent must match its documented schema",
    );

    const update = captureTool(registerDiagramsUpdate, ctx);
    const updated = await update.handler({
      relative_path: "models/widget.puml",
      content: VALID_PLANTUML_V2,
    });
    assert.equal(updated.isError, undefined);
    assert.equal(updated.structuredContent.updated, true);
    assert.deepEqual(
      Object.keys(updated.structuredContent).sort(),
      ["relative_path", "updated"],
      "diagrams_update structuredContent must match its documented schema",
    );
    assert.equal((await ctx.diagramStore.read("models/widget.puml")).content, VALID_PLANTUML_V2);
  });

  it("creates and updates a valid Mermaid diagram", async () => {
    const create = captureTool(registerDiagramsCreate, ctx);
    const created = await create.handler({
      relative_path: "models/flow.mmd",
      content: VALID_MERMAID,
    });
    assert.equal(created.isError, undefined);
    assert.deepEqual(
      Object.keys(created.structuredContent).sort(),
      ["created", "relative_path"],
      "diagrams_create structuredContent must match its documented schema",
    );

    const update = captureTool(registerDiagramsUpdate, ctx);
    const updated = await update.handler({
      relative_path: "models/flow.mmd",
      content: VALID_MERMAID_V2,
    });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(
      Object.keys(updated.structuredContent).sort(),
      ["relative_path", "updated"],
      "diagrams_update structuredContent must match its documented schema",
    );
    assert.equal((await ctx.diagramStore.read("models/flow.mmd")).content, VALID_MERMAID_V2);
  });

  it("rejects empty/whitespace source without creating a file", async () => {
    const create = captureTool(registerDiagramsCreate, ctx);

    for (const bad of ["", "   \n\t  "]) {
      const result = await create.handler({
        relative_path: "models/empty.puml",
        content: bad,
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /PlantUML/);
      assert.equal(await ctx.diagramStore.exists("models/empty.puml"), false);
    }

    const mermaidResult = await create.handler({
      relative_path: "models/empty.mmd",
      content: "   \n  ",
    });
    assert.equal(mermaidResult.isError, true);
    assert.match(mermaidResult.content[0].text, /Mermaid/);
    assert.equal(await ctx.diagramStore.exists("models/empty.mmd"), false);
  });

  it("rejects PlantUML missing boundaries without creating a file", async () => {
    const create = captureTool(registerDiagramsCreate, ctx);
    const result = await create.handler({
      relative_path: "models/broken.puml",
      content: "class Widget {\n  +id: int\n}\n",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PlantUML/);
    assert.match(result.content[0].text, /@startuml|@enduml/i);
    assert.equal(await ctx.diagramStore.exists("models/broken.puml"), false);
  });

  it("rejects clearly invalid Mermaid without creating a file", async () => {
    const create = captureTool(registerDiagramsCreate, ctx);
    const result = await create.handler({
      relative_path: "models/broken.mmd",
      content: "hello world this is not a diagram",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Mermaid/);
    assert.equal(await ctx.diagramStore.exists("models/broken.mmd"), false);
  });

  it("leaves the original file unchanged when an update is invalid", async () => {
    await ctx.diagramStore.write("models/widget.puml", VALID_PLANTUML, {
      overwrite: false,
    });

    const update = captureTool(registerDiagramsUpdate, ctx);
    const result = await update.handler({
      relative_path: "models/widget.puml",
      content: "class BrokenWithoutBoundaries\n",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PlantUML/);
    assert.equal((await ctx.diagramStore.read("models/widget.puml")).content, VALID_PLANTUML);

    const mermaidStorePath = "models/flow.mmd";
    await ctx.diagramStore.write(mermaidStorePath, VALID_MERMAID, {
      overwrite: false,
    });
    const badMermaid = await update.handler({
      relative_path: mermaidStorePath,
      content: "not a diagram at all",
    });
    assert.equal(badMermaid.isError, true);
    assert.match(badMermaid.content[0].text, /Mermaid/);
    assert.equal((await ctx.diagramStore.read(mermaidStorePath)).content, VALID_MERMAID);
  });

  it("rejects invalid DiagramStore.write directly without touching disk", async () => {
    await assert.rejects(
      ctx.diagramStore.write("models/direct.puml", "no boundaries here", {
        overwrite: false,
      }),
      /PlantUML/,
    );
    assert.equal(await ctx.diagramStore.exists("models/direct.puml"), false);

    await assert.rejects(
      ctx.diagramStore.write("models/direct.mmd", "just prose", {
        overwrite: false,
      }),
      /Mermaid/,
    );
    assert.equal(await ctx.diagramStore.exists("models/direct.mmd"), false);
  });
});

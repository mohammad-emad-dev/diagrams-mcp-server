import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { registerDiagramsDelete } from "./diagramsDelete.js";

interface CapturedTextContent {
  type: string;
  text: string;
}

interface CapturedToolResult {
  content: CapturedTextContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

interface CapturedRegistration {
  name: string;
  config: {
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
  handler: (params: { relative_path: string }) => Promise<CapturedToolResult>;
}

function captureRegistration(ctx: ServerContext): CapturedRegistration {
  const captured = {} as CapturedRegistration;
  const fakeServer = {
    registerTool: (
      name: string,
      config: CapturedRegistration["config"],
      handler: CapturedRegistration["handler"],
    ): void => {
      captured.name = name;
      captured.config = config;
      captured.handler = handler;
    },
  } as unknown as McpServer;
  registerDiagramsDelete(fakeServer, ctx);
  return captured;
}

describe("diagrams_delete", () => {
  let tmpRoot: string;
  let ctx: ServerContext;
  let tool: CapturedRegistration;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-delete-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
    tool = captureRegistration(ctx);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("deletes an existing diagram and is marked destructive", async () => {
    await ctx.diagramStore.write("models/user-class.puml", "@startuml\nclass User\n@enduml", {
      overwrite: false,
    });

    assert.equal(tool.name, "diagrams_delete");
    assert.equal(tool.config.annotations?.destructiveHint, true);
    assert.equal(tool.config.annotations?.readOnlyHint, false);

    const result = await tool.handler({ relative_path: "models/user-class.puml" });

    assert.deepEqual(result.structuredContent, {
      relative_path: "models/user-class.puml",
      deleted: true,
    });
    assert.match(result.content[0].text, /Deleted diagram/);
    assert.equal(await ctx.diagramStore.exists("models/user-class.puml"), false);
  });

  it("returns an error for a missing diagram", async () => {
    const result = await tool.handler({ relative_path: "models/missing.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No diagram found at 'models\/missing\.puml'/);
  });

  it("rejects path traversal outside the diagrams root", async () => {
    const result = await tool.handler({ relative_path: "../outside.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside the diagrams root/);
  });
});

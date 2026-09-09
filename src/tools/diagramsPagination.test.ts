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

const PUMA = (name: string): string => `@startuml\ntitle ${name}\nclass ${name}\n@enduml\n`;

describe("diagrams_list pagination", () => {
  let tmpRoot: string;
  let ctx: ServerContext;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-paginate-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
    await ctx.diagramStore.write("models/a.puml", PUMA("A"), { overwrite: false });
    await ctx.diagramStore.write("models/b.puml", PUMA("B"), { overwrite: false });
    await ctx.diagramStore.write("models/c.puml", PUMA("C"), { overwrite: false });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("preserves default behavior: omitting pagination returns every item", async () => {
    const tool = captureTool(registerDiagramsList, ctx);
    const result = await tool.handler({ type_filter: "all" });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.count, 3);
    assert.equal(result.structuredContent.total, 3);
    assert.equal(result.structuredContent.offset, 0);
    assert.equal(result.structuredContent.limit, 3);
    assert.equal(result.structuredContent.has_more, false);
    assert.deepEqual(
      (result.structuredContent.diagrams as Array<{ relative_path: string }>).map(
        (d) => d.relative_path,
      ),
      ["models/a.puml", "models/b.puml", "models/c.puml"],
    );
  });

  it("returns the requested page with metadata and POSIX paths", async () => {
    const tool = captureTool(registerDiagramsList, ctx);
    const first = await tool.handler({ type_filter: "all", offset: 0, limit: 2 });

    assert.equal(first.isError, undefined);
    assert.equal(first.structuredContent.count, 2);
    assert.equal(first.structuredContent.total, 3);
    assert.equal(first.structuredContent.offset, 0);
    assert.equal(first.structuredContent.limit, 2);
    assert.equal(first.structuredContent.has_more, true);
    assert.deepEqual(
      (first.structuredContent.diagrams as Array<{ relative_path: string }>).map(
        (d) => d.relative_path,
      ),
      ["models/a.puml", "models/b.puml"],
    );
    assert.ok(
      first.content[0].text.includes("Call diagrams_list with offset=2"),
      "a page with has_more=true must suggest the next offset",
    );

    const second = await tool.handler({ type_filter: "all", offset: 2, limit: 2 });
    assert.equal(second.isError, undefined);
    assert.equal(second.structuredContent.count, 1);
    assert.equal(second.structuredContent.total, 3);
    assert.equal(second.structuredContent.has_more, false);
    const lastDiagram = (second.structuredContent.diagrams as Array<{ relative_path: string }>)[0];
    assert.equal(lastDiagram.relative_path, "models/c.puml");
    assert.ok(
      !second.content[0].text.includes("Call diagrams_list with offset="),
      "a final partial page must not suggest an offset that returns an empty page",
    );
  });

  it("returns an empty page with has_more=false when offset is past the end", async () => {
    const tool = captureTool(registerDiagramsList, ctx);
    const result = await tool.handler({ type_filter: "all", offset: 99, limit: 10 });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.count, 0);
    assert.deepEqual(result.structuredContent.diagrams, []);
    assert.equal(result.structuredContent.total, 3);
    assert.equal(result.structuredContent.has_more, false);
    assert.match(result.content[0].text, /3/);
  });

  it("rejects invalid or oversized pagination values without throwing", async () => {
    const tool = captureTool(registerDiagramsList, ctx);
    for (const params of [
      { type_filter: "all", offset: -1 },
      { type_filter: "all", offset: 1.5 },
      { type_filter: "all", offset: "0" },
      { type_filter: "all", limit: 0 },
      { type_filter: "all", limit: -2 },
      { type_filter: "all", limit: 2.5 },
      { type_filter: "all", limit: 501 },
    ]) {
      const result = await tool.handler(params);
      assert.equal(result.isError, true, `expected isError for ${JSON.stringify(params)}`);
      assert.match(result.content[0].text, /offset|limit/i);
      const expectedPrefix =
        "limit" in params
          ? "Error: Invalid pagination: 'limit'"
          : "Error: Invalid pagination: 'offset'";
      assert.ok(
        String(result.content[0].text).startsWith(expectedPrefix),
        `expected exact error prefix '${expectedPrefix}', got '${result.content[0].text}'`,
      );
    }
    // Nothing was dropped or listed by the rejected calls: full list still intact.
    const relisted = await tool.handler({ type_filter: "all" });
    assert.equal(relisted.structuredContent.total, 3);
  });
});

describe("diagrams_get source windows", () => {
  let tmpRoot: string;
  let ctx: ServerContext;
  const BODY = `@startuml\n${"class Widget\n".repeat(400)}@enduml\n`;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-window-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
    assert.ok(BODY.length > 5_000, `window fixture must be large, got ${BODY.length}`);
    await ctx.diagramStore.write("models/big.puml", BODY, { overwrite: false });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("preserves full-content default behavior with complete metadata", async () => {
    const tool = captureTool(registerDiagramsGet, ctx);
    const result = await tool.handler({ relative_path: "models/big.puml" });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.content, BODY);
    assert.equal(result.content[0].text, BODY);
    assert.equal(result.structuredContent.is_partial, false);
    assert.equal(result.structuredContent.offset, 0);
    assert.equal(result.structuredContent.total_chars, BODY.length);
    assert.equal(result.structuredContent.returned_chars, BODY.length);
    assert.equal(result.structuredContent.has_more, false);
  });

  it("returns the requested source window with matching text output", async () => {
    const tool = captureTool(registerDiagramsGet, ctx);
    const result = await tool.handler({
      relative_path: "models/big.puml",
      offset: 100,
      max_chars: 200,
    });

    const expected = BODY.slice(100, 300);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.content, expected);
    assert.equal(result.content[0].text, expected);
    assert.equal(result.structuredContent.is_partial, true);
    assert.equal(result.structuredContent.offset, 100);
    assert.equal(result.structuredContent.total_chars, BODY.length);
    assert.equal(result.structuredContent.returned_chars, 200);
    assert.equal(result.structuredContent.has_more, true);
  });

  it("handles start/end boundaries without silent truncation", async () => {
    const tool = captureTool(registerDiagramsGet, ctx);

    const head = await tool.handler({
      relative_path: "models/big.puml",
      offset: 0,
      max_chars: 50,
    });
    assert.equal(head.structuredContent.content, BODY.slice(0, 50));
    assert.equal(head.structuredContent.is_partial, true);
    assert.equal(head.structuredContent.has_more, true);

    const tail = await tool.handler({
      relative_path: "models/big.puml",
      offset: BODY.length - 10,
    });
    assert.equal(tail.structuredContent.content, BODY.slice(BODY.length - 10));
    assert.equal(tail.structuredContent.returned_chars, 10);
    assert.equal(tail.structuredContent.is_partial, true);
    assert.equal(tail.structuredContent.has_more, false);

    // max_chars past the end clamps to the end instead of erroring.
    const clamped = await tool.handler({
      relative_path: "models/big.puml",
      offset: BODY.length - 10,
      max_chars: 10_000,
    });
    assert.equal(clamped.structuredContent.returned_chars, 10);
    assert.equal(clamped.structuredContent.has_more, false);

    // max_chars covering the whole file from 0 is the full content.
    const whole = await tool.handler({
      relative_path: "models/big.puml",
      offset: 0,
      max_chars: BODY.length,
    });
    assert.equal(whole.structuredContent.content, BODY);
    assert.equal(whole.structuredContent.is_partial, false);
  });

  it("rejects out-of-range offsets and invalid ranges with stable errors", async () => {
    const tool = captureTool(registerDiagramsGet, ctx);

    const pastEnd = await tool.handler({
      relative_path: "models/big.puml",
      offset: BODY.length + 50,
    });
    assert.equal(pastEnd.isError, true);
    assert.match(pastEnd.content[0].text, /out of range/i);
    assert.ok(
      String(pastEnd.content[0].text).startsWith("Error: offset "),
      `expected exact error prefix 'Error: offset ', got '${pastEnd.content[0].text}'`,
    );

    for (const params of [
      { relative_path: "models/big.puml", offset: -1 },
      { relative_path: "models/big.puml", offset: 2.5 },
      { relative_path: "models/big.puml", max_chars: 0 },
      { relative_path: "models/big.puml", max_chars: 100_001 },
    ]) {
      const result = await tool.handler(params);
      assert.equal(result.isError, true, `expected isError for ${JSON.stringify(params)}`);
      assert.match(result.content[0].text, /offset|max_chars/i);
      const expectedPrefix =
        "max_chars" in params
          ? "Error: Invalid source window: 'max_chars'"
          : "Error: Invalid source window: 'offset'";
      assert.ok(
        String(result.content[0].text).startsWith(expectedPrefix),
        `expected exact error prefix '${expectedPrefix}', got '${result.content[0].text}'`,
      );
    }

    // The rejected calls changed nothing on disk.
    assert.equal((await ctx.diagramStore.read("models/big.puml")).content, BODY);
  });

  it("echoes backslash input as POSIX in windowed output", async () => {
    const tool = captureTool(registerDiagramsGet, ctx);
    const result = await tool.handler({
      relative_path: "models\\big.puml",
      offset: 0,
      max_chars: 20,
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.relative_path, "models/big.puml");
    assert.equal(result.structuredContent.content, BODY.slice(0, 20));
    assert.equal(result.content[0].text, BODY.slice(0, 20));
  });
});

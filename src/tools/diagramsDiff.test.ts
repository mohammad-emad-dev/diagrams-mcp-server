import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { registerDiagramsDiff } from "./diagramsDiff.js";

interface CapturedToolResult {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

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
  handler: CapturedToolHandler;
}

function captureRegistration(ctx: ServerContext): CapturedRegistration {
  const captured = {} as CapturedRegistration;
  const fakeServer = {
    registerTool: (
      name: string,
      config: CapturedRegistration["config"],
      handler: CapturedToolHandler,
    ): void => {
      captured.name = name;
      captured.config = config;
      captured.handler = handler;
    },
  } as unknown as McpServer;
  registerDiagramsDiff(fakeServer, ctx);
  return captured;
}

const V1 = "@startuml\nclass User\nclass Order\n@enduml\n";
const V2 = "@startuml\nclass User\nclass Order\nclass Invoice\n@enduml\n";
const MERMAID_V2 = "classDiagram\nclass User\nclass Order\nclass Invoice\n";

const STORED = "models/order.puml";
// A Windows-style separator in a stored path must still come back POSIX.
const STORED_WINDOWSISH = "windows\\invoice.puml";

describe("diagrams_diff", () => {
  let tmpRoot: string;
  let ctx: ServerContext;
  let tool: CapturedRegistration;
  let filesBefore: Set<string>;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-diff-"));
    ctx = { diagramStore: new DiagramStore(path.join(tmpRoot, "diagrams")), codeRootDir: tmpRoot };
    await ctx.diagramStore.write(STORED, V1, { overwrite: false });
    await ctx.diagramStore.write(STORED_WINDOWSISH, V1, { overwrite: false });
    tool = captureRegistration(ctx);
    filesBefore = new Set(await listAllFiles(tmpRoot));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reports an added entity with POSIX paths and read-only annotations", async () => {
    const result = await tool.handler({
      a_relative_path: STORED,
      b_content: V2,
    });

    assert.equal(result.isError, undefined);
    assert.equal(tool.config.annotations?.readOnlyHint, true);
    assert.equal(tool.config.annotations?.destructiveHint, false);
    assert.equal(tool.config.annotations?.idempotentHint, true);
    assert.equal(tool.config.annotations?.openWorldHint, false);

    const structured = result.structuredContent as {
      a: { source: string; type: string };
      b: { source: string; type: string };
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
      renamed: Array<{ from: string; to: string; confidence: string }>;
      unchanged: string[];
      unchanged_count: number;
      participants_added: string[];
      participants_removed: string[];
      calls_added: string[];
      calls_removed: string[];
      is_same: boolean;
      confidence: string;
      heuristic_warning: string;
    };
    assert.equal(structured.a.source, STORED);
    assert.equal(structured.a.type, "plantuml");
    assert.equal(structured.b.source, "<inline>");
    assert.equal(structured.b.type, "plantuml");
    for (const side of [structured.a, structured.b]) {
      assert.ok(!side.source.includes("\\"), `side source must be POSIX: '${side.source}'`);
    }
    assert.deepEqual(structured.added, [{ name: "Invoice" }]);
    assert.deepEqual(structured.removed, []);
    assert.deepEqual(structured.renamed, []);
    assert.deepEqual(structured.unchanged, ["User", "Order"]);
    assert.equal(structured.unchanged_count, 2);
    assert.equal(structured.is_same, false);
    assert.equal(structured.confidence, "heuristic");
    assert.ok(structured.heuristic_warning.length > 0);
    // Sequence fields exist and are empty for a class diagram.
    assert.deepEqual(structured.participants_added, []);
    assert.deepEqual(structured.calls_added, []);
    // The text block is a human-readable summary that names both sides.
    assert.ok(result.content[0].text.includes("Invoice"));
    assert.ok(result.content[0].text.includes(STORED));
  });

  it("reports one line when the two sides are identical", async () => {
    const result = await tool.handler({
      a_relative_path: STORED,
      b_content: V1,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { is_same: boolean; unchanged_count: number };
    assert.equal(structured.is_same, true);
    assert.equal(structured.unchanged_count, 2);
    assert.equal(result.content[0].text.split("\n").length, 1);
    assert.match(result.content[0].text, /No differences/i);
  });

  it("reads both sides from the store and detects a removal", async () => {
    await ctx.diagramStore.write(STORED, V2, { overwrite: true });
    const result = await tool.handler({
      a_relative_path: STORED,
      b_relative_path: STORED_WINDOWSISH,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      a: { source: string };
      b: { source: string };
      removed: Array<{ name: string }>;
    };
    assert.equal(structured.a.source, STORED);
    assert.equal(structured.b.source, "windows/invoice.puml");
    assert.deepEqual(structured.removed, [{ name: "Invoice" }]);
  });

  it("swaps added and removed when the sides are exchanged", async () => {
    const forward = await tool.handler({ a_relative_path: STORED, b_content: V2 });
    const backward = await tool.handler({ a_content: V2, b_relative_path: STORED });

    assert.equal(forward.isError, undefined);
    assert.equal(backward.isError, undefined);
    const forwardStructured = forward.structuredContent as {
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
    };
    const backwardStructured = backward.structuredContent as {
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
    };
    assert.deepEqual(forwardStructured.added, [{ name: "Invoice" }]);
    assert.deepEqual(forwardStructured.removed, []);
    assert.deepEqual(backwardStructured.added, []);
    assert.deepEqual(backwardStructured.removed, [{ name: "Invoice" }]);
  });

  it("pairs a rename through the shared normalizer with confidence heuristic", async () => {
    const renamed = "@startuml\nclass USER\nclass Order\n@enduml\n";
    const result = await tool.handler({ a_content: V1, b_content: renamed });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
      renamed: Array<{ from: string; to: string; confidence: string }>;
    };
    // "User" and "USER" normalize to the same key, so the pair is a rename,
    // not an add plus a remove.
    assert.deepEqual(structured.renamed, [{ from: "User", to: "USER", confidence: "heuristic" }]);
    assert.deepEqual(structured.added, []);
    assert.deepEqual(structured.removed, []);
  });

  it("does not pair names that merely look similar", async () => {
    const similar = "@startuml\nclass UserManager\nclass Order\n@enduml\n";
    const result = await tool.handler({ a_content: V1, b_content: similar });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
      renamed: Array<{ from: string; to: string }>;
    };
    assert.deepEqual(structured.renamed, []);
    assert.deepEqual(structured.added, [{ name: "UserManager" }]);
    assert.deepEqual(structured.removed, [{ name: "User" }]);
  });

  it("produces zero renames for a pure reordering", async () => {
    const reordered = "@startuml\nclass Order\nclass User\n@enduml\n";
    const result = await tool.handler({ a_content: V1, b_content: reordered });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      renamed: Array<{ from: string; to: string }>;
      is_same: boolean;
    };
    assert.deepEqual(structured.renamed, []);
    assert.equal(structured.is_same, true);
  });

  it("reports participants and calls for both sequence dialects", async () => {
    const pumlA =
      "@startuml\nparticipant Customer\nparticipant OrderService\nCustomer -> OrderService: place(order)\n@enduml\n";
    const pumlB =
      "@startuml\nparticipant Customer\nparticipant PaymentGateway\nCustomer -> PaymentGateway: charge(card)\n@enduml\n";
    const pumlResult = await tool.handler({ a_content: pumlA, b_content: pumlB });
    assert.equal(pumlResult.isError, undefined);
    assert.deepEqual(
      (pumlResult.structuredContent as { participants_added: string[] }).participants_added,
      ["PaymentGateway"],
    );
    assert.deepEqual((pumlResult.structuredContent as { calls_added: string[] }).calls_added, [
      "charge",
    ]);

    const mmdA = "sequenceDiagram\nparticipant Customer\nCustomer->>OrderService: place(order)\n";
    const mmdB =
      "sequenceDiagram\nparticipant Customer\nparticipant OrderService\nCustomer->>OrderService: place(order)\nCustomer->>OrderService: cancel(order)\n";
    const mmdResult = await tool.handler({ a_content: mmdA, b_content: mmdB });
    assert.equal(mmdResult.isError, undefined);
    assert.deepEqual(
      (mmdResult.structuredContent as { participants_added: string[] }).participants_added,
      ["OrderService"],
    );
    assert.deepEqual((mmdResult.structuredContent as { calls_added: string[] }).calls_added, [
      "cancel",
    ]);
  });

  it("accepts a cross-dialect comparison of stored mermaid against inline plantuml", async () => {
    await ctx.diagramStore.write("models/order.mmd", MERMAID_V2, { overwrite: false });
    const result = await tool.handler({
      a_relative_path: "models/order.mmd",
      b_content: V1,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      a: { source: string; type: string };
      b: { source: string; type: string };
      removed: Array<{ name: string }>;
    };
    assert.equal(structured.a.type, "mermaid");
    assert.equal(structured.b.type, "plantuml");
    assert.deepEqual(structured.removed, [{ name: "Invoice" }]);
  });

  it("returns input-shape errors naming the offending side for all four combinations", async () => {
    const bothA = await tool.handler({ a_relative_path: STORED, a_content: V1, b_content: V2 });
    assert.equal(bothA.isError, true);
    assert.match(bothA.content[0].text, /side 'a'/);
    assert.match(bothA.content[0].text, /exactly one/);

    const neitherA = await tool.handler({ b_content: V2 });
    assert.equal(neitherA.isError, true);
    assert.match(neitherA.content[0].text, /side 'a'/);

    // Mixed: side a supplies both, side b supplies neither.
    const mixedBothNeither = await tool.handler({
      a_relative_path: STORED,
      a_content: V1,
    });
    assert.equal(mixedBothNeither.isError, true);
    assert.match(mixedBothNeither.content[0].text, /side 'a'/);
    assert.match(mixedBothNeither.content[0].text, /side 'b'/);

    // Mixed the other way: neither for a, both for b.
    const mixedNeitherBoth = await tool.handler({
      b_relative_path: STORED,
      b_content: V2,
    });
    assert.equal(mixedNeitherBoth.isError, true);
    assert.match(mixedNeitherBoth.content[0].text, /side 'a'/);
    assert.match(mixedNeitherBoth.content[0].text, /side 'b'/);
  });

  it("refuses an unrecognized inline dialect with an input-shape error", async () => {
    const result = await tool.handler({ a_content: "this is not a diagram", b_content: V2 });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /side 'a'/);
    // No stored file is touched and nothing is written.
    const filesAfter = new Set(await listAllFiles(tmpRoot));
    assert.deepEqual([...filesAfter].sort(), [...filesBefore].sort());
  });

  it("returns the store errors for missing and escaping stored sides", async () => {
    const missing = await tool.handler({ a_relative_path: "models/nope.puml", b_content: V2 });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No diagram found at 'models\/nope\.puml'/);

    const escaping = await tool.handler({ a_relative_path: "../outside.puml", b_content: V2 });
    assert.equal(escaping.isError, true);
    assert.match(escaping.content[0].text, /outside the diagrams root/);
  });

  it("never writes a file under the diagrams root", async () => {
    for (const args of [
      { a_relative_path: STORED, b_content: V2 },
      { a_content: V1, b_content: V2 },
      { a_relative_path: STORED, b_relative_path: STORED_WINDOWSISH },
      { a_relative_path: "models/nope.puml", b_content: V2 },
    ]) {
      await tool.handler(args);
    }

    const filesAfter = new Set(await listAllFiles(tmpRoot));
    assert.deepEqual([...filesAfter].sort(), [...filesBefore].sort());
  });
});

// The tool is read-only: this snapshot proves no file appears under the temp
// root as a result of any call.
async function listAllFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  let entries: import("node:fs").Dirent[];
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

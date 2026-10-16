import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDiagramServer } from "../server.js";
import { DiagramStore } from "../services/diagramStore.js";

it("scaffolds and saves one diagram without exposing HTML through diagram listing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-save-sdk-"));
  const store = new DiagramStore(root);
  const server = createDiagramServer({
    diagramStore: store,
    codeRootDir: root,
    rendererDeps: {
      commandExists: async (command) => command === "mmdc",
      runCommand: async (_command, args) => {
        await fs.writeFile(
          args[args.indexOf("-o") + 1],
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        );
        return { stdout: "", stderr: "" };
      },
    },
  });
  const client = new Client({ name: "save-export-test", version: "1.0.0" });
  try {
    await store.write("flow.mmd", "classDiagram\nclass OrderService\n", { overwrite: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const scaffold = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "flow.mmd" },
    });
    assert.equal(scaffold.isError, undefined);
    const draft = scaffold.structuredContent as Record<string, unknown>;
    assert.equal(draft.source, "export class OrderService {}\n");
    assert.equal(draft.written, false);
    assert.equal((scaffold.content as Array<{ text: string }>)[0].text, draft.source);
    const exported = await client.callTool({
      name: "diagrams_export",
      arguments: { relative_path: "flow.mmd" },
    });
    assert.equal(exported.isError, undefined);
    assert.deepEqual(await fs.readdir(root), ["flow.mmd"]);
    const args = { relative_path: "flow.mmd", output_path: "exports/flow.html" };
    const saved = await client.callTool({ name: "diagrams_save_export", arguments: args });
    assert.equal(saved.isError, undefined);
    assert.equal(
      (saved.structuredContent as { source_included?: unknown } | undefined)?.source_included,
      true,
    );
    const exportedText = (exported.content as Array<{ type: string; text?: string }>)[0].text;
    const html = await fs.readFile(path.join(root, args.output_path), "utf8");
    assert.equal(html, exportedText);
    assert.equal(
      (saved.structuredContent as { bytes?: unknown } | undefined)?.bytes,
      Buffer.byteLength(html, "utf8"),
    );
    const collision = await client.callTool({ name: "diagrams_save_export", arguments: args });
    assert.equal(collision.isError, true);
    assert.equal(await fs.readFile(path.join(root, args.output_path), "utf8"), html);
    const listed = await client.callTool({
      name: "diagrams_list",
      arguments: { type_filter: "all" },
    });
    assert.equal(listed.isError, undefined);
    const inventory = listed.structuredContent as {
      count: number;
      diagrams: Array<{ relative_path: string }>;
    };
    assert.equal(inventory.count, 1);
    assert.deepEqual(
      inventory.diagrams.map((diagram) => diagram.relative_path),
      ["flow.mmd"],
    );
    assert.equal(
      await fs.readFile(path.join(root, "flow.mmd"), "utf8"),
      "classDiagram\nclass OrderService\n",
    );
  } finally {
    await client.close();
    await server.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("diagrams-save-sdk-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

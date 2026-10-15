import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDiagramServer } from "../server.js";
import { DiagramStore } from "../services/diagramStore.js";

it("saves the same HTML returned by read-only export through the real MCP SDK", async () => {
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
    await store.write("flow.mmd", "sequenceDiagram\nA->>B: charge()\n", { overwrite: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
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
  } finally {
    await client.close();
    await server.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("diagrams-save-sdk-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

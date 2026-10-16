import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDiagramServer } from "../server.js";
import { DiagramStore } from "../services/diagramStore.js";

it("drafts class shells from a generated and stored diagram through the MCP SDK", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-scaffold-sdk-"));
  const diagramsRoot = path.join(root, "diagrams");
  const code = "export class Widget { id = 1; }\nexport interface Payment { amount: number; }\n";
  const server = createDiagramServer({
    diagramStore: new DiagramStore(diagramsRoot),
    codeRootDir: root,
  });
  const client = new Client({ name: "scaffold-round-trip", version: "1.0.0" });
  try {
    await fs.mkdir(path.join(root, "src-code"));
    await fs.writeFile(path.join(root, "src-code", "model.ts"), code, "utf8");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const generated = await client.callTool({
      name: "diagrams_generate",
      arguments: { scope: "src-code", format: "mermaid" },
    });
    assert.equal(generated.isError, undefined);
    const diagram = (generated.structuredContent as Record<string, unknown>)?.source;
    assert.equal(typeof diagram, "string");
    const created = await client.callTool({
      name: "diagrams_create",
      arguments: { relative_path: "model.mmd", content: diagram },
    });
    assert.equal(created.isError, undefined);
    const scaffold = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "model.mmd" },
    });
    assert.equal(scaffold.isError, undefined);
    const summary = scaffold.structuredContent as Record<string, unknown>;
    assert.equal(summary?.written, false);
    assert.equal(summary?.confidence, "heuristic");
    assert.equal(summary?.entity_limit, 30);
    const source = summary?.source;
    assert.equal(typeof source, "string");
    assert.match(source as string, /export class Widget \{\}/);
    assert.match(source as string, /export class Payment \{\}/);
    assert.doesNotMatch(source as string, /amount|id =/);
    assert.equal((scaffold.content as Array<{ text: string }>)[0].text, source);
    assert.deepEqual(await fs.readdir(diagramsRoot), ["model.mmd"]);
    assert.deepEqual(await fs.readdir(root), ["diagrams", "src-code"]);
    assert.deepEqual(await fs.readdir(path.join(root, "src-code")), ["model.ts"]);
    assert.equal(await fs.readFile(path.join(root, "src-code", "model.ts"), "utf8"), code);
    assert.equal(await fs.readFile(path.join(diagramsRoot, "model.mmd"), "utf8"), diagram);

    const memberDiagram = "classDiagram\nclass Order {\n+id: string\n+submit(payment) bool\n}\n";
    const createdMembers = await client.callTool({
      name: "diagrams_create",
      arguments: { relative_path: "order.mmd", content: memberDiagram },
    });
    assert.equal(createdMembers.isError, undefined);
    const emptyMemberDraft = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "order.mmd", include_members: false },
    });
    assert.equal(emptyMemberDraft.isError, undefined);
    assert.equal(
      (emptyMemberDraft.structuredContent as Record<string, unknown>).source,
      "export class Order {}\n",
    );
    assert.equal(
      Object.hasOwn(emptyMemberDraft.structuredContent as object, "members_included"),
      false,
    );
    const memberDraft = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "order.mmd", include_members: true },
    });
    assert.equal(memberDraft.isError, undefined);
    const members = memberDraft.structuredContent as Record<string, unknown>;
    assert.equal(members.include_members, true);
    assert.equal(members.members_included, 2);
    assert.equal(members.member_limit, 30);
    assert.equal(members.members_capped, false);
    assert.equal(members.written, false);
    assert.match(members.source as string, /id: unknown;/);
    assert.match(members.source as string, /submit\(\.\.\._args: unknown\[\]\): unknown/);
    assert.match(members.source as string, /throw "Not implemented"/);
    assert.equal((memberDraft.content as Array<{ text: string }>)[0].text, members.source);
    const typedDraft = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "order.mmd", include_types: true },
    });
    assert.equal(typedDraft.isError, undefined);
    const typed = typedDraft.structuredContent as Record<string, unknown>;
    assert.equal(typed.include_members, true, "types imply member generation");
    assert.equal(typed.include_types, true);
    assert.equal(typed.members_included, 2);
    assert.equal(typed.typed_fields, 1);
    assert.equal(typed.unresolved_fields, 0);
    assert.equal(typed.written, false);
    assert.match(typed.source as string, /id!: string;/);
    assert.match(typed.source as string, /submit\(\.\.\._args: unknown\[\]\): unknown/);
    assert.equal((typedDraft.content as Array<{ text: string }>)[0].text, typed.source);
    assert.equal(Object.hasOwn(members, "include_types"), false);
    assert.equal(Object.hasOwn(members, "typed_fields"), false);
    const explicitUntyped = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "order.mmd", include_members: true, include_types: false },
    });
    assert.equal(explicitUntyped.isError, undefined);
    assert.deepEqual(explicitUntyped.structuredContent, memberDraft.structuredContent);
    const relationDiagram =
      'classDiagram\nclass Order {\nid: string\n}\nclass Customer\nclass Item\nOrder --> Customer : customer\nOrder --> "*" Item : items\n';
    const createdRelations = await client.callTool({
      name: "diagrams_create",
      arguments: { relative_path: "relations.mmd", content: relationDiagram },
    });
    assert.equal(createdRelations.isError, undefined);
    const relationDraft = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "relations.mmd", include_relations: true },
    });
    assert.equal(relationDraft.isError, undefined);
    const relations = relationDraft.structuredContent as Record<string, unknown>;
    assert.equal(relations.include_relations, true);
    assert.equal(relations.include_types, true);
    assert.equal(relations.include_members, true);
    assert.equal(relations.members_included, 3);
    assert.equal(relations.typed_fields, 3);
    assert.equal(relations.relations_included, 2);
    assert.equal(relations.relations_skipped, 0);
    assert.equal(relations.relations_capped, false);
    assert.equal(relations.relation_limit, 300);
    assert.equal(relations.written, false);
    assert.match(relations.source as string, /customer!: Customer;/);
    assert.match(relations.source as string, /items!: Item\[\];/);
    assert.equal((relationDraft.content as Array<{ text: string }>)[0].text, relations.source);
    const disabledRelations = await client.callTool({
      name: "diagrams_scaffold",
      arguments: { relative_path: "order.mmd", include_types: true, include_relations: false },
    });
    assert.equal(disabledRelations.isError, undefined);
    assert.deepEqual(disabledRelations.structuredContent, typedDraft.structuredContent);
    assert.equal(Object.hasOwn(typed, "relations_included"), false);
    assert.equal(Object.hasOwn(summary, "members_included"), false);
    assert.equal(Object.hasOwn(summary, "include_members"), false);
    assert.deepEqual((await fs.readdir(diagramsRoot)).sort(), [
      "model.mmd",
      "order.mmd",
      "relations.mmd",
    ]);
    assert.equal(
      await fs.readFile(path.join(diagramsRoot, "relations.mmd"), "utf8"),
      relationDiagram,
    );
    assert.equal(await fs.readFile(path.join(diagramsRoot, "order.mmd"), "utf8"), memberDiagram);
    assert.equal(await fs.readFile(path.join(root, "src-code", "model.ts"), "utf8"), code);
  } finally {
    await client.close();
    await server.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("diagrams-scaffold-sdk-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

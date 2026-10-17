import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { MAX_GENERATE_ENTITIES, MAX_SCAFFOLD_SOURCE_BYTES } from "../constants.js";
import { ScaffoldSourceTooLargeError } from "../services/scaffold/scaffold.js";
import { isExpectedToolError } from "./toolError.js";
import { diagramsScaffoldInputSchema, registerDiagramsScaffold } from "./diagramsScaffold.js";

async function listAllFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listAllFiles(absolute, base)));
    else found.push(path.relative(base, absolute));
  }
  return found;
}

interface CapturedToolResult {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

function captureTool(
  register: (server: McpServer, ctx: ServerContext) => void,
  ctx: ServerContext,
): { handler: CapturedToolHandler; name: string; config: unknown } {
  const captured = {} as { handler: CapturedToolHandler; name: string; config: unknown };
  const fakeServer = {
    registerTool: (name: string, config: unknown, handler: CapturedToolHandler): void => {
      captured.name = name;
      captured.config = config;
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx);
  return captured;
}

async function callHandler(
  tool: { handler: CapturedToolHandler },
  args: Record<string, unknown>,
): Promise<CapturedToolResult> {
  const parsed = diagramsScaffoldInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface ScaffoldOutput {
  relative_path: string;
  language: string;
  source: string;
  entities: string[];
  entities_included: number;
  entities_available: number;
  entities_capped: boolean;
  entity_limit: number;
  skipped_entities: string[];
  skipped_count: number;
  confidence: string;
  heuristic_warning: string;
  written: boolean;
  include_types?: true;
  typed_fields?: number;
  unresolved_fields?: number;
  include_relations?: true;
  relations_included?: number;
}

function structuredOf(result: CapturedToolResult): ScaffoldOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as ScaffoldOutput;
}

const testTempParent = path.resolve(os.tmpdir());

describe("diagrams_scaffold", () => {
  let projectRoot: string;
  let ctx: ServerContext;
  let filesBefore: Set<string>;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(testTempParent, "scaffold-tool-"));
    ctx = {
      diagramStore: new DiagramStore(path.join(projectRoot, "diagrams")),
      codeRootDir: projectRoot,
    };
    filesBefore = new Set(await listAllFiles(projectRoot));
  });

  afterEach(async () => {
    assert.equal(path.dirname(path.resolve(projectRoot)), testTempParent);
    assert.ok(path.basename(projectRoot).startsWith("scaffold-tool-"));
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("registers read-only, non-destructive, idempotent, and closed-world", () => {
    const tool = captureTool(registerDiagramsScaffold, ctx);
    const config = tool.config as {
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    };

    assert.equal(tool.name, "diagrams_scaffold");
    assert.equal(config.annotations?.readOnlyHint, true);
    assert.equal(config.annotations?.destructiveHint, false);
    assert.equal(config.annotations?.idempotentHint, true);
    assert.equal(config.annotations?.openWorldHint, false);
  });

  it("rejects unknown arguments and out-of-range limits under the strict schema", () => {
    const unknown = diagramsScaffoldInputSchema.safeParse({
      relative_path: "models/a.puml",
      output_dir: "elsewhere",
    });
    assert.equal(unknown.success, false);
    assert.ok(!unknown.success && JSON.stringify(unknown.error.issues).includes("output_dir"));

    for (const bad of [0, MAX_GENERATE_ENTITIES + 1]) {
      const parsed = diagramsScaffoldInputSchema.safeParse({
        relative_path: "models/a.puml",
        max_entities: bad,
      });
      assert.equal(parsed.success, false, `max_entities=${bad} must be rejected`);
    }

    const emptyPath = diagramsScaffoldInputSchema.safeParse({ relative_path: "" });
    assert.equal(emptyPath.success, false);

    const accepted = diagramsScaffoldInputSchema.safeParse({ relative_path: "models/a.puml" });
    assert.equal(accepted.success, true);
    assert.equal(accepted.success && (accepted.data as { max_entities: number }).max_entities, 30);
  });

  it("scaffolds PlantUML without writing and reports skipped independently", async () => {
    await ctx.diagramStore.write(
      "models/order.puml",
      "@startuml\nclass User\nclass Order\nclass User\nclass class\n@enduml\n",
      { overwrite: false },
    );
    const tool = captureTool(registerDiagramsScaffold, ctx);
    const result = await callHandler(tool, { relative_path: "models/order.puml" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.equal(structured.relative_path, "models/order.puml");
    assert.equal(structured.language, "typescript");
    assert.deepEqual(structured.entities, ["User", "Order"]);
    assert.equal(structured.entities_included, 2);
    assert.equal(structured.entities_available, 2);
    assert.equal(structured.entities_capped, false);
    assert.equal(structured.entity_limit, 30);
    assert.deepEqual(structured.skipped_entities, ["class"]);
    assert.equal(structured.skipped_count, 1);
    assert.equal(structured.confidence, "heuristic");
    assert.match(structured.heuristic_warning, /aliases/);
    assert.match(structured.heuristic_warning, /participants/);
    assert.match(structured.heuristic_warning, /call names/);
    assert.match(structured.heuristic_warning, /does NOT recover|does not recover/i);
    assert.equal(structured.written, false);
    assert.equal(result.content[0].text, structured.source);
    assert.equal(structured.source, "export class User {}\n\nexport class Order {}\n");
    assert.ok(!structured.source.includes("class class"));

    const filesAfter = new Set(await listAllFiles(projectRoot));
    assert.ok(filesAfter.has(path.join("diagrams", "models", "order.puml")));
    assert.equal(filesAfter.size, filesBefore.size + 1);
  });

  it("scaffolds Mermaid and never emits invalid names as code", async () => {
    await ctx.diagramStore.write(
      "models/shop.mmd",
      "classDiagram\nclass User\nclass string\nclass Order\nsubgraph foo-bar\nclass User\nend\n",
      { overwrite: false },
    );
    const tool = captureTool(registerDiagramsScaffold, ctx);
    const result = await callHandler(tool, { relative_path: "models/shop.mmd" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.entities, ["User", "Order"]);
    assert.ok(structured.skipped_entities.includes("string"));
    assert.ok(structured.skipped_entities.includes("foo-bar"));
    assert.equal(structured.source, "export class User {}\n\nexport class Order {}\n");
    assert.equal(result.content[0].text, structured.source);
    for (const line of structured.source.trimEnd().split("\n\n")) {
      assert.match(line, /^export class [A-Za-z_][A-Za-z0-9_]* \{\}$/);
    }
    assert.ok(!structured.source.includes("foo-bar"));
    assert.ok(!structured.source.includes("string"));
  });

  it("reports nullable field types in type and implied relation modes without writing output", async () => {
    await ctx.diagramStore.write(
      "models/typed.puml",
      "@startuml\nclass Profile {\ndisplayName: string | null\nmalformed: Missing | null\n}\n@enduml\n",
      { overwrite: false },
    );
    await ctx.diagramStore.write(
      "models/relations.mmd",
      "classDiagram\nclass Purchase {\nquantity: null|ReadonlyArray<number>\n}\nclass Buyer {}\nPurchase --> Buyer : buyer\n",
      { overwrite: false },
    );
    const tool = captureTool(registerDiagramsScaffold, ctx);

    const typed = structuredOf(
      await callHandler(tool, { relative_path: "models/typed.puml", include_types: true }),
    );
    assert.equal(typed.include_types, true);
    assert.equal(
      typed.source,
      "export class Profile {\n  displayName!: string | null;\n  malformed: unknown;\n}\n",
    );
    assert.equal(typed.typed_fields, 1);
    assert.equal(typed.unresolved_fields, 1);
    assert.match(typed.heuristic_warning, /null arm in either order/);
    assert.ok(!typed.source.includes("Missing"));

    const related = structuredOf(
      await callHandler(tool, { relative_path: "models/relations.mmd", include_relations: true }),
    );
    assert.equal(related.include_relations, true);
    assert.equal(
      related.source,
      "export class Purchase {\n  quantity!: readonly number[] | null;\n  buyer!: Buyer;\n}\n\nexport class Buyer {}\n",
    );
    assert.equal(related.typed_fields, 2);
    assert.equal(related.unresolved_fields, 0);
    assert.equal(related.relations_included, 1);
    assert.match(related.heuristic_warning, /null arm in either order/);

    const filesAfter = new Set(await listAllFiles(projectRoot));
    assert.equal(filesAfter.size, filesBefore.size + 2);
    assert.ok(filesAfter.has(path.join("diagrams", "models", "typed.puml")));
    assert.ok(filesAfter.has(path.join("diagrams", "models", "relations.mmd")));
  });

  it("returns empty source with a warning for an empty candidate set", async () => {
    await ctx.diagramStore.write("models/empty.puml", "@startuml\n@enduml\n", {
      overwrite: false,
    });
    const tool = captureTool(registerDiagramsScaffold, ctx);
    const result = await callHandler(tool, { relative_path: "models/empty.puml" });
    const structured = structuredOf(result);

    assert.equal(result.isError, undefined);
    assert.deepEqual(structured.entities, []);
    assert.equal(structured.source, "");
    assert.equal(result.content[0].text, "");
    assert.ok(structured.heuristic_warning.length > 0);
  });

  it("caps valid names while keeping skipped counts independent", async () => {
    await ctx.diagramStore.write(
      "models/capped.puml",
      "@startuml\nclass C\nclass B\nclass A\nclass class\n@enduml\n",
      { overwrite: false },
    );
    const tool = captureTool(registerDiagramsScaffold, ctx);
    const result = await callHandler(tool, {
      relative_path: "models/capped.puml",
      max_entities: 2,
    });
    const structured = structuredOf(result);

    assert.deepEqual(structured.entities, ["C", "B"]);
    assert.equal(structured.entities_available, 3);
    assert.equal(structured.entities_capped, true);
    assert.equal(structured.entity_limit, 2);
    assert.deepEqual(structured.skipped_entities, ["class"]);
    assert.equal(structured.source, "export class C {}\n\nexport class B {}\n");
  });

  it("rejects over-cap UTF-8 source with the typed error and no source leak", async () => {
    const over = `@startuml\nclass A\n${"é".repeat(600_000)}\n@enduml\n`;
    assert.ok(over.length < MAX_SCAFFOLD_SOURCE_BYTES);
    assert.ok(Buffer.byteLength(over, "utf-8") > MAX_SCAFFOLD_SOURCE_BYTES);
    await ctx.diagramStore.write("models/big.puml", over, { overwrite: false });

    const tool = captureTool(registerDiagramsScaffold, ctx);
    const result = await callHandler(tool, { relative_path: "models/big.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`${MAX_SCAFFOLD_SOURCE_BYTES}-byte limit`));
    assert.ok(!result.content[0].text.includes("@startuml"));
    assert.ok(!result.content[0].text.includes(projectRoot));
    assert.equal(result.structuredContent, undefined);
    assert.equal(isExpectedToolError(new ScaffoldSourceTooLargeError(1_000_001, 1_000_000)), true);
  });

  it("reports missing, traversal, and extension errors without leaks", async () => {
    const tool = captureTool(registerDiagramsScaffold, ctx);

    const missing = await callHandler(tool, { relative_path: "models/ghost.puml" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No diagram found at 'models\/ghost\.puml'/);

    const traversal = await callHandler(tool, { relative_path: "../escape.puml" });
    assert.equal(traversal.isError, true);
    assert.match(traversal.content[0].text, /outside the diagrams root/);
    assert.ok(!traversal.content[0].text.includes(projectRoot));

    const badExtension = await callHandler(tool, { relative_path: "models/notes.txt" });
    assert.equal(badExtension.isError, true);
    assert.match(badExtension.content[0].text, /recognized diagram extension/);
  });
});

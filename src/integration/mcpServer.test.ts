import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Full-stack coverage over real stdio: drives the compiled dist/index.js
// with the real SDK client. Renderers stay out; diagrams_render is
// discovery-only here.

const EXPECTED_TOOLS = [
  "diagrams_check_consistency",
  "diagrams_create",
  "diagrams_delete",
  "diagrams_get",
  "diagrams_list",
  "diagrams_render",
  "diagrams_update",
];

const DIAGRAM_PATH = "models/widget.puml";
const DIAGRAM_V1 =
  "@startuml\ntitle Widget Model\nclass Widget {\n  +id: int\n}\nclass GhostWidget {\n  +id: int\n}\n@enduml\n";
const DIAGRAM_V2 =
  "@startuml\ntitle Widget Model\nclass Widget {\n  +id: int\n  +label: string\n}\nclass GhostWidget {\n  +id: int\n}\n@enduml\n";
const CODE_FIXTURE = "export class Widget {\n  id: number;\n}\n";

interface McpToolContent {
  type: string;
  text?: string;
}

interface McpToolResult {
  content: McpToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function assertPosixPath(value: string, label: string): void {
  assert.equal(typeof value, "string", `${label} should be a string`);
  assert.ok(!value.includes("\\"), `${label} should use POSIX separators, got '${value}'`);
}

function textOf(result: McpToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

describe("MCP stdio integration (dist/index.js)", () => {
  let projectRoot = "";
  let diagramsDir = "";
  let codeFixturePath = "";
  let client: Client | undefined;

  function getClient(): Client {
    if (!client) {
      throw new Error("MCP client is not connected (before hook failed).");
    }
    return client;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const raw = (await getClient().callTool({
      name,
      arguments: args,
    })) as unknown as McpToolResult;
    return raw;
  }

  before(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-mcp-integ-"));
    diagramsDir = path.join(projectRoot, "diagrams");
    codeFixturePath = path.join(projectRoot, "src-code", "widget.ts");
    await fs.mkdir(path.dirname(codeFixturePath), { recursive: true });
    await fs.writeFile(codeFixturePath, CODE_FIXTURE, "utf-8");

    const serverPath = path.join(process.cwd(), "dist", "index.js");
    await fs.access(serverPath);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env.PROJECT_ROOT = projectRoot;
    env.DIAGRAMS_DIR = "diagrams";
    // Belt-and-braces: render is discovery-only here, never networked.
    env.DISABLE_REMOTE_PLANTUML = "true";

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env,
    });
    client = new Client({
      name: "diagrams-mcp-integration-test",
      version: "0.1.0",
    });
    await client.connect(transport);
  });

  after(async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("discovers all 7 tools", async () => {
    const { tools } = await getClient().listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  });

  it("creates a diagram with POSIX structured output", async () => {
    const result = await callTool("diagrams_create", {
      relative_path: DIAGRAM_PATH,
      content: DIAGRAM_V1,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      relative_path: string;
      created: boolean;
    };
    assert.equal(structured.relative_path, DIAGRAM_PATH);
    assertPosixPath(structured.relative_path, "created relative_path");
    assert.equal(structured.created, true);
    assert.ok(textOf(result).includes(DIAGRAM_PATH));

    const onDisk = await fs.readFile(path.join(diagramsDir, "models", "widget.puml"), "utf-8");
    assert.equal(onDisk, DIAGRAM_V1);
  });

  it("rejects creating a duplicate diagram", async () => {
    const result = await callTool("diagrams_create", {
      relative_path: DIAGRAM_PATH,
      content: DIAGRAM_V1,
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /already exists/);
  });

  it("lists the created diagram with a POSIX relative path", async () => {
    const result = await callTool("diagrams_list", { type_filter: "all" });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      count: number;
      diagrams: Array<{ relative_path: string; type: string }>;
    };
    assert.equal(structured.count, 1);
    assert.equal(structured.diagrams[0].relative_path, DIAGRAM_PATH);
    assertPosixPath(structured.diagrams[0].relative_path, "listed relative_path");
    assert.equal(structured.diagrams[0].type, "plantuml");
    assert.ok(textOf(result).includes(DIAGRAM_PATH));
  });

  it("reads the diagram source back intact", async () => {
    const result = await callTool("diagrams_get", {
      relative_path: DIAGRAM_PATH,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      relative_path: string;
      type: string;
      content: string;
    };
    assert.equal(structured.relative_path, DIAGRAM_PATH);
    assert.equal(structured.type, "plantuml");
    assert.equal(structured.content, DIAGRAM_V1);
    assert.equal(textOf(result), DIAGRAM_V1);
  });

  it("lists diagrams with explicit pagination and metadata", async () => {
    const pageFiles = ["models/pg-a.puml", "models/pg-b.puml", "models/pg-c.puml"];
    try {
      for (const file of pageFiles) {
        const created = await callTool("diagrams_create", {
          relative_path: file,
          content: DIAGRAM_V1,
        });
        assert.equal(created.isError, undefined);
      }

      const first = await callTool("diagrams_list", {
        type_filter: "all",
        offset: 0,
        limit: 2,
      });
      assert.equal(first.isError, undefined);
      const firstStructured = first.structuredContent as {
        count: number;
        total: number;
        offset: number;
        limit: number;
        has_more: boolean;
        diagrams: Array<{ relative_path: string }>;
      };
      assert.equal(firstStructured.total, 4);
      assert.equal(firstStructured.count, 2);
      assert.equal(firstStructured.offset, 0);
      assert.equal(firstStructured.limit, 2);
      assert.equal(firstStructured.has_more, true);
      assert.deepEqual(
        firstStructured.diagrams.map((d) => d.relative_path),
        ["models/pg-a.puml", "models/pg-b.puml"],
      );

      const second = await callTool("diagrams_list", {
        type_filter: "all",
        offset: 2,
        limit: 2,
      });
      const secondStructured = second.structuredContent as typeof firstStructured;
      assert.equal(secondStructured.count, 2);
      assert.equal(secondStructured.has_more, false);
      assert.deepEqual(
        secondStructured.diagrams.map((d) => d.relative_path),
        ["models/pg-c.puml", "models/widget.puml"],
      );

      const last = await callTool("diagrams_list", {
        type_filter: "all",
        offset: 4,
        limit: 2,
      });
      const lastStructured = last.structuredContent as typeof firstStructured;
      assert.equal(lastStructured.count, 0);
      assert.deepEqual(lastStructured.diagrams, []);
      assert.equal(lastStructured.total, 4);
      assert.equal(lastStructured.has_more, false);
    } finally {
      for (const file of pageFiles) {
        await callTool("diagrams_delete", { relative_path: file });
      }
    }

    const relisted = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((relisted.structuredContent as { count: number }).count, 1);
    assert.equal((relisted.structuredContent as { total: number }).total, 1);
    assert.equal((relisted.structuredContent as { has_more: boolean }).has_more, false);
  });

  it("reads full content by default and windows on request", async () => {
    const full = await callTool("diagrams_get", {
      relative_path: DIAGRAM_PATH,
    });
    assert.equal(full.isError, undefined);
    const fullStructured = full.structuredContent as {
      content: string;
      is_partial: boolean;
      offset: number;
      total_chars: number;
      returned_chars: number;
      has_more: boolean;
    };
    assert.equal(fullStructured.content, DIAGRAM_V1);
    assert.equal(fullStructured.is_partial, false);
    assert.equal(fullStructured.offset, 0);
    assert.equal(fullStructured.total_chars, DIAGRAM_V1.length);
    assert.equal(fullStructured.returned_chars, DIAGRAM_V1.length);
    assert.equal(fullStructured.has_more, false);

    const windowed = await callTool("diagrams_get", {
      relative_path: DIAGRAM_PATH,
      offset: 10,
      max_chars: 20,
    });
    assert.equal(windowed.isError, undefined);
    const windowedStructured = windowed.structuredContent as typeof fullStructured;
    assert.equal(windowedStructured.content, DIAGRAM_V1.slice(10, 30));
    assert.equal(textOf(windowed), DIAGRAM_V1.slice(10, 30));
    assert.equal(windowedStructured.is_partial, true);
    assert.equal(windowedStructured.offset, 10);
    assert.equal(windowedStructured.total_chars, DIAGRAM_V1.length);
    assert.equal(windowedStructured.returned_chars, 20);
    assert.equal(windowedStructured.has_more, true);
  });

  it("rejects oversized pagination and out-of-range windows with errors", async () => {
    const badPage = await callTool("diagrams_list", {
      type_filter: "all",
      limit: 1000000,
    });
    assert.equal(badPage.isError, true);
    assert.match(textOf(badPage), /limit|Invalid arguments/);

    const pastEnd = await callTool("diagrams_get", {
      relative_path: DIAGRAM_PATH,
      offset: DIAGRAM_V1.length + 100,
    });
    assert.equal(pastEnd.isError, true);
    assert.match(textOf(pastEnd), /out of range/);
  });

  it("returns an error for a missing diagram", async () => {
    const result = await callTool("diagrams_get", {
      relative_path: "models/missing.puml",
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /No diagram found at 'models\/missing\.puml'/);
  });

  it("rejects path traversal without writing outside DIAGRAMS_DIR", async () => {
    const created = await callTool("diagrams_create", {
      relative_path: "../escape.puml",
      content: DIAGRAM_V1,
    });
    assert.equal(created.isError, true);
    assert.match(textOf(created), /outside the diagrams root/);

    const read = await callTool("diagrams_get", {
      relative_path: "../escape.puml",
    });
    assert.equal(read.isError, true);
    assert.match(textOf(read), /outside the diagrams root/);

    await assert.rejects(fs.access(path.join(projectRoot, "escape.puml")));
    assert.equal(await fs.readFile(codeFixturePath, "utf-8"), CODE_FIXTURE);
  });

  it("updates the diagram content", async () => {
    const result = await callTool("diagrams_update", {
      relative_path: DIAGRAM_PATH,
      content: DIAGRAM_V2,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      relative_path: string;
      updated: boolean;
    };
    assert.equal(structured.relative_path, DIAGRAM_PATH);
    assertPosixPath(structured.relative_path, "updated relative_path");
    assert.equal(structured.updated, true);

    const reread = await callTool("diagrams_get", {
      relative_path: DIAGRAM_PATH,
    });
    assert.equal((reread.structuredContent as { content: string }).content, DIAGRAM_V2);
  });

  it("checks consistency against the codebase fixture", async () => {
    const result = await callTool("diagrams_check_consistency", {
      relative_path: DIAGRAM_PATH,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      diagram_path: string;
      entities_found: number;
      entities_matched: number;
      entities_unmatched: number;
      files_scanned: number;
      searched_directory: string;
      issues: Array<{ name: string }>;
      entities: string[];
      matched_entities: string[];
      unmatched_entities: string[];
      analyzers: {
        reliable: string[];
        experimental: string[];
        generic: string[];
      };
      confidence: string;
      heuristic_warning: string;
      evidence: Array<{
        name: string;
        matched: boolean;
        analyzers: string[];
        matched_files: string[];
        matched_file_count: number;
      }>;
    };
    assert.equal(structured.diagram_path, DIAGRAM_PATH);
    assertPosixPath(structured.diagram_path, "diagram_path");
    assert.equal(structured.entities_found, 2);
    assert.equal(structured.entities_matched, 1);
    assert.equal(structured.entities_unmatched, 1);
    assert.deepEqual(
      structured.issues.map((issue) => issue.name),
      ["GhostWidget"],
    );
    assert.ok(structured.files_scanned >= 1);
    assert.equal(structured.searched_directory, projectRoot);
    assert.deepEqual([...structured.entities].sort(), ["GhostWidget", "Widget"]);
    assert.deepEqual(structured.matched_entities, ["Widget"]);
    assert.deepEqual(structured.unmatched_entities, ["GhostWidget"]);
    assert.ok(structured.analyzers.reliable.includes(".ts"));
    assert.equal(structured.confidence, "heuristic");
    assert.match(structured.heuristic_warning, /heuristic/i);
    assert.equal(structured.evidence.length, 2);
    const widgetEvidence = structured.evidence.find((entry) => entry.name === "Widget");
    assert.ok(widgetEvidence);
    assert.equal(widgetEvidence.matched, true);
    assert.ok(widgetEvidence.matched_files.length >= 1);
    for (const matchedFile of widgetEvidence.matched_files) {
      assertPosixPath(matchedFile, "evidence matched_file");
    }
  });

  it("deletes the diagram and leaves the codebase fixture untouched", async () => {
    const result = await callTool("diagrams_delete", {
      relative_path: DIAGRAM_PATH,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      relative_path: string;
      deleted: boolean;
    };
    assert.equal(structured.relative_path, DIAGRAM_PATH);
    assertPosixPath(structured.relative_path, "deleted relative_path");
    assert.equal(structured.deleted, true);

    const relisted = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((relisted.structuredContent as { count: number }).count, 0);

    const reread = await callTool("diagrams_get", {
      relative_path: DIAGRAM_PATH,
    });
    assert.equal(reread.isError, true);

    assert.equal(await fs.readFile(codeFixturePath, "utf-8"), CODE_FIXTURE);
  });
});

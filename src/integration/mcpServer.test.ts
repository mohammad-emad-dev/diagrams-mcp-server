import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  "diagrams_diff",
  "diagrams_export",
  "diagrams_generate",
  "diagrams_generate_sequence",
  "diagrams_get",
  "diagrams_list",
  "diagrams_list_templates",
  "diagrams_render",
  "diagrams_scaffold",
  "diagrams_template",
  "diagrams_update",
];

const DIAGRAM_PATH = "models/widget.puml";
const DIAGRAM_V1 =
  "@startuml\ntitle Widget Model\nclass Widget {\n  +id: int\n}\nclass GhostWidget {\n  +id: int\n}\n@enduml\n";
const DIAGRAM_V2 =
  "@startuml\ntitle Widget Model\nclass Widget {\n  +id: int\n  +label: string\n}\nclass GhostWidget {\n  +id: int\n}\n@enduml\n";
const CODE_FIXTURE = "export class Widget {\n  id: number;\n}\n";

// A second, separate code fixture: the sequence tool needs a caller and a
// callee in different files, but the class-diagram test above asserts
// files_scanned === 1 on src-code, so the pair lives in its own directory.
const SEQUENCE_CALLER =
  "import { charge } from './payment.js';\n\nexport function checkout() {\n  charge();\n}\n";
const SEQUENCE_CALLEE = "export function charge() {\n  return 1;\n}\n";

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

/** Environment for a server rooted at `root`: the one way this file spawns one. */
function serverEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.PROJECT_ROOT = root;
  env.DIAGRAMS_DIR = "diagrams";
  // Belt-and-braces: render is discovery-only here, never networked.
  env.DISABLE_REMOTE_PLANTUML = "true";
  return env;
}

/** Spawn the compiled server against `root` and return a connected client. */
async function connectServer(root: string): Promise<Client> {
  const serverPath = path.join(process.cwd(), "dist", "index.js");
  await fs.access(serverPath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: serverEnv(root),
  });
  const connected = new Client({
    name: "diagrams-mcp-integration-test",
    version: "0.1.0",
  });
  await connected.connect(transport);
  return connected;
}

describe("MCP stdio integration (dist/index.js)", () => {
  let projectRoot = "";
  let diagramsDir = "";
  let codeFixturePath = "";
  let sequenceCallerPath = "";
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

    sequenceCallerPath = path.join(projectRoot, "src-sequence", "checkout.ts");
    const sequenceCalleePath = path.join(projectRoot, "src-sequence", "payment.ts");
    await fs.mkdir(path.dirname(sequenceCallerPath), { recursive: true });
    await fs.writeFile(sequenceCallerPath, SEQUENCE_CALLER, "utf-8");
    await fs.writeFile(sequenceCalleePath, SEQUENCE_CALLEE, "utf-8");

    client = await connectServer(projectRoot);
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

  it("discovers all 14 tools", async () => {
    const { tools } = await getClient().listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  });

  it("advertises the package.json version over stdio", async () => {
    const raw = await fs.readFile(new URL("../../package.json", import.meta.url), "utf-8");
    const expected = (JSON.parse(raw) as { version: string }).version;
    assert.equal(typeof expected, "string");
    assert.equal(getClient().getServerVersion()?.version, expected);
  });

  it("prints the package.json version in the setup banner", async () => {
    const raw = await fs.readFile(new URL("../../package.json", import.meta.url), "utf-8");
    const expected = (JSON.parse(raw) as { version: string }).version;
    assert.equal(typeof expected, "string");
    const setup = spawnSync(
      process.execPath,
      ["dist/index.js", "setup", "--client", "version-check-invalid", "--yes"],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    assert.equal(setup.status, 1);
    assert.match(setup.stderr, /Unknown client 'version-check-invalid'/);
    assert.ok(setup.stdout.includes(`v${expected}`));
  });

  it("loads a project-local custom template over real stdio", async () => {
    const directory = path.join(projectRoot, ".diagrams-templates");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "team-model.json"),
      JSON.stringify({
        puml: {
          source: "@startuml\ntitle {{title}}\n{{entities}}\n@enduml\n",
          entity: "class {{name}}",
        },
      }),
    );
    const result = await callTool("diagrams_template", {
      template: "custom",
      custom_template: "team-model",
      title: "Team Model",
      entities: ["Widget"],
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.custom_template, "team-model");
    assert.equal(result.structuredContent?.written, false);
    assert.equal(textOf(result), "@startuml\ntitle Team Model\nclass Widget\n@enduml\n");
  });

  it("lists built-in and custom template candidates over real stdio", async () => {
    const result = await callTool("diagrams_list_templates", {});

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      built_in: Array<{ template: string; formats: string[] }>;
      custom: Array<{ template: string; custom_template: string; relative_path: string }>;
      custom_count: number;
      entries_scanned: number;
      scan_limit: number;
      truncated: boolean;
      scan_warning: string | null;
      written: boolean;
    };
    assert.deepEqual(
      structured.built_in.map((entry) => entry.template),
      ["class", "sequence", "c4_context"],
    );
    for (const entry of structured.built_in) {
      assert.deepEqual(entry.formats, ["puml", "mermaid"]);
    }
    assert.ok(
      structured.custom.some((entry) => entry.custom_template === "team-model"),
      "the team-model fixture must appear as a candidate",
    );
    const teamModel = structured.custom.find((entry) => entry.custom_template === "team-model");
    assert.equal(teamModel?.template, "custom");
    assert.equal(teamModel?.relative_path, ".diagrams-templates/team-model.json");
    assertPosixPath(teamModel?.relative_path ?? "", "custom relative_path");
    assert.equal(structured.custom_count, structured.custom.length);
    assert.equal(structured.scan_limit, 1000);
    assert.equal(structured.truncated, false);
    assert.equal(structured.scan_warning, null);
    assert.equal(structured.written, false);
    assert.ok(textOf(result).includes("team-model"));
    assert.ok(textOf(result).includes("class"));
  });

  it("rejects unknown template discovery arguments over real stdio", async () => {
    const result = await callTool("diagrams_list_templates", { output_dir: "elsewhere" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /output_dir/);
  });

  it("compares recognized call order only when requested over real stdio", async () => {
    const a =
      "@startuml\nparticipant A\nparticipant B\nA -> B: charge()\nA -> B: refund()\n@enduml\n";
    const b = "sequenceDiagram\nparticipant A\nparticipant B\nA->>B: refund()\nA->>B: charge()\n";
    const defaultResult = await callTool("diagrams_diff", { a_content: a, b_content: b });
    assert.equal(defaultResult.isError, undefined);
    assert.equal(defaultResult.structuredContent?.is_same, true);
    assert.equal(Object.hasOwn(defaultResult.structuredContent ?? {}, "call_order"), false);
    const orderedResult = await callTool("diagrams_diff", {
      a_content: a,
      b_content: b,
      compare_call_order: true,
    });
    assert.equal(orderedResult.isError, undefined);
    assert.equal(orderedResult.structuredContent?.is_same, false);
    assert.deepEqual(orderedResult.structuredContent?.call_order, {
      a: ["charge", "refund"],
      b: ["refund", "charge"],
      changed: true,
    });
    assert.match(textOf(orderedResult), /message-call order changed/);
    const invalid = await callTool("diagrams_diff", {
      a_content: a,
      b_content: b,
      compare_call_order: "true",
    });
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /compare_call_order/);
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

  it("generates a class diagram from the codebase fixture", async () => {
    const result = await callTool("diagrams_generate", { scope: "src-code" });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      scope: string;
      format: string;
      source: string;
      entities: string[];
      entities_included: number;
      entities_available: number;
      entities_capped: boolean;
      entity_limit: number;
      relations: unknown[];
      files_scanned: number;
      truncated: boolean;
      scan_limit: number;
      scan_warning: string | null;
      dialect_note: string | null;
      confidence: string;
      heuristic_warning: string;
      written: boolean;
    };
    assertPosixPath(structured.scope, "generated scope");
    assert.equal(structured.scope, "src-code");
    assert.equal(structured.format, "puml");
    assert.ok(
      structured.entities.includes("Widget"),
      `entities: ${JSON.stringify(structured.entities)}`,
    );
    assert.equal(structured.entities_included, structured.entities.length);
    assert.equal(structured.entities_available, structured.entities.length);
    assert.equal(structured.entities_capped, false);
    assert.equal(structured.entity_limit, 30);
    assert.equal(structured.confidence, "heuristic");
    assert.equal(structured.written, false);
    assert.equal(structured.files_scanned, 1);
    assert.equal(structured.truncated, false);
    assert.equal(structured.scan_limit, 5000);
    assert.equal(structured.scan_warning, null);
    assert.ok(structured.heuristic_warning.length > 0);
    // The text block is the generated source itself.
    assert.equal(textOf(result), structured.source);
    assert.ok(textOf(result).includes("class Widget"));
    // Read-only: the code fixture is untouched and no diagram was written.
    assert.equal(await fs.readFile(codeFixturePath, "utf-8"), CODE_FIXTURE);
    const stored = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((stored.structuredContent as { count: number }).count, 1);
  });

  it("generates a sequence diagram from the two-file call flow", async () => {
    // Snapshot the diagram count first: generation is read-only, so the
    // sequence tool must not add anything to the diagrams directory.
    const before = await callTool("diagrams_list", { type_filter: "all" });
    const beforeCount = (before.structuredContent as { count: number }).count;

    const result = await callTool("diagrams_generate_sequence", { scope: "src-sequence" });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      scope: string;
      format: string;
      source: string;
      participants: string[];
      participants_included: number;
      participants_available: number;
      participants_capped: boolean;
      participant_limit: number;
      messages: Array<{
        from: string;
        to: string;
        message: string;
        line: number;
        via_callback: boolean;
      }>;
      messages_included: number;
      messages_available: number;
      messages_capped: boolean;
      message_limit: number;
      deferred_count: number;
      unresolved_callees: string[];
      files_scanned: number;
      truncated: boolean;
      scan_limit: number;
      scan_warning: string | null;
      confidence: string;
      heuristic_warning: string;
      written: boolean;
    };
    assertPosixPath(structured.scope, "generated sequence scope");
    assert.equal(structured.scope, "src-sequence");
    assert.equal(structured.format, "puml");
    assert.equal(structured.files_scanned, 2);
    assert.equal(structured.deferred_count, 0);
    assert.deepEqual(structured.unresolved_callees, []);
    assert.equal(structured.confidence, "heuristic");
    assert.equal(structured.written, false);
    assert.ok(structured.heuristic_warning.length > 0);
    assert.ok(
      structured.heuristic_warning.includes("not runtime order"),
      "the warning must say static order is not runtime order",
    );

    // The conversation: checkout calls charge, which payment.ts declares.
    assert.ok(structured.participants.length > 0, "participants must not be empty");
    assert.equal(structured.participants_included, structured.participants.length);
    assert.equal(structured.participants_available, structured.participants.length);
    assert.equal(structured.participants_capped, false);
    assert.equal(structured.participant_limit, 8);
    assert.equal(structured.messages.length, 1);
    assert.equal(structured.messages_included, 1);
    assert.equal(structured.messages_available, 1);
    assert.equal(structured.messages_capped, false);
    assert.equal(structured.message_limit, 20);
    const first = structured.messages[0];
    assert.ok(
      structured.participants.includes(first.from),
      `from '${first.from}' must be a declared participant`,
    );
    assert.ok(
      structured.participants.includes(first.to),
      `to '${first.to}' must be a declared participant`,
    );
    assert.equal(first.message, "charge");
    assert.equal(first.via_callback, false);

    // The text block is the emitted source, and it carries the same message.
    assert.equal(textOf(result), structured.source);
    assert.ok(textOf(result).includes("@startuml"));
    assert.ok(textOf(result).includes(`${first.from} -> ${first.to} : charge`));

    // Read-only: nothing was written and the fixtures are untouched.
    const after = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((after.structuredContent as { count: number }).count, beforeCount);
    assert.equal(await fs.readFile(sequenceCallerPath, "utf-8"), SEQUENCE_CALLER);
  });

  it("generates call labels recognized by consistency and cross-format diffs over stdio", async () => {
    const sources: string[] = [];
    for (const format of ["puml", "mermaid"] as const) {
      const generated = await callTool("diagrams_generate_sequence", {
        scope: "src-sequence",
        format,
        include_call_parentheses: true,
      });
      assert.equal(generated.isError, undefined);
      const source = generated.structuredContent?.source as string;
      assert.equal(textOf(generated), source);
      assert.match(source, /: charge\(\)/);
      const messages = generated.structuredContent?.messages as Array<{ message: string }>;
      assert.deepEqual(
        messages.map((message) => message.message),
        ["charge"],
      );
      sources.push(source);

      const relativePath = `models/generated-call-labels.${format === "puml" ? "puml" : "mmd"}`;
      const created = await callTool("diagrams_create", {
        relative_path: relativePath,
        content: source,
      });
      assert.equal(created.isError, undefined);
      try {
        const checked = await callTool("diagrams_check_consistency", {
          relative_path: relativePath,
        });
        assert.equal(checked.isError, undefined);
        assert.ok((checked.structuredContent?.matched_entities as string[]).includes("charge"));
      } finally {
        const deleted = await callTool("diagrams_delete", { relative_path: relativePath });
        assert.equal(deleted.isError, undefined);
      }
    }
    const compared = await callTool("diagrams_diff", {
      a_content: sources[0],
      b_content: sources[1],
      compare_call_order: true,
    });
    assert.equal(compared.isError, undefined);
    assert.deepEqual(compared.structuredContent?.call_order, {
      a: ["charge"],
      b: ["charge"],
      changed: false,
    });
  });

  it("diffs a stored diagram against inline previous-version text", async () => {
    // Create, update, then diff: the stored v2 gains a whole class, which is
    // the level the tool compares (members are out of scope), so the diff of
    // the stored v2 against v1 as inline text must surface it as added.
    const diffPath = "models/diff-demo.puml";
    const diffV1 = "@startuml\nclass Widget\nclass GhostWidget\n@enduml\n";
    const diffV2 = "@startuml\nclass Widget\nclass GhostWidget\nclass Invoice\n@enduml\n";
    await callTool("diagrams_create", { relative_path: diffPath, content: diffV1 });
    await callTool("diagrams_update", { relative_path: diffPath, content: diffV2 });

    const result = await callTool("diagrams_diff", {
      a_content: diffV1,
      b_relative_path: diffPath,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      a: { source: string; type: string };
      b: { source: string; type: string };
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
      renamed: Array<{ from: string; to: string; confidence: string }>;
      unchanged: string[];
      unchanged_count: number;
      participants_added: string[];
      calls_added: string[];
      is_same: boolean;
      confidence: string;
      heuristic_warning: string;
    };
    assert.equal(structured.a.source, "<inline>");
    assert.equal(structured.a.type, "plantuml");
    assert.equal(structured.b.source, diffPath);
    assertPosixPath(structured.b.source, "diff b source");
    assert.deepEqual(structured.added, [{ name: "Invoice" }]);
    assert.deepEqual(structured.removed, []);
    assert.deepEqual(structured.renamed, []);
    assert.deepEqual(structured.unchanged, ["Widget", "GhostWidget"]);
    assert.equal(structured.unchanged_count, 2);
    assert.deepEqual(structured.participants_added, []);
    assert.deepEqual(structured.calls_added, []);
    assert.equal(structured.is_same, false);
    assert.equal(structured.confidence, "heuristic");
    assert.ok(structured.heuristic_warning.length > 0);
    assert.ok(textOf(result).includes("Invoice"));

    await callTool("diagrams_delete", { relative_path: diffPath });
  });

  it("reports a member-only change as identical because members are out of scope", async () => {
    // DIAGRAM_PATH holds V2 at this point; V1 differs from it only by one
    // member line. The diff compares declared names, so it reports no change.
    const result = await callTool("diagrams_diff", {
      a_content: DIAGRAM_V1,
      b_relative_path: DIAGRAM_PATH,
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      added: unknown[];
      removed: unknown[];
      renamed: unknown[];
      is_same: boolean;
    };
    assert.deepEqual(structured.added, []);
    assert.deepEqual(structured.removed, []);
    assert.deepEqual(structured.renamed, []);
    assert.equal(structured.is_same, true);
    assert.match(textOf(result), /No differences/i);
  });

  it("rejects diagrams_diff sides that supply neither path nor content", async () => {
    const result = await callTool("diagrams_diff", {});

    assert.equal(result.isError, true);
    assert.match(textOf(result), /side 'a'/);
    assert.match(textOf(result), /side 'b'/);
  });

  it("hands a template skeleton straight to create and gets it back unchanged", async () => {
    // Snapshot first: the template tool is read-only, so nothing lands in the
    // diagrams directory until the explicit create below.
    const before = await callTool("diagrams_list", { type_filter: "all" });
    const beforeCount = (before.structuredContent as { count: number }).count;

    const templatePath = "models/template-demo.puml";
    const templated = await callTool("diagrams_template", {
      template: "class",
      format: "puml",
      title: "Template Demo",
      entities: ["User", "Order"],
    });

    assert.equal(templated.isError, undefined);
    const structured = templated.structuredContent as {
      template: string;
      format: string;
      title: string | null;
      source: string;
      entities: string[];
      entities_included: number;
      deterministic: boolean;
      written: boolean;
    };
    assert.equal(structured.template, "class");
    assert.equal(structured.format, "puml");
    assert.equal(structured.title, "Template Demo");
    assert.deepEqual(structured.entities, ["User", "Order"]);
    assert.equal(structured.entities_included, 2);
    assert.equal(structured.deterministic, true);
    assert.equal(structured.written, false);
    // The text block is the skeleton itself.
    assert.equal(textOf(templated), structured.source);

    // The emitted source clears the gate create enforces, so it saves as-is.
    const created = await callTool("diagrams_create", {
      relative_path: templatePath,
      content: structured.source,
    });
    assert.equal(created.isError, undefined);

    // And reads back byte for byte: the template-to-store handoff round-trips.
    const read = await callTool("diagrams_get", { relative_path: templatePath });
    assert.equal(read.isError, undefined);
    assert.equal((read.structuredContent as { content: string }).content, structured.source);
    assert.equal(textOf(read), structured.source);

    await callTool("diagrams_delete", { relative_path: templatePath });
    const after = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((after.structuredContent as { count: number }).count, beforeCount);
  });

  it("returns byte-identical source for identical inputs across separate server processes", async () => {
    const args = {
      template: "sequence",
      format: "mermaid",
      title: "Demo",
      entities: ["Checkout", "Payment"],
    };
    const first = await callTool("diagrams_template", args);
    assert.equal(first.isError, undefined);
    const firstSource = (first.structuredContent as { source: string }).source;

    // A second, separately spawned server over the same project root: no state
    // is carried between the two, so identical inputs must replay exactly.
    const secondClient = await connectServer(projectRoot);
    try {
      const raw = (await secondClient.callTool({
        name: "diagrams_template",
        arguments: args,
      })) as unknown as McpToolResult;
      assert.equal(raw.isError, undefined);
      assert.equal(
        (raw.structuredContent as { source: string }).source,
        firstSource,
        "two processes must emit byte-identical source for the same inputs",
      );
    } finally {
      await secondClient.close();
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

  it("rejects unknown create/update/delete arguments without mutating diagrams", async () => {
    const guardPath = "models/strict-guard.puml";
    const blockedCreatePath = "models/strict-create-blocked.puml";
    const beforeList = await callTool("diagrams_list", { type_filter: "all" });
    const beforeCount = (beforeList.structuredContent as { count: number }).count;

    const badCreate = await callTool("diagrams_create", {
      relative_path: blockedCreatePath,
      content: DIAGRAM_V1,
      bogus_unknown_field: "boom",
    });
    assert.equal(badCreate.isError, true);
    assert.match(textOf(badCreate), /bogus_unknown_field/);
    assert.ok(!textOf(badCreate).includes(projectRoot));
    assert.ok(!textOf(badCreate).includes(DIAGRAM_V1));
    await assert.rejects(
      fs.access(path.join(diagramsDir, "models", "strict-create-blocked.puml")),
      { code: "ENOENT" },
    );
    const afterBadCreate = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((afterBadCreate.structuredContent as { count: number }).count, beforeCount);

    const created = await callTool("diagrams_create", {
      relative_path: guardPath,
      content: DIAGRAM_V1,
    });
    assert.equal(created.isError, undefined);

    const badUpdate = await callTool("diagrams_update", {
      relative_path: guardPath,
      content: DIAGRAM_V2,
      bogus_unknown_field: "boom",
    });
    assert.equal(badUpdate.isError, true);
    assert.match(textOf(badUpdate), /bogus_unknown_field/);
    assert.ok(!textOf(badUpdate).includes(projectRoot));
    assert.ok(!textOf(badUpdate).includes(DIAGRAM_V1));
    assert.ok(!textOf(badUpdate).includes(DIAGRAM_V2));
    const reread = await callTool("diagrams_get", { relative_path: guardPath });
    assert.equal(reread.isError, undefined);
    assert.equal((reread.structuredContent as { content: string }).content, DIAGRAM_V1);

    const badDelete = await callTool("diagrams_delete", {
      relative_path: guardPath,
      bogus_unknown_field: "boom",
    });
    assert.equal(badDelete.isError, true);
    assert.match(textOf(badDelete), /bogus_unknown_field/);
    assert.ok(!textOf(badDelete).includes(projectRoot));
    const stillThere = await callTool("diagrams_get", { relative_path: guardPath });
    assert.equal(stillThere.isError, undefined);

    const cleaned = await callTool("diagrams_delete", { relative_path: guardPath });
    assert.equal(cleaned.isError, undefined);
    const finalList = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((finalList.structuredContent as { count: number }).count, beforeCount);
  });

  it("rejects unknown arguments for read-only discovery tools", async () => {
    const fixture = "models/strict-read.puml";
    const created = await callTool("diagrams_create", {
      relative_path: fixture,
      content: DIAGRAM_V1,
    });
    assert.equal(created.isError, undefined);
    try {
      const badList = await callTool("diagrams_list", {
        type_filter: "all",
        bogus_unknown_field: "boom",
      });
      assert.equal(badList.isError, true);
      assert.match(textOf(badList), /bogus_unknown_field/);
      assert.ok(!textOf(badList).includes(projectRoot));

      const badGet = await callTool("diagrams_get", {
        relative_path: fixture,
        bogus_unknown_field: "boom",
      });
      assert.equal(badGet.isError, true);
      assert.match(textOf(badGet), /bogus_unknown_field/);
      assert.ok(!textOf(badGet).includes(projectRoot));
      assert.ok(!textOf(badGet).includes(DIAGRAM_V1));

      const badTemplates = await callTool("diagrams_list_templates", {
        bogus_unknown_field: "boom",
      });
      assert.equal(badTemplates.isError, true);
      assert.match(textOf(badTemplates), /bogus_unknown_field/);
      assert.ok(!textOf(badTemplates).includes(projectRoot));

      const badConsistency = await callTool("diagrams_check_consistency", {
        relative_path: fixture,
        bogus_unknown_field: "boom",
      });
      assert.equal(badConsistency.isError, true);
      assert.match(textOf(badConsistency), /bogus_unknown_field/);
      assert.ok(!textOf(badConsistency).includes(projectRoot));

      const listDefault = await callTool("diagrams_list", {});
      assert.equal(listDefault.isError, undefined);
      assert.equal((listDefault.structuredContent as { count: number }).count, 1);

      const getDefault = await callTool("diagrams_get", { relative_path: fixture });
      assert.equal(getDefault.isError, undefined);
      assert.equal((getDefault.structuredContent as { content: string }).content, DIAGRAM_V1);
    } finally {
      await callTool("diagrams_delete", { relative_path: fixture });
    }
  });

  it("rejects unknown arguments for generation, template, and diff tools", async () => {
    const diffPath = "models/strict-diff.puml";
    const created = await callTool("diagrams_create", {
      relative_path: diffPath,
      content: DIAGRAM_V1,
    });
    assert.equal(created.isError, undefined);
    try {
      const before = await callTool("diagrams_list", { type_filter: "all" });
      const beforeCount = (before.structuredContent as { count: number }).count;

      const badGenerate = await callTool("diagrams_generate", {
        scope: "src-code",
        bogus_unknown_field: "boom",
      });
      assert.equal(badGenerate.isError, true);
      assert.match(textOf(badGenerate), /bogus_unknown_field/);
      assert.ok(!textOf(badGenerate).includes(projectRoot));

      const badSequence = await callTool("diagrams_generate_sequence", {
        scope: "src-sequence",
        bogus_unknown_field: "boom",
      });
      assert.equal(badSequence.isError, true);
      assert.match(textOf(badSequence), /bogus_unknown_field/);
      assert.ok(!textOf(badSequence).includes(projectRoot));

      const badTemplate = await callTool("diagrams_template", {
        template: "class",
        entities: ["User"],
        bogus_unknown_field: "boom",
      });
      assert.equal(badTemplate.isError, true);
      assert.match(textOf(badTemplate), /bogus_unknown_field/);
      assert.ok(!textOf(badTemplate).includes(projectRoot));

      const badDiff = await callTool("diagrams_diff", {
        a_content: DIAGRAM_V1,
        b_relative_path: diffPath,
        bogus_unknown_field: "boom",
      });
      assert.equal(badDiff.isError, true);
      assert.match(textOf(badDiff), /bogus_unknown_field/);
      assert.ok(!textOf(badDiff).includes(projectRoot));
      assert.ok(!textOf(badDiff).includes(DIAGRAM_V1));

      const after = await callTool("diagrams_list", { type_filter: "all" });
      assert.equal((after.structuredContent as { count: number }).count, beforeCount);

      const templated = await callTool("diagrams_template", {
        template: "class",
        entities: ["User"],
      });
      assert.equal(templated.isError, undefined);
      assert.equal((templated.structuredContent as { format: string }).format, "puml");
    } finally {
      await callTool("diagrams_delete", { relative_path: diffPath });
    }
  });

  it("rejects unknown render/export arguments before renderer invocation", async () => {
    const fixture = "models/strict-render.puml";
    const created = await callTool("diagrams_create", {
      relative_path: fixture,
      content: DIAGRAM_V1,
    });
    assert.equal(created.isError, undefined);
    try {
      const badRender = await callTool("diagrams_render", {
        relative_path: fixture,
        format: "svg",
        bogus_unknown_field: "boom",
      });
      assert.equal(badRender.isError, true);
      assert.match(textOf(badRender), /bogus_unknown_field/);
      assert.ok(!textOf(badRender).includes(projectRoot));
      assert.ok(!textOf(badRender).includes(DIAGRAM_V1));
      assert.ok(!/mmdc|plantuml|rendering requires/i.test(textOf(badRender)));

      const badExport = await callTool("diagrams_export", {
        relative_path: fixture,
        bogus_unknown_field: "boom",
      });
      assert.equal(badExport.isError, true);
      assert.match(textOf(badExport), /bogus_unknown_field/);
      assert.ok(!textOf(badExport).includes(projectRoot));
      assert.ok(!textOf(badExport).includes(DIAGRAM_V1));
      assert.ok(!/mmdc|plantuml|rendering requires/i.test(textOf(badExport)));
    } finally {
      await callTool("diagrams_delete", { relative_path: fixture });
    }
    const relisted = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((relisted.structuredContent as { count: number }).count, 0);
  });

  it("recognizes short operation names in consistency and call-order comparison over stdio", async () => {
    const directory = path.join(projectRoot, "src-short-calls");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "operations.js"),
      "export class A {}\nexport class B {}\nexport function f() {}\n",
      "utf-8",
    );
    const a =
      "@startuml\nparticipant A\nparticipant B\n' A -> B: lineGhost()\n" +
      "/'\nA -> B: blockGhost()\n'/\nA -> B: f()\nA -> B: g()\n@enduml\n";
    const b =
      "sequenceDiagram\nparticipant A\nparticipant B\n%% A->>B: mermaidGhost()\n" +
      "A->>B: g()\nA->>B: f()\n";
    const relativePath = "models/short-calls.puml";
    const created = await callTool("diagrams_create", { relative_path: relativePath, content: a });
    assert.equal(created.isError, undefined);
    const checked = await callTool("diagrams_check_consistency", { relative_path: relativePath });
    assert.equal(checked.isError, undefined);
    const matched = checked.structuredContent?.matched_entities as string[];
    const unmatched = checked.structuredContent?.unmatched_entities as string[];
    assert.ok(matched.includes("f"));
    assert.ok(unmatched.includes("g"));
    assert.ok(!unmatched.includes("lineGhost"));
    assert.ok(!unmatched.includes("blockGhost"));
    const compared = await callTool("diagrams_diff", {
      a_content: a,
      b_content: b,
      compare_call_order: true,
    });
    assert.equal(compared.isError, undefined);
    assert.deepEqual(compared.structuredContent?.call_order, {
      a: ["f", "g"],
      b: ["g", "f"],
      changed: true,
    });
    const deleted = await callTool("diagrams_delete", { relative_path: relativePath });
    assert.equal(deleted.isError, undefined);
  });

  it("scaffolds TypeScript classes from a stored diagram over real stdio", async () => {
    const before = await callTool("diagrams_list", { type_filter: "all" });
    const beforeCount = (before.structuredContent as { count: number }).count;
    const relativePath = "models/scaffold-demo.puml";
    const content = "@startuml\nclass User\nclass Order\nclass class\n@enduml\n";
    const created = await callTool("diagrams_create", { relative_path: relativePath, content });
    assert.equal(created.isError, undefined);
    try {
      const result = await callTool("diagrams_scaffold", { relative_path: relativePath });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
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
      };
      assert.equal(structured.relative_path, relativePath);
      assertPosixPath(structured.relative_path, "scaffold relative_path");
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
      assert.match(structured.heuristic_warning, /does NOT recover|does not recover/i);
      assert.equal(structured.written, false);
      assert.equal(textOf(result), structured.source);
      assert.equal(structured.source, "export class User {}\n\nexport class Order {}\n");

      const after = await callTool("diagrams_list", { type_filter: "all" });
      assert.equal((after.structuredContent as { count: number }).count, beforeCount + 1);
    } finally {
      const deleted = await callTool("diagrams_delete", { relative_path: relativePath });
      assert.equal(deleted.isError, undefined);
    }
    const relisted = await callTool("diagrams_list", { type_filter: "all" });
    assert.equal((relisted.structuredContent as { count: number }).count, beforeCount);
  });

  it("rejects unknown scaffold arguments and missing/traversal paths over real stdio", async () => {
    const bad = await callTool("diagrams_scaffold", {
      relative_path: "models/scaffold-demo.puml",
      output_dir: "elsewhere",
    });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /output_dir/);
    assert.ok(!textOf(bad).includes(projectRoot));

    const missing = await callTool("diagrams_scaffold", {
      relative_path: "models/scaffold-missing.puml",
    });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /No diagram found at 'models\/scaffold-missing\.puml'/);

    const traversal = await callTool("diagrams_scaffold", { relative_path: "../escape.puml" });
    assert.equal(traversal.isError, true);
    assert.match(textOf(traversal), /outside the diagrams root/);
    assert.ok(!textOf(traversal).includes(projectRoot));
  });
});

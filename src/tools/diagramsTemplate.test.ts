import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { DiagramStore } from "../services/diagramStore.js";
import { validateDiagramSource } from "../services/diagramValidator.js";
import { diagramsTemplateInputSchema, registerDiagramsTemplate } from "./diagramsTemplate.js";

// The tool is read-only and touches no filesystem: this snapshot proves no file
// appears under the project root (or the diagrams root) as a result of a call.
async function listAllFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  let entries: Dirent[];
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

interface CapturedToolResult {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

function captureTool(
  register: (server: McpServer, ctx: ServerContext) => void,
  ctx: ServerContext,
): { handler: CapturedToolHandler } {
  const captured = {} as { handler: CapturedToolHandler };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx);
  return captured;
}

/**
 * Call a captured handler the way the server does: the SDK runs safeParse on
 * the input schema first, which is what applies the documented default format.
 */
async function callHandler(
  tool: { handler: CapturedToolHandler },
  args: Record<string, unknown>,
): Promise<CapturedToolResult> {
  const parsed = diagramsTemplateInputSchema.safeParse(args);
  assert.equal(parsed.success, true, `unexpected rejection of ${JSON.stringify(args)}`);
  return tool.handler(parsed.data);
}

interface TemplateOutput {
  template: string;
  format: string;
  title: string | null;
  source: string;
  entities: string[];
  entities_included: number;
  deterministic: boolean;
  written: boolean;
}

/** Typed view of a successful result's structuredContent. */
function structuredOf(result: CapturedToolResult): TemplateOutput {
  assert.ok(result.structuredContent, "a successful call must carry structuredContent");
  return result.structuredContent as unknown as TemplateOutput;
}

/** The diagram type the store uses for a wire dialect. */
function typeFor(format: "puml" | "mermaid"): "plantuml" | "mermaid" {
  return format === "puml" ? "plantuml" : "mermaid";
}

/** The exact declaration line a (template, format) pair emits for one entity. */
function declarationFor(kind: string, format: "puml" | "mermaid", name: string): string {
  if (kind === "class") return `class ${name}`;
  if (kind === "sequence") return `participant ${name}`;
  // PlantUML has no built-in C4 shape without a stdlib fetch, so it stays
  // self-contained; Mermaid ships C4 natively and names the alias and label.
  return format === "puml" ? `rectangle ${name}` : `System(${name}, "${name}")`;
}

const FORMATS = ["puml", "mermaid"] as const;
const KINDS = ["class", "sequence", "c4_context"] as const;

// A 61-character name and a 201-character title: one past each ceiling.
const OVERLONG_NAME = "A".repeat(61);
const OVERLONG_TITLE = "T".repeat(201);

describe("diagrams_template", () => {
  let projectRoot: string;
  let ctx: ServerContext;
  let filesBefore: Set<string>;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "template-tool-"));
    ctx = {
      diagramStore: new DiagramStore(path.join(projectRoot, "diagrams")),
      codeRootDir: projectRoot,
    };
    filesBefore = new Set(await listAllFiles(projectRoot));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("registers read-only, non-destructive, idempotent, and closed-world", () => {
    const captured = {} as {
      name: string;
      config: {
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
          openWorldHint?: boolean;
        };
      };
    };
    const fakeServer = {
      registerTool: (name: string, config: unknown): void => {
        captured.name = name;
        captured.config = config as (typeof captured)["config"];
      },
    } as unknown as McpServer;
    registerDiagramsTemplate(fakeServer);

    assert.equal(captured.name, "diagrams_template");
    assert.equal(captured.config.annotations?.readOnlyHint, true);
    assert.equal(captured.config.annotations?.destructiveHint, false);
    assert.equal(captured.config.annotations?.idempotentHint, true);
    assert.equal(captured.config.annotations?.openWorldHint, false);
  });

  // The acceptance table: every (template, format) pair must emit source that
  // clears the exact gate diagrams_create applies, report the skeleton as both
  // the text block and structuredContent.source, and stay deterministic.
  for (const kind of KINDS) {
    for (const format of FORMATS) {
      it(`emits a valid ${kind} skeleton in ${format}`, async () => {
        const tool = captureTool(registerDiagramsTemplate, ctx);
        const result = await callHandler(tool, {
          template: kind,
          format,
          title: "Demo",
          entities: ["User", "Order"],
        });
        const structured = structuredOf(result);

        assert.equal(result.isError, undefined);
        assert.equal(structured.template, kind);
        assert.equal(structured.format, format);
        assert.equal(structured.title, "Demo");
        assert.deepEqual(structured.entities, ["User", "Order"]);
        assert.equal(structured.entities_included, 2);
        assert.equal(structured.deterministic, true);
        assert.equal(structured.written, false);
        // The text block is the skeleton itself, byte for byte.
        assert.equal(result.content[0].text, structured.source);
        validateDiagramSource(structured.source, typeFor(format));
        // One declaration line per entity, in the dialect's own syntax.
        for (const name of ["User", "Order"]) {
          assert.ok(
            structured.source.split("\n").includes(declarationFor(kind, format, name)),
            `${kind}/${format} must declare ${name} as '${declarationFor(kind, format, name)}'`,
          );
        }
        // The dialect-correct title form, not the raw input.
        const titleLine = format === "puml" ? "title Demo" : "%% title: Demo";
        assert.ok(
          structured.source.split("\n").includes(titleLine),
          `${kind}/${format} must emit the title as '${titleLine}'`,
        );
      });
    }
  }

  it("defaults to PlantUML when format is omitted", async () => {
    const tool = captureTool(registerDiagramsTemplate, ctx);
    const result = await callHandler(tool, { template: "class", entities: ["User"] });
    const structured = structuredOf(result);

    assert.equal(structured.format, "puml");
    assert.ok(structured.source.startsWith("@startuml\n"), "the default dialect is PlantUML");
    assert.ok(structured.source.trimEnd().endsWith("@enduml"));
  });

  it("omits the title from source and structuredContent when none is given", async () => {
    const tool = captureTool(registerDiagramsTemplate, ctx);
    const result = await callHandler(tool, { template: "sequence", entities: ["User"] });
    const structured = structuredOf(result);

    assert.equal(structured.title, null);
    assert.ok(
      !/^title /m.test(structured.source) && !/^%% title:/m.test(structured.source),
      "no title line may be emitted when none was requested",
    );
    validateDiagramSource(structured.source, "plantuml");
  });

  it("collapses a multi-line title to one dialect-correct line", async () => {
    const tool = captureTool(registerDiagramsTemplate, ctx);
    const result = await callHandler(tool, {
      template: "c4_context",
      format: "mermaid",
      title: "  Order\n  Processing  ",
      entities: ["Order"],
    });
    const structured = structuredOf(result);

    // A normalized single line is what both the source and the report carry.
    assert.equal(structured.title, "Order Processing");
    assert.ok(structured.source.includes("%% title: Order Processing"));
    validateDiagramSource(structured.source, "mermaid");
  });

  it("emits entities in input order at both array bounds", async () => {
    const tool = captureTool(registerDiagramsTemplate, ctx);
    const twenty = Array.from({ length: 20 }, (_, index) => `E${index}`);
    const result = await callHandler(tool, { template: "class", entities: twenty });
    const structured = structuredOf(result);

    assert.equal(structured.entities_included, 20);
    assert.deepEqual(structured.entities, twenty);
    // Declaration lines appear in the same order as the input array.
    const declared = structured.source
      .split("\n")
      .filter((line) => /^class /.test(line))
      .map((line) => line.slice("class ".length));
    assert.deepEqual(declared, twenty);
  });

  it("returns byte-identical source for identical inputs in the same process", async () => {
    const tool = captureTool(registerDiagramsTemplate, ctx);
    const args = { template: "sequence", format: "mermaid", title: "Demo", entities: ["A", "B"] };

    const first = await callHandler(tool, args);
    const second = await callHandler(tool, args);
    // No state is kept between calls: two identical inputs are byte-identical.
    assert.equal(first.content[0].text, second.content[0].text);
    assert.equal(structuredOf(first).source, structuredOf(second).source);
  });

  it("rejects unknown arguments under the strict schema", () => {
    const parsed = diagramsTemplateInputSchema.safeParse({
      template: "class",
      entities: ["User"],
      output_dir: "diagrams",
    });
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && JSON.stringify(parsed.error.issues).includes("output_dir"),
      "the strict schema must name the unrecognized key",
    );
  });

  // Shape rejections: the schema is the gate, so these are the exact issues the
  // SDK surfaces as isError:true text. Each must name the offending input.
  describe("input validation", () => {
    it("rejects a missing template and a bogus enum value", () => {
      const missing = diagramsTemplateInputSchema.safeParse({ entities: ["User"] });
      assert.equal(missing.success, false);
      assert.ok(
        !missing.success && JSON.stringify(missing.error.issues).includes("template"),
        "a missing template must be reported at the template path",
      );

      const bogus = diagramsTemplateInputSchema.safeParse({
        template: "use-case",
        entities: ["User"],
      });
      assert.equal(bogus.success, false);
      assert.ok(
        !bogus.success && JSON.stringify(bogus.error.issues).includes("use-case"),
        "an unknown template value must be named in the rejection",
      );
    });

    it("rejects an empty entities array", () => {
      const parsed = diagramsTemplateInputSchema.safeParse({ template: "class", entities: [] });
      assert.equal(parsed.success, false);
      assert.ok(
        !parsed.success && JSON.stringify(parsed.error.issues).includes("entities"),
        "an empty entities array must be reported at the entities path",
      );
    });

    it("rejects more than 20 entities and accepts exactly 20", () => {
      const twentyOne = Array.from({ length: 21 }, (_, index) => `E${index}`);
      const parsed = diagramsTemplateInputSchema.safeParse({
        template: "class",
        entities: twentyOne,
      });
      assert.equal(parsed.success, false);
      assert.ok(
        !parsed.success && JSON.stringify(parsed.error.issues).includes("entities"),
        "an array over the cap must be reported at the entities path",
      );

      const twenty = Array.from({ length: 20 }, (_, index) => `E${index}`);
      const accepted = diagramsTemplateInputSchema.safeParse({
        template: "class",
        entities: twenty,
      });
      assert.equal(accepted.success, true, "exactly 20 entities is the ceiling, not past it");
    });

    it("rejects a name over 60 characters and accepts exactly 60", () => {
      const parsed = diagramsTemplateInputSchema.safeParse({
        template: "class",
        entities: [OVERLONG_NAME],
      });
      assert.equal(parsed.success, false);
      assert.ok(
        !parsed.success && JSON.stringify(parsed.error.issues).includes(OVERLONG_NAME),
        "the over-long name itself must appear in the rejection",
      );

      const accepted = diagramsTemplateInputSchema.safeParse({
        template: "class",
        entities: ["A".repeat(60)],
      });
      assert.equal(accepted.success, true, "exactly 60 characters is the ceiling, not past it");
    });

    it("rejects names that are not identifiers", () => {
      for (const bad of ["1User", "User Order", "User-Order", "Order!", ""]) {
        const parsed = diagramsTemplateInputSchema.safeParse({
          template: "class",
          entities: [bad],
        });
        assert.equal(parsed.success, false, `entity name '${bad}' must be rejected`);
        assert.ok(
          !parsed.success && JSON.stringify(parsed.error.issues).includes(bad),
          `the offending name '${bad}' must appear in its own rejection`,
        );
      }
      // The first character may be an underscore as well as a letter.
      const accepted = diagramsTemplateInputSchema.safeParse({
        template: "class",
        entities: ["_User", "Order2"],
      });
      assert.equal(accepted.success, true);
    });

    it("rejects a duplicate entity name at the second occurrence", () => {
      const parsed = diagramsTemplateInputSchema.safeParse({
        template: "class",
        entities: ["User", "Order", "User"],
      });
      assert.equal(parsed.success, false);
      // The repeat is the offender, so the path points at the third slot.
      assert.deepEqual(!parsed.success && parsed.error.issues.map((issue) => issue.path), [
        ["entities", 2],
      ]);
      assert.ok(
        !parsed.success && JSON.stringify(parsed.error.issues).includes("duplicate"),
        "the duplicate rejection must say what the problem is",
      );
    });

    it("rejects an over-long title and a whitespace-only title", () => {
      const overlong = diagramsTemplateInputSchema.safeParse({
        template: "class",
        title: OVERLONG_TITLE,
        entities: ["User"],
      });
      assert.equal(overlong.success, false);
      assert.ok(
        !overlong.success && JSON.stringify(overlong.error.issues).includes("title"),
        "an over-long title must be reported at the title path",
      );

      for (const blank of ["   ", "\t\n", ""]) {
        const parsed = diagramsTemplateInputSchema.safeParse({
          template: "class",
          title: blank,
          entities: ["User"],
        });
        assert.equal(parsed.success, false, `title ${JSON.stringify(blank)} must be rejected`);
        assert.ok(
          !parsed.success && JSON.stringify(parsed.error.issues).includes("title"),
          "a whitespace-only title must be reported at the title path",
        );
      }
    });

    it("accepts a title of exactly 200 characters", () => {
      const parsed = diagramsTemplateInputSchema.safeParse({
        template: "class",
        title: "T".repeat(200),
        entities: ["User"],
      });
      assert.equal(parsed.success, true, "exactly 200 characters is the ceiling, not past it");
    });
  });

  it("never writes a file under the project root", async () => {
    const tool = captureTool(registerDiagramsTemplate, ctx);
    for (const kind of KINDS) {
      for (const format of FORMATS) {
        await callHandler(tool, { template: kind, format, title: "Demo", entities: ["User"] });
      }
    }
    // Every template in both dialects, and the diagrams root is still empty.
    const filesAfter = new Set(await listAllFiles(projectRoot));
    assert.deepEqual([...filesAfter].sort(), [...filesBefore].sort());
  });
});

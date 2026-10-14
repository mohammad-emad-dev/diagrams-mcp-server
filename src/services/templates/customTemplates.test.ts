import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_CUSTOM_TEMPLATE_BYTES } from "../../constants.js";
import { CustomTemplateError, emitCustomTemplate } from "./customTemplates.js";

describe("custom template files", () => {
  let root: string;
  let directory: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "custom-template-"));
    directory = path.join(root, ".diagrams-templates");
    await fs.mkdir(directory);
  });
  afterEach(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("custom-template-"));
    await fs.rm(root, { recursive: true, force: true });
  });

  it("expands both dialects in order without recursively expanding replacement text", async () => {
    await fs.writeFile(
      path.join(directory, "model.json"),
      JSON.stringify({
        puml: {
          source: "@startuml\ntitle {{title}}\n{{entities}}\n@enduml\n",
          entity: "class {{name}}",
        },
        mermaid: { source: "classDiagram\n%% {{title}}\n{{entities}}\n", entity: "class {{name}}" },
      }),
    );
    for (const format of ["puml", "mermaid"] as const) {
      const source = await emitCustomTemplate({
        projectRoot: root,
        name: "model",
        format,
        title: "literal {{entities}}",
        entities: ["B", "A"],
      });
      assert.ok(source.includes("literal {{entities}}"));
      assert.ok(source.includes("class B\nclass A"));
      assert.ok(source.startsWith(format === "puml" ? "@startuml" : "classDiagram"));
    }
  });

  it("rereads edited definitions and rejects missing, malformed, oversized and unsupported files", async () => {
    const request = {
      projectRoot: root,
      name: "model",
      format: "puml" as const,
      title: null,
      entities: ["A"],
    };
    await assert.rejects(emitCustomTemplate(request), CustomTemplateError);
    const file = path.join(directory, "model.json");
    for (const label of ["Old", "New"]) {
      await fs.writeFile(
        file,
        JSON.stringify({
          puml: {
            source: `@startuml\ntitle ${label}\n{{entities}}\n@enduml`,
            entity: "class {{name}}",
          },
        }),
      );
      assert.ok((await emitCustomTemplate(request)).includes(`title ${label}`));
    }
    const cases = [
      ["{", /valid JSON/],
      [JSON.stringify({ unexpected: true }), /must define only/],
      [
        JSON.stringify({ mermaid: { source: "classDiagram", entity: "class {{name}}" } }),
        /does not support/,
      ],
      [
        JSON.stringify({ puml: { source: "{{unknown}}", entity: "class {{name}}" } }),
        /unsupported placeholder/,
      ],
      [
        JSON.stringify({ puml: { source: "{{entities}}", entity: "{{title}}" } }),
        /unsupported placeholder/,
      ],
      [
        JSON.stringify({ puml: { source: "{{entities", entity: "{{name}}" } }),
        /malformed placeholder/,
      ],
      [" ".repeat(MAX_CUSTOM_TEMPLATE_BYTES + 1), /byte limit/],
      [Buffer.from([0xc0, 0xaf]), /valid UTF-8/],
    ] as const;
    for (const [content, message] of cases) {
      await fs.writeFile(file, content);
      await assert.rejects(emitCustomTemplate(request), (error: unknown) => {
        assert.ok(error instanceof CustomTemplateError);
        assert.match(error.message, message);
        assert.ok(!error.message.includes(root));
        return true;
      });
    }
    for (const name of ["../outside", "nested/file", "", "a".repeat(65)]) {
      await assert.rejects(emitCustomTemplate({ ...request, name }), CustomTemplateError);
    }
  });

  it("bounds output amplification independently of file size", async () => {
    await fs.writeFile(
      path.join(directory, "large.json"),
      JSON.stringify({
        puml: { source: "@startuml\n{{entities}}\n@enduml", entity: "{{name}}".repeat(7000) },
      }),
    );
    await assert.rejects(
      emitCustomTemplate({
        projectRoot: root,
        name: "large",
        format: "puml",
        title: null,
        entities: Array.from({ length: 20 }, () => "A".repeat(60)),
      }),
      /1000000-character expansion limit/,
    );
  });

  it("rejects a redirected template directory", async () => {
    const actualDirectory = path.join(root, "outside-templates");
    await fs.rename(directory, actualDirectory);
    await fs.symlink(actualDirectory, directory, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      emitCustomTemplate({
        projectRoot: root,
        name: "model",
        format: "puml",
        title: null,
        entities: ["A"],
      }),
      /directory must be a regular directory/,
    );
  });

  it("rejects a symlink to a file outside the template directory", async (t) => {
    const outside = path.join(root, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({ puml: { source: "@startuml\n@enduml", entity: "{{name}}" } }),
    );
    try {
      await fs.symlink(outside, path.join(directory, "link.json"), "file");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        t.skip("symlink creation is unavailable on this host");
        return;
      }
      throw error;
    }
    await assert.rejects(
      emitCustomTemplate({
        projectRoot: root,
        name: "link",
        format: "puml",
        title: null,
        entities: ["A"],
      }),
      /not a symlink/,
    );
  });
});

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TEMPLATE_SCAN_ENTRIES } from "../../constants.js";
import { listCustomTemplates } from "./templateCatalog.js";

describe("custom template discovery", () => {
  let root: string;
  let directory: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "template-catalog-"));
    directory = path.join(root, ".diagrams-templates");
  });
  afterEach(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("template-catalog-"));
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns no candidates without creating a missing directory", async () => {
    assert.deepEqual(await listCustomTemplates(root), {
      names: [],
      entriesScanned: 0,
      truncated: false,
    });
    await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  });

  it("lists regular candidate files without parsing contents and observes edits", async () => {
    await fs.mkdir(directory);
    for (const name of [
      "z.json",
      "A.json",
      "bad name.json",
      ".json",
      "readme.txt",
      "UPPER.JSON",
      `${"a".repeat(65)}.json`,
    ]) {
      await fs.writeFile(path.join(directory, name), "not JSON");
    }
    await fs.mkdir(path.join(directory, "nested.json"));
    assert.deepEqual(await listCustomTemplates(root), {
      names: ["A", "z"],
      entriesScanned: 8,
      truncated: false,
    });
    await fs.writeFile(path.join(directory, "new-template.json"), "{");
    assert.deepEqual((await listCustomTemplates(root)).names, ["A", "new-template", "z"]);
  });

  it("counts non-template entries at the exact cap and reports one extra entry", async () => {
    await fs.mkdir(directory);
    for (let index = 0; index < MAX_TEMPLATE_SCAN_ENTRIES; index++) {
      await fs.writeFile(path.join(directory, `${index}.txt`), "");
    }
    assert.deepEqual(await listCustomTemplates(root), {
      names: [],
      entriesScanned: MAX_TEMPLATE_SCAN_ENTRIES,
      truncated: false,
    });
    await fs.writeFile(path.join(directory, "extra.txt"), "");
    assert.deepEqual(await listCustomTemplates(root), {
      names: [],
      entriesScanned: MAX_TEMPLATE_SCAN_ENTRIES,
      truncated: true,
    });
  });

  it("rejects a redirected directory rather than listing the target", async () => {
    const outside = path.join(root, "actual-templates");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private.json"), "{}");
    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(listCustomTemplates(root), /directory must be a regular directory/);
  });

  it("excludes symlink candidate files", async (t) => {
    await fs.mkdir(directory);
    const target = path.join(root, "external.json");
    await fs.writeFile(target, "{}");
    try {
      await fs.symlink(target, path.join(directory, "link.json"), "file");
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
    assert.deepEqual(await listCustomTemplates(root), {
      names: [],
      entriesScanned: 1,
      truncated: false,
    });
  });
});

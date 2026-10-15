import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HtmlExportExistsError,
  DiagramStore,
  PathTraversalError,
  UnsupportedDiagramExtensionError,
  UnsupportedHtmlExportExtensionError,
} from "./diagramStore.js";

const HTML = "<!DOCTYPE html>\n<html><body>export</body></html>\n";
const DIAGRAM_CONTENT = "@startuml\nclass LocalWidget\n@enduml\n";

async function symlinkSupported(probeDir: string): Promise<boolean> {
  const target = path.join(probeDir, "probe-target.txt");
  const link = path.join(probeDir, "probe-link.txt");
  try {
    await fs.writeFile(target, "probe", "utf-8");
    await fs.symlink(target, link, "file");
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err.code === "EPERM" || err.code === "EACCES" || err.code === "EISDIR")
    ) {
      return false;
    }
    throw err;
  } finally {
    await fs.rm(link, { force: true });
    await fs.rm(target, { force: true });
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

describe("DiagramStore.writeHtmlExport", () => {
  let diagramsRoot: string;
  let outsideDir: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-html-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-html-outside-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    assert.equal(path.dirname(path.resolve(diagramsRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(diagramsRoot).startsWith("diagrams-html-"));
    assert.equal(path.dirname(path.resolve(outsideDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(outsideDir).startsWith("diagrams-html-outside-"));
    await fs.rm(diagramsRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("saves nested HTML with exact bytes and creates parent directories", async () => {
    await store.writeHtmlExport("exports/nested/order.html", HTML);

    const onDisk = await fs.readFile(
      path.join(diagramsRoot, "exports", "nested", "order.html"),
      "utf-8",
    );
    assert.equal(onDisk, HTML);
  });

  it("accepts .HTML in any case", async () => {
    await store.writeHtmlExport("exports/upper.HTML", HTML);

    assert.equal(
      await fs.readFile(path.join(diagramsRoot, "exports", "upper.HTML"), "utf-8"),
      HTML,
    );
  });

  it("refuses to overwrite an existing export atomically", async () => {
    await store.writeHtmlExport("exports/order.html", HTML);

    await assert.rejects(
      store.writeHtmlExport("exports/order.html", "<html>second</html>"),
      HtmlExportExistsError,
    );

    assert.equal(
      await fs.readFile(path.join(diagramsRoot, "exports", "order.html"), "utf-8"),
      HTML,
    );
  });

  it("refuses an existing directory at the target path", async () => {
    await fs.mkdir(path.join(diagramsRoot, "exports", "dir.html"), { recursive: true });

    await assert.rejects(store.writeHtmlExport("exports/dir.html", HTML), HtmlExportExistsError);

    assert.equal(
      (await fs.stat(path.join(diagramsRoot, "exports", "dir.html"))).isDirectory(),
      true,
    );
  });

  it("rejects wrong extensions before creating directories", async () => {
    for (const bad of [
      "exports/notes.txt",
      "exports/order.puml",
      "exports/order.htm",
      "exports/noext",
    ]) {
      await assert.rejects(store.writeHtmlExport(bad, HTML), UnsupportedHtmlExportExtensionError);
    }

    await assert.rejects(fs.access(path.join(diagramsRoot, "exports")), { code: "ENOENT" });
  });

  it("rejects traversal without writing outside the root", async () => {
    await assert.rejects(
      store.writeHtmlExport(path.join(diagramsRoot, "absolute.html"), HTML),
      PathTraversalError,
    );
    await assert.rejects(store.writeHtmlExport("../escape.html", HTML), PathTraversalError);
    await assert.rejects(
      store.writeHtmlExport("exports/../../escape.html", HTML),
      PathTraversalError,
    );
    await assert.rejects(store.writeHtmlExport("..\\escape.html", HTML), PathTraversalError);

    await assert.rejects(fs.access(path.join(outsideDir, "escape.html")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(diagramsRoot, "..", "escape.html")), {
      code: "ENOENT",
    });
  });

  it("rejects writes through a symlink inside the root", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "html symlink-escape coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.html");
    await fs.writeFile(outsideFile, "outside", "utf-8");
    await fs.symlink(outsideFile, path.join(diagramsRoot, "link.html"), "file");

    await assert.rejects(store.writeHtmlExport("link.html", HTML), PathTraversalError);

    assert.equal(await fs.readFile(outsideFile, "utf-8"), "outside");
  });

  it("rejects writes through a symlinked parent directory", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "html parent-symlink coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.html");
    await fs.writeFile(outsideFile, "outside", "utf-8");
    const subAbs = path.join(diagramsRoot, "sub");
    try {
      await fs.symlink(outsideDir, subAbs, "dir");
    } catch (err: unknown) {
      if (isErrno(err) && (err.code === "EPERM" || err.code === "EACCES")) {
        t.skip(
          "directory symlinks are unavailable here (EPERM/EACCES); " +
            "html parent-symlink coverage was NOT verified here",
        );
        return;
      }
      throw err;
    }

    await assert.rejects(store.writeHtmlExport("sub/victim.html", HTML), PathTraversalError);
    await assert.rejects(fs.access(path.join(outsideDir, "victim.html")), { code: "ENOENT" });
    assert.equal(await fs.readFile(outsideFile, "utf-8"), "outside");
    await fs.rm(subAbs, { force: true });
  });

  it("removes a newly created file when the write fails", async () => {
    const target = path.join(diagramsRoot, "exports", "partial.html");
    const originalOpen = fs.open.bind(fs);
    type Open = typeof fs.open;
    const fakeOpen = (async (...args: Parameters<Open>) => {
      const opened = typeof args[0] === "string" ? args[0] : String(args[0]);
      if (opened === target) {
        const handle = await originalOpen(...args);
        return {
          writeFile: async () => {
            await handle.writeFile("partial bytes", "utf8");
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          },
          close: () => handle.close(),
        } as unknown as FileHandle;
      }
      return originalOpen(...args);
    }) as Open;
    (fs as { open: Open }).open = fakeOpen;
    try {
      await assert.rejects(
        store.writeHtmlExport("exports/partial.html", HTML),
        (err: unknown) => err instanceof Error && err.message.includes("ENOSPC"),
      );
    } finally {
      (fs as { open: Open }).open = originalOpen as unknown as Open;
    }

    await assert.rejects(fs.access(target), { code: "ENOENT" });

    // Cleanup left no EEXIST behind: a retry with real I/O succeeds.
    await store.writeHtmlExport("exports/partial.html", HTML);
    assert.equal(await fs.readFile(target, "utf-8"), HTML);
  });

  it("never widens diagram gates: .html stays a diagram-contract violation", async () => {
    await store.writeHtmlExport("exports/kept.html", HTML);

    await assert.rejects(store.read("exports/kept.html"), UnsupportedDiagramExtensionError);
    await assert.rejects(store.exists("exports/kept.html"), UnsupportedDiagramExtensionError);
    await assert.rejects(
      store.write("exports/other.html", DIAGRAM_CONTENT, { overwrite: false }),
      UnsupportedDiagramExtensionError,
    );
    await assert.rejects(store.delete("exports/kept.html"), UnsupportedDiagramExtensionError);

    const listed = await store.list();
    assert.deepEqual(listed, []);
    assert.equal(await fs.readFile(path.join(diagramsRoot, "exports", "kept.html"), "utf-8"), HTML);
  });
});

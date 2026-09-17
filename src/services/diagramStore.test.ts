import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DiagramExistsError,
  DiagramStore,
  PathTraversalError,
  UnsupportedDiagramExtensionError,
} from "./diagramStore.js";
import { MAX_TITLE_SCAN_BYTES } from "../constants.js";

const OUTSIDE_CONTENT = "external secret content 7f3a9c";
const DIAGRAM_CONTENT = "@startuml\nclass LocalWidget\n@enduml\n";

// Symlinks need privileges on some platforms (Windows without Developer
// Mode). Skip openly when refused so the gap stays visible.
async function symlinkSupported(probeDir: string): Promise<boolean> {
  const target = path.join(probeDir, "probe-target.txt");
  const link = path.join(probeDir, "probe-link.txt");
  try {
    await fs.writeFile(target, "probe", "utf-8");
    await fs.symlink(target, link, "file");
    return true;
  } catch (err: unknown) {
    if (isErrno(err) && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EISDIR")) {
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

describe("DiagramStore symlink safety", () => {
  let diagramsRoot: string;
  let outsideDir: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-root-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-outside-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    await fs.rm(diagramsRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("reads and writes normal in-root files", async () => {
    await store.write("models/local.puml", DIAGRAM_CONTENT, {
      overwrite: false,
    });

    const { content } = await store.read("models/local.puml");

    assert.equal(content, DIAGRAM_CONTENT);
  });

  it("creates a missing root on list instead of failing", async () => {
    const missing = new DiagramStore(path.join(diagramsRoot, "does-not-exist"));

    const files = await missing.list();

    assert.deepEqual(files, []);
    assert.equal(
      await fs.stat(path.join(diagramsRoot, "does-not-exist")).then((s) => s.isDirectory()),
      true,
    );
  });

  it("rejects reading a symlink inside the root that points outside", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "symlink-escape read coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.puml");
    await fs.writeFile(outsideFile, OUTSIDE_CONTENT, "utf-8");
    await fs.symlink(outsideFile, path.join(diagramsRoot, "link.puml"), "file");

    await assert.rejects(store.read("link.puml"), PathTraversalError);

    assert.equal(await fs.readFile(outsideFile, "utf-8"), OUTSIDE_CONTENT);
  });

  it("rejects deleting a symlink inside the root and leaves the external target intact", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "symlink-escape delete coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.puml");
    await fs.writeFile(outsideFile, OUTSIDE_CONTENT, "utf-8");
    const linkPath = path.join(diagramsRoot, "link.puml");
    await fs.symlink(outsideFile, linkPath, "file");

    await assert.rejects(store.delete("link.puml"), PathTraversalError);

    assert.equal(await fs.readFile(outsideFile, "utf-8"), OUTSIDE_CONTENT);
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
  });

  it("rejects writing through a symlink inside the root and does not modify the external target", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "symlink-escape write coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.puml");
    await fs.writeFile(outsideFile, OUTSIDE_CONTENT, "utf-8");
    await fs.symlink(outsideFile, path.join(diagramsRoot, "link.puml"), "file");

    await assert.rejects(
      store.write("link.puml", DIAGRAM_CONTENT, { overwrite: true }),
      PathTraversalError,
    );

    assert.equal(await fs.readFile(outsideFile, "utf-8"), OUTSIDE_CONTENT);
  });
});

describe("DiagramStore atomic create", () => {
  let diagramsRoot: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-race-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    await fs.rm(diagramsRoot, { recursive: true, force: true });
  });

  it("lets exactly one concurrent create win; the loser gets DiagramExistsError", async () => {
    const first = "@startuml\nclass First\n@enduml\n";
    const second = "@startuml\nclass Second\n@enduml\n";
    const outcomes = await Promise.allSettled([
      store.write("models/race.puml", first, { overwrite: false }),
      store.write("models/race.puml", second, { overwrite: false }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const loser = rejected[0];
    assert.ok(loser.status === "rejected" && loser.reason instanceof DiagramExistsError);
    const { content } = await store.read("models/race.puml");
    assert.ok(content === first || content === second);
  });

  it("exists() throws on non-ENOENT failures instead of reporting absent", async (t) => {
    // A regular file as a parent makes access fail with ENOTDIR on
    // POSIX; Windows maps the same path to ENOENT, so probe openly and
    // skip where the distinction is unobservable (same pattern as the
    // symlink tests above — Linux CI still proves the narrowing).
    await fs.writeFile(path.join(diagramsRoot, "blocker"), "x", "utf-8");
    let probe: string | null = null;
    try {
      await fs.access(path.join(diagramsRoot, "blocker", "child.puml"));
    } catch (err: unknown) {
      if (isErrno(err)) probe = err.code ?? null;
    }
    if (probe !== "ENOTDIR") {
      t.skip(
        `non-ENOENT access failures are unobservable here (got ${probe}); ` +
          "exists() narrowing coverage was NOT verified on this platform",
      );
      return;
    }
    await assert.rejects(
      store.exists("blocker/child.puml"),
      (err: unknown) => isErrno(err) && err.code === "ENOTDIR",
    );
  });
});

describe("DiagramStore extension gate on every mutating path", () => {
  let diagramsRoot: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-gate-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    await fs.rm(diagramsRoot, { recursive: true, force: true });
  });

  it("refuses to delete a non-diagram file and leaves it on disk", async () => {
    // Arrange: a file the store may read neither by extension nor content.
    const notePath = path.join(diagramsRoot, "notes.txt");
    await fs.writeFile(notePath, "important notes 41c9", "utf-8");

    // Act + Assert: read already refuses; delete must refuse too.
    await assert.rejects(store.read("notes.txt"), UnsupportedDiagramExtensionError);
    await assert.rejects(store.delete("notes.txt"), UnsupportedDiagramExtensionError);

    // Assert: the file is still there, byte-for-byte.
    assert.equal(await fs.readFile(notePath, "utf-8"), "important notes 41c9");
  });

  it("refuses exists() on a non-diagram path instead of reporting it as free", async () => {
    // Arrange: a non-diagram file in the root.
    await fs.writeFile(path.join(diagramsRoot, "readme.md"), "# notes", "utf-8");

    // Act + Assert: exists() throws rather than returning false. Returning
    // false would imply write() could create the file there, which it also
    // refuses — the two must agree.
    await assert.rejects(store.exists("readme.md"), UnsupportedDiagramExtensionError);

    // Assert: untouched.
    assert.equal(await fs.readFile(path.join(diagramsRoot, "readme.md"), "utf-8"), "# notes");
  });

  it("still deletes and reports genuine diagram files", async () => {
    // Arrange: a real diagram plus a non-diagram neighbour.
    await store.write("models/order.puml", DIAGRAM_CONTENT, { overwrite: false });
    await fs.writeFile(path.join(diagramsRoot, "models", "notes.txt"), "keep me", "utf-8");

    // Act: the diagram deletes cleanly; the note still cannot.
    await store.delete("models/order.puml");
    await assert.rejects(store.delete("models/notes.txt"), UnsupportedDiagramExtensionError);

    // Assert: only the diagram is gone.
    assert.equal(
      await fs.readFile(path.join(diagramsRoot, "models", "notes.txt"), "utf-8"),
      "keep me",
    );
    await assert.rejects(store.read("models/order.puml"));
  });
});

describe("DiagramStore atomic overwrite", () => {
  let diagramsRoot: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-atomic-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    await fs.rm(diagramsRoot, { recursive: true, force: true });
  });

  // Lists the temp files a write leaves behind, so a failed write can be
  // proven to clean up after itself.
  async function tempFiles(): Promise<string[]> {
    const entries = await fs.readdir(diagramsRoot);
    return entries.filter((name) => name.startsWith(".diagrams-mcp-tmp-"));
  }

  it("overwrites an existing diagram without truncating it first", async () => {
    // Arrange: a 29-byte original (the size that reproduced the data loss).
    const original = "@startuml\nclass Original\n@enduml\n";
    await store.write("flow.puml", original, { overwrite: false });
    assert.equal((await fs.stat(path.join(diagramsRoot, "flow.puml"))).size, original.length);

    // Act: a write whose content lands.
    const next = "@startuml\nclass Replaced\n@enduml\n";
    await store.write("flow.puml", next, { overwrite: true });

    // Assert: whole new content, no temp debris.
    const { content: replaced } = await store.read("flow.puml");
    assert.equal(replaced, next);
    assert.deepEqual(await tempFiles(), []);
  });

  it("leaves the original intact when the write fails mid-way", async () => {
    // Arrange: the original that must survive an injected I/O failure.
    const original = "@startuml\nclass Original\n@enduml\n";
    await store.write("flow.puml", original, { overwrite: false });

    // Act: make the temp write fail after the file is created, the point
    // where O_TRUNC had already zeroed the target before the fix.
    const originalOpen = fs.open.bind(fs);
    const failingHandle = {
      writeFile: async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
      close: async () => {
        /* closed by the store's cleanup path */
      },
    } as unknown as FileHandle;
    type Open = typeof fs.open;
    const fakeOpen = ((...args: Parameters<Open>) => {
      const opened = typeof args[0] === "string" ? args[0] : String(args[0]);
      if (opened.includes(".diagrams-mcp-tmp-")) {
        return Promise.resolve(failingHandle);
      }
      return originalOpen(...args);
    }) as Open;
    (fs as { open: Open }).open = fakeOpen;
    try {
      await assert.rejects(
        store.write("flow.puml", "@startuml\nclass Lost\n@enduml\n", { overwrite: true }),
        (err: unknown) => err instanceof Error && err.message.includes("ENOSPC"),
      );
    } finally {
      (fs as { open: Open }).open = originalOpen as unknown as Open;
    }

    // Assert: the original is fully intact — not 0 bytes, not truncated.
    const { content: survivor } = await store.read("flow.puml");
    assert.equal(survivor, original);
    assert.equal((await fs.stat(path.join(diagramsRoot, "flow.puml"))).size, original.length);
    assert.deepEqual(await tempFiles(), []);
  });

  it("still creates a missing file on overwrite and keeps atomic create exclusive", async () => {
    // Act + Assert: overwrite:true onto a path that does not exist yet.
    await store.write("new.puml", DIAGRAM_CONTENT, { overwrite: true });
    const { content: created } = await store.read("new.puml");
    assert.equal(created, DIAGRAM_CONTENT);

    // Act + Assert: the atomic-create path still refuses a second writer.
    await assert.rejects(
      store.write("new.puml", DIAGRAM_CONTENT, { overwrite: false }),
      DiagramExistsError,
    );
  });
});

describe("DiagramStore TOCTOU atomicity", () => {
  let diagramsRoot: string;
  let outsideDir: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-toctou-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-toctou-outside-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    await fs.rm(diagramsRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("write with overwrite:true does not follow a symlink swapped in after check", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "TOCTOU write coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.puml");
    await fs.writeFile(outsideFile, OUTSIDE_CONTENT, "utf-8");
    const linkAbs = path.join(diagramsRoot, "race.puml");
    await fs.symlink(outsideFile, linkAbs, "file");

    // Simulate the race: the pre-check sees a clean path while the use
    // step still faces the link.
    const originalLstat = fs.lstat.bind(fs);
    type Lstat = typeof fs.lstat;
    const fakeLstat = ((...args: Parameters<Lstat>) => {
      const target = args[0];
      const targetPath = typeof target === "string" ? target : target.toString();
      if (targetPath === linkAbs) {
        return originalLstat(diagramsRoot);
      }
      return (originalLstat as Lstat)(...args);
    }) as Lstat;
    (fs as { lstat: Lstat }).lstat = fakeLstat;
    try {
      // Arrange (liar installed) - Act:
      await assert.rejects(
        store.write("race.puml", DIAGRAM_CONTENT, { overwrite: true }),
        PathTraversalError,
      );

      // Assert: the external target must be untouched.
      assert.equal(await fs.readFile(outsideFile, "utf-8"), OUTSIDE_CONTENT);
    } finally {
      (fs as { lstat: Lstat }).lstat = originalLstat as Lstat;
      await fs.rm(linkAbs, { force: true });
    }
  });

  it("read does not follow a symlink swapped in after check", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "TOCTOU read coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "secret.puml");
    await fs.writeFile(outsideFile, OUTSIDE_CONTENT, "utf-8");
    const linkAbs = path.join(diagramsRoot, "race.puml");
    await fs.symlink(outsideFile, linkAbs, "file");

    const originalLstat = fs.lstat.bind(fs);
    type Lstat = typeof fs.lstat;
    const fakeLstat = ((...args: Parameters<Lstat>) => {
      const target = args[0];
      const targetPath = typeof target === "string" ? target : target.toString();
      if (targetPath === linkAbs) {
        return originalLstat(diagramsRoot);
      }
      return (originalLstat as Lstat)(...args);
    }) as Lstat;
    (fs as { lstat: Lstat }).lstat = fakeLstat;
    try {
      // Arrange (liar installed) - Act + Assert:
      await assert.rejects(store.read("race.puml"), PathTraversalError);
    } finally {
      (fs as { lstat: Lstat }).lstat = originalLstat as Lstat;
      await fs.rm(linkAbs, { force: true });
    }
  });

  it("delete through a parent dir swapped after check does not delete outside", async (t) => {
    if (!(await symlinkSupported(diagramsRoot))) {
      t.skip(
        "symlink creation is unavailable in this environment (EPERM/EACCES); " +
          "TOCTOU delete coverage was NOT verified here",
      );
      return;
    }
    const outsideFile = path.join(outsideDir, "victim.puml");
    await fs.writeFile(outsideFile, OUTSIDE_CONTENT, "utf-8");
    const subAbs = path.join(diagramsRoot, "sub");
    try {
      await fs.symlink(outsideDir, subAbs, "dir");
    } catch (err: unknown) {
      if (isErrno(err) && (err.code === "EPERM" || err.code === "EACCES")) {
        t.skip(
          "directory symlinks are unavailable here (EPERM/EACCES); " +
            "TOCTOU delete coverage was NOT verified here",
        );
        return;
      }
      throw err;
    }

    const originalLstat = fs.lstat.bind(fs);
    type Lstat = typeof fs.lstat;
    const fakeLstat = ((...args: Parameters<Lstat>) => {
      const target = args[0];
      const targetPath = typeof target === "string" ? target : target.toString();
      if (targetPath === subAbs) {
        return originalLstat(diagramsRoot);
      }
      return (originalLstat as Lstat)(...args);
    }) as Lstat;
    (fs as { lstat: Lstat }).lstat = fakeLstat;
    try {
      // Arrange (liar installed) - Act + Assert:
      await assert.rejects(store.delete("sub/victim.puml"), PathTraversalError);

      assert.equal(await fs.readFile(outsideFile, "utf-8"), OUTSIDE_CONTENT);
    } finally {
      (fs as { lstat: Lstat }).lstat = originalLstat as Lstat;
      await fs.rm(subAbs, { recursive: true, force: true });
    }
  });
});

describe("DiagramStore bounded title scan", () => {
  let diagramsRoot: string;
  let store: DiagramStore;

  beforeEach(async () => {
    diagramsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-titles-"));
    store = new DiagramStore(diagramsRoot);
  });

  afterEach(async () => {
    await fs.rm(diagramsRoot, { recursive: true, force: true });
  });

  function findTitle(
    entries: Awaited<ReturnType<DiagramStore["list"]>>,
    name: string,
  ): string | null | undefined {
    return entries.find((entry) => entry.relativePath === name)?.title;
  }

  it("exposes the title scan cap as a documented positive bound", () => {
    assert.equal(MAX_TITLE_SCAN_BYTES, 8192);
  });

  it("keeps exact titles for small files", async () => {
    await store.write("small.puml", "@startuml\ntitle Small Exact\nclass A\n@enduml\n", {
      overwrite: false,
    });

    assert.equal(
      (await store.list()).find((e) => e.relativePath === "small.puml")?.title,
      "Small Exact",
    );
  });

  it("keeps an early title in a large file without scanning the whole file", async () => {
    const padding = "note filler line for size padding 0123456789\n".repeat(400);
    await store.write("big-early.puml", `@startuml\ntitle Early Title\n${padding}@enduml\n`, {
      overwrite: false,
    });

    assert.equal(findTitle(await store.list(), "big-early.puml"), "Early Title");
  });

  it("reports null when the title starts past the scan window", async () => {
    const padding = "x".repeat(MAX_TITLE_SCAN_BYTES + 64);
    await store.write("big-late.puml", `@startuml\n${padding}\ntitle Late Title\n@enduml\n`, {
      overwrite: false,
    });

    assert.equal(findTitle(await store.list(), "big-late.puml"), null);
  });

  it("reports null for a mermaid title past the scan window", async () => {
    const padding = "z".repeat(MAX_TITLE_SCAN_BYTES + 32);
    await store.write("late.mmd", `flowchart TD\n${padding}\n%% title: Late Mermaid\nA --> B\n`, {
      overwrite: false,
    });

    assert.equal(findTitle(await store.list(), "late.mmd"), null);
  });

  it("prefixes a title line cut by the scan window edge (D-007)", async () => {
    const fullTitle = "Straddled Title Value";
    const head = "@startuml\n";
    // Start the title line just before the window edge so the scan
    // captures only its head; the full read (pre-fix) sees it all.
    const titleStart = MAX_TITLE_SCAN_BYTES - 12;
    const padding = "y".repeat(titleStart - head.length - 1);
    await store.write("edge.puml", `${head}${padding}\ntitle ${fullTitle}\n@enduml\n`, {
      overwrite: false,
    });

    const title = findTitle(await store.list(), "edge.puml");

    assert.ok(
      typeof title === "string" && title.startsWith("…"),
      `expected a "…"-prefixed excerpt, got ${JSON.stringify(title)}`,
    );
    assert.notEqual(title, fullTitle);
  });
});

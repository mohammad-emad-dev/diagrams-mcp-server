import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagramExistsError, DiagramStore, PathTraversalError } from "./diagramStore.js";

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

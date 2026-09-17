import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveScope, ScopeEscapeError } from "./scopeResolve.js";

describe("resolveScope", () => {
  let root: string;
  let outsideRoot: string;
  let subDir: string;
  let deepFile: string;
  let outsideFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "scope-resolve-"));
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scope-resolve-out-"));
    subDir = path.join(root, "src", "services");
    deepFile = path.join(root, "src", "widget.ts");
    outsideFile = path.join(outsideRoot, "secret.ts");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(deepFile, "export class Widget {}\n", "utf-8");
    await fs.writeFile(outsideFile, "export class Secret {}\n", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  it("resolves an in-root file scope to a POSIX relative path", () => {
    const resolved = resolveScope(root, "src/widget.ts");
    assert.equal(resolved.relativePath, "src/widget.ts");
    assert.equal(resolved.absolutePath, deepFile);
  });

  it("resolves an in-root directory scope", () => {
    const resolved = resolveScope(root, "src/services");
    assert.equal(resolved.relativePath, "src/services");
    assert.equal(resolved.absolutePath, subDir);
  });

  it("defaults to the project root when the scope is omitted or empty", () => {
    assert.equal(resolveScope(root).relativePath, ".");
    assert.equal(resolveScope(root).absolutePath, root);
    assert.equal(resolveScope(root, "").relativePath, ".");
    assert.equal(resolveScope(root, "   ").relativePath, ".");
  });

  it("accepts '.' and normalizes inner traversal and trailing separators", () => {
    assert.equal(resolveScope(root, ".").relativePath, ".");
    assert.equal(resolveScope(root, "src/").relativePath, "src");
    assert.equal(resolveScope(root, path.join("src", "..", "src")).relativePath, "src");
    assert.equal(resolveScope(root, path.join("src", "services", "..")).relativePath, "src");
  });

  it("rejects escapes with a typed error that names the refusal and reads no file", () => {
    assert.throws(
      () => resolveScope(root, "../outside"),
      (err: unknown) =>
        err instanceof ScopeEscapeError &&
        /^Refused to resolve scope outside the project root: '\.\.\/outside'\./.test(err.message),
      "must refuse the escape by name",
    );

    // The target exists outside the root; the refusal is path-based, so it
    // never depends on (or reads) what is out there.
    assert.throws(
      () => resolveScope(root, path.join("..", path.basename(outsideRoot), "secret.ts")),
      ScopeEscapeError,
    );
    assert.throws(() => resolveScope(root, ".."), ScopeEscapeError);
    assert.throws(() => resolveScope(root, "../../etc/passwd"), ScopeEscapeError);
  });

  it("rejects absolute paths without echoing them into the message", () => {
    assert.throws(
      () => resolveScope(root, deepFile),
      (err: unknown) =>
        err instanceof ScopeEscapeError &&
        err.message.includes(
          "Refused to resolve scope outside the project root: 'an absolute path'",
        ) &&
        !err.message.includes(root),
      "absolute scopes must be refused without leaking the absolute path",
    );
  });
});

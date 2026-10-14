import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

// Guards registry metadata drift: package.json is the single source of
// truth, and the compiled test resolves siblings from dist/integration,
// mirroring the existing stdio integration coverage.
interface PackageManifest {
  name: string;
  version: string;
}

interface PackageLock {
  version: string;
  packages: Record<string, { version?: string }>;
}

interface ServerPackage {
  registryType: string;
  identifier: string;
  version: string;
}

interface ServerManifest {
  version: string;
  packages: ServerPackage[];
}

async function readJson(relativePath: string): Promise<unknown> {
  const raw = await fs.readFile(new URL(relativePath, import.meta.url), "utf-8");
  return JSON.parse(raw) as unknown;
}

describe("registry metadata (package-lock/server.json)", () => {
  it("keeps package-lock.json versions aligned with package.json", async () => {
    const manifest = (await readJson("../../package.json")) as PackageManifest;
    const lockfile = (await readJson("../../package-lock.json")) as PackageLock;

    assert.equal(typeof manifest.version, "string");
    assert.equal(typeof lockfile.version, "string");
    assert.equal(
      lockfile.version,
      manifest.version,
      "package-lock.json root version must track package.json",
    );

    const rootEntry = lockfile.packages[""];
    assert.ok(rootEntry, 'package-lock.json packages[""] entry must exist');
    assert.equal(typeof rootEntry.version, "string");
    assert.equal(
      rootEntry.version,
      manifest.version,
      'package-lock.json packages[""] version must track package.json',
    );
  });

  it("keeps server.json registry metadata aligned with package.json", async () => {
    const manifest = (await readJson("../../package.json")) as PackageManifest;
    const server = (await readJson("../../server.json")) as ServerManifest;

    assert.equal(typeof manifest.name, "string");
    assert.equal(typeof manifest.version, "string");
    assert.equal(
      server.version,
      manifest.version,
      "server.json root version must track package.json",
    );

    const npmPackage = server.packages.find((entry) => entry.registryType === "npm");
    assert.ok(npmPackage, "server.json must declare an npm package entry");
    assert.equal(
      npmPackage.identifier,
      manifest.name,
      "server.json npm identifier must track package.json name",
    );
    assert.equal(
      npmPackage.version,
      manifest.version,
      "server.json npm version must track package.json",
    );
  });
});

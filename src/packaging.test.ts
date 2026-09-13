import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readManifest(): Promise<PackageManifest> {
  const url = new URL("../package.json", import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf-8")) as PackageManifest;
}

describe("packaging (prod dependency surface)", () => {
  it("keeps the TypeScript compiler out of production dependencies", async () => {
    const manifest = await readManifest();

    assert.equal(
      "typescript" in (manifest.dependencies ?? {}),
      false,
      "typescript is a build-time compiler only; prod installs use the regex fallback (see tsParse.ts)",
    );
  });

  it("keeps the TypeScript compiler available to the dev toolchain", async () => {
    const manifest = await readManifest();

    assert.equal(
      typeof (manifest.devDependencies ?? {})["typescript"],
      "string",
      "dev builds, TS goldens, and eslint still need the compiler",
    );
  });
});

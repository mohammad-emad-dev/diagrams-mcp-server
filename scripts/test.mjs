import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.join(projectRoot, "dist");

async function compiledTests(directory) {
  const testFiles = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      testFiles.push(...(await compiledTests(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      testFiles.push(entryPath);
    }
  }
  return testFiles;
}

const testFiles = (await compiledTests(outputDirectory)).sort();
if (testFiles.length === 0) {
  throw new Error("No compiled tests found in dist. Run npm run build before npm test.");
}

const testRun = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (testRun.error) throw testRun.error;
process.exitCode = testRun.status ?? 1;

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.resolve(projectRoot, "dist");

if (path.relative(projectRoot, outputDirectory) !== "dist") {
  throw new Error("Build cleanup must stay inside the project's dist directory.");
}

await rm(outputDirectory, { recursive: true, force: true });

const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const compilation = spawnSync(process.execPath, [compiler], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (compilation.error) throw compilation.error;
process.exitCode = compilation.status ?? 1;

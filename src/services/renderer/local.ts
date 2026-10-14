import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLocalCommand } from "./command.js";
import { RenderError } from "./error.js";
import type { RenderFormat, RendererDeps } from "./types.js";

export async function renderMermaid(
  source: string,
  format: RenderFormat,
  deps: Required<RendererDeps>,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-mcp-"));
  const inputPath = path.join(tmpDir, "input.mmd");
  const outputPath = path.join(tmpDir, `output.${format}`);

  try {
    await fs.writeFile(inputPath, source, "utf-8");
    const outcome = await runLocalCommand(
      "mmdc",
      ["-i", inputPath, "-o", outputPath, "-b", "transparent"],
      deps,
    );
    if (outcome === "missing") {
      throw new RenderError(
        "Mermaid rendering requires the 'mmdc' CLI, which is not installed. " +
          "Install it with: npm install -g @mermaid-js/mermaid-cli",
      );
    }
    if (outcome === "unlaunchable") {
      throw new RenderError(
        "Mermaid rendering found an 'mmdc' command that could not be executed. " +
          "On Windows this usually means only an npm shim is on PATH; " +
          "reinstall with: npm install -g @mermaid-js/mermaid-cli " +
          "and ensure the npm global bin directory is on PATH.",
      );
    }
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function renderPlantUmlLocal(
  source: string,
  format: RenderFormat,
  deps: Required<RendererDeps>,
): Promise<Buffer | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-mcp-"));
  const inputPath = path.join(tmpDir, "input.puml");

  try {
    await fs.writeFile(inputPath, source, "utf-8");
    const flag = format === "svg" ? "-tsvg" : "-tpng";
    const outcome = await runLocalCommand("plantuml", [flag, inputPath], deps);
    if (outcome === "missing") return null;
    if (outcome === "unlaunchable") {
      throw new RenderError(
        "PlantUML rendering found a 'plantuml' command that could not be executed. " +
          "Install a working local 'plantuml' CLI for offline rendering.",
      );
    }
    const outputPath = path.join(tmpDir, `input.${format}`);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_LOCAL_IMAGE_BYTES } from "../../constants.js";
import { runLocalCommand } from "./command.js";
import { RenderError } from "./error.js";
import type { RenderFormat, RendererDeps } from "./types.js";

function localImageLimitError(): RenderError {
  return new RenderError(
    `Local renderer image exceeded the ${MAX_LOCAL_IMAGE_BYTES}-byte limit and was discarded. ` +
      "Split or simplify the diagram, then render it again.",
  );
}

async function readImageBytes(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > MAX_LOCAL_IMAGE_BYTES) throw localImageLimitError();
  return Buffer.from(buffer.subarray(0, length));
}

async function readLocalImage(outputPath: string): Promise<Buffer> {
  const handle = await fs.open(outputPath, "r");
  try {
    if ((await handle.stat()).size > MAX_LOCAL_IMAGE_BYTES) throw localImageLimitError();
    // A file can grow after stat so the read ceiling must not depend on that size.
    return await readImageBytes(handle);
  } finally {
    await handle.close();
  }
}

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
    return await readLocalImage(outputPath);
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
    return await readLocalImage(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Turns diagram source into images via local CLIs.
// Mermaid uses a local `mmdc` install. PlantUML prefers a local install
// and only falls back to the public render server when explicitly enabled
// with ALLOW_REMOTE_PLANTUML=true. DISABLE_REMOTE_PLANTUML=true always wins.

import type { DiagramType } from "../types.js";
import type { RenderFormat, RendererDeps, RenderResult } from "./renderer/types.js";
import {
  commandExists,
  resolveSpawnTarget,
  runCommand,
  type SpawnTarget,
} from "./renderer/command.js";
import { RenderError } from "./renderer/error.js";
import {
  defaultFetchRemote,
  encodePlantUmlForUrl,
  renderPlantUmlRemote,
} from "./renderer/plantumlRemote.js";
import { renderMermaid, renderPlantUmlLocal } from "./renderer/local.js";

// The command layer stays re-exported from here so existing imports
// (toolError.ts, renderer.test.ts) keep the same bindings and class
// identity without reaching into the submodules. The remote helpers
// re-export for the same reason.
export {
  RenderError,
  defaultFetchRemote,
  encodePlantUmlForUrl,
  runCommand,
  resolveSpawnTarget,
  type SpawnTarget,
};
export type {
  RenderFormat,
  RemoteRenderResponse,
  RendererDeps,
  RenderProvenance,
  RenderResult,
} from "./renderer/types.js";

// Remote rendering is opt-in: enabled only by ALLOW_REMOTE_PLANTUML=true,
// and always off when DISABLE_REMOTE_PLANTUML=true. Read per call so
// concurrent renders never share the setting.
export function isRemotePlantUmlDisabled(): boolean {
  if (process.env.DISABLE_REMOTE_PLANTUML === "true") return true;
  return process.env.ALLOW_REMOTE_PLANTUML !== "true";
}

/**
 * Render source to an image and report which path produced it. The decision
 * tree is unchanged from the old renderDiagram body; it lives in exactly one
 * place so a caller that reports provenance (diagrams_export) can never
 * disagree with what actually rendered. Errors stay the existing RenderErrors,
 * byte for byte.
 */
export async function renderDiagramWithProvenance(
  source: string,
  type: DiagramType,
  format: RenderFormat = "svg",
  deps?: RendererDeps,
): Promise<RenderResult> {
  const resolved: Required<RendererDeps> = {
    commandExists: deps?.commandExists ?? commandExists,
    runCommand: deps?.runCommand ?? runCommand,
    fetchRemote: deps?.fetchRemote ?? defaultFetchRemote,
  };

  if (type === "mermaid") {
    return { buffer: await renderMermaid(source, format, resolved), renderedWith: "mmdc" };
  }

  const local = await renderPlantUmlLocal(source, format, resolved);
  if (local) return { buffer: local, renderedWith: "local-plantuml" };
  if (isRemotePlantUmlDisabled()) {
    throw new RenderError(
      "PlantUML rendering requires a local 'plantuml' CLI, which was not found, " +
        "and remote rendering is disabled by default. " +
        "Install a local 'plantuml' CLI for offline rendering, or set " +
        "ALLOW_REMOTE_PLANTUML=true to allow the configured remote fallback " +
        "(DISABLE_REMOTE_PLANTUML=true always disables it).",
    );
  }
  return {
    buffer: await renderPlantUmlRemote(source, format, resolved),
    renderedWith: "remote-plantuml",
  };
}

/**
 * Render diagram source to an image buffer. Delegates to
 * renderDiagramWithProvenance and returns only the buffer, so existing callers
 * keep their signature and behavior.
 */
export async function renderDiagram(
  source: string,
  type: DiagramType,
  format: RenderFormat = "svg",
  deps?: RendererDeps,
): Promise<Buffer> {
  return (await renderDiagramWithProvenance(source, type, format, deps)).buffer;
}

// Server context: diagrams root and code root, resolved once at startup.

import path from "node:path";
import { DEFAULT_DIAGRAMS_DIR } from "./constants.js";
import { DiagramStore } from "./services/diagramStore.js";
import type { RendererDeps } from "./services/renderer.js";

export interface ServerContext {
  diagramStore: DiagramStore;
  codeRootDir: string;
  /**
   * Optional renderer seams. Production leaves this unset so the real CLIs and
   * fetch are used, exactly as the RendererDeps seam documents; tests set it to
   * stubs so a tool's render step is covered without a CLI or the network.
   */
  rendererDeps?: RendererDeps;
}

export function createServerContext(): ServerContext {
  // Project root, defaulting to the launch directory.
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());

  // Diagrams directory, relative to the project root unless absolute.
  const diagramsDirSetting = process.env.DIAGRAMS_DIR || DEFAULT_DIAGRAMS_DIR;
  const diagramsRoot = path.isAbsolute(diagramsDirSetting)
    ? diagramsDirSetting
    : path.join(projectRoot, diagramsDirSetting);

  return {
    diagramStore: new DiagramStore(diagramsRoot),
    codeRootDir: projectRoot,
  };
}

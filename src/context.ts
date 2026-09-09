/**
 * Shared server context: resolves the diagrams root and code root once at
 * startup, and exposes a single DiagramStore instance for all tools.
 */

import path from "node:path";
import { DEFAULT_DIAGRAMS_DIR } from "./constants.js";
import { DiagramStore } from "./services/diagramStore.js";

export interface ServerContext {
  diagramStore: DiagramStore;
  codeRootDir: string;
}

export function createServerContext(): ServerContext {
  // PROJECT_ROOT: the root of the codebase this server is attached to.
  // Defaults to the current working directory the MCP client launched us
  // from (typically the user's project directory).
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());

  // DIAGRAMS_DIR: where diagram source files live, relative to PROJECT_ROOT
  // unless an absolute path is given.
  const diagramsDirSetting = process.env.DIAGRAMS_DIR || DEFAULT_DIAGRAMS_DIR;
  const diagramsRoot = path.isAbsolute(diagramsDirSetting)
    ? diagramsDirSetting
    : path.join(projectRoot, diagramsDirSetting);

  return {
    diagramStore: new DiagramStore(diagramsRoot),
    codeRootDir: projectRoot,
  };
}

#!/usr/bin/env node
// MCP server for PlantUML and Mermaid diagrams, over stdio.
// Exposes list, read, create, update, delete, render, and consistency tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServerContext } from "./context.js";
import { registerDiagramsList } from "./tools/diagramsList.js";
import { registerDiagramsGet } from "./tools/diagramsGet.js";
import { registerDiagramsCreate } from "./tools/diagramsCreate.js";
import { registerDiagramsUpdate } from "./tools/diagramsUpdate.js";
import { registerDiagramsDelete } from "./tools/diagramsDelete.js";
import { registerDiagramsRender } from "./tools/diagramsRender.js";
import { registerDiagramsCheckConsistency } from "./tools/diagramsCheckConsistency.js";
import { runSetup } from "./setup.js";

function printHelp(): void {
  console.log(`diagrams-mcp-server

An MCP server for managing, rendering, and checking PlantUML and Mermaid
architecture diagrams alongside your codebase.

Usage (as an MCP server, launched by an MCP client via stdio):
  diagrams-mcp-server

Usage (one-command client setup):
  diagrams-mcp-server setup [--client <name>] [--yes]

Environment variables:
  PROJECT_ROOT   Root directory of the project (default: current working directory)
  DIAGRAMS_DIR   Directory for diagram files, relative to PROJECT_ROOT unless
                 absolute (default: "diagrams")
  PLANTUML_SERVER_URL
                 Override the public PlantUML rendering server URL used as a
                 fallback when no local 'plantuml' CLI is installed
                 (default: https://www.plantuml.com/plantuml)
  ALLOW_REMOTE_PLANTUML
                  Set to "true" to allow the remote PlantUML server fallback
                  when no local 'plantuml' CLI is installed
                  (default: unset, remote fallback disabled)
  DISABLE_REMOTE_PLANTUML
                  Set to "true" to never use the remote PlantUML server,
                  even when ALLOW_REMOTE_PLANTUML is set
                  (default: unset)

See README.md for setup instructions with Claude Desktop and Claude Code.
`);
}

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    try {
      await runSetup(process.argv.slice(3));
    } catch (err: unknown) {
      console.error(`Setup failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const ctx = createServerContext();
  await ctx.diagramStore.ensureRootExists();

  const server = new McpServer({
    name: "diagrams-mcp-server",
    version: "0.3.1",
  });

  registerDiagramsList(server, ctx);
  registerDiagramsGet(server, ctx);
  registerDiagramsCreate(server, ctx);
  registerDiagramsUpdate(server, ctx);
  registerDiagramsDelete(server, ctx);
  registerDiagramsRender(server, ctx);
  registerDiagramsCheckConsistency(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `diagrams-mcp-server running (stdio). Diagrams root: ${ctx.diagramStore.getRoot()}`,
  );
}

main().catch((error) => {
  console.error("Fatal error starting diagrams-mcp-server:", error);
  process.exit(1);
});

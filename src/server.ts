import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "./context.js";
import { registerDiagramsList } from "./tools/diagramsList.js";
import { registerDiagramsGet } from "./tools/diagramsGet.js";
import { registerDiagramsCreate } from "./tools/diagramsCreate.js";
import { registerDiagramsUpdate } from "./tools/diagramsUpdate.js";
import { registerDiagramsDelete } from "./tools/diagramsDelete.js";
import { registerDiagramsRender } from "./tools/diagramsRender.js";
import { registerDiagramsExport } from "./tools/diagramsExport.js";
import { registerDiagramsCheckConsistency } from "./tools/diagramsCheckConsistency.js";
import { registerDiagramsGenerate } from "./tools/diagramsGenerate.js";
import { registerDiagramsGenerateSequence } from "./tools/diagramsGenerateSequence.js";
import { registerDiagramsDiff } from "./tools/diagramsDiff.js";
import { registerDiagramsTemplate } from "./tools/diagramsTemplate.js";
import { registerDiagramsListTemplates } from "./tools/diagramsListTemplates.js";

export function createDiagramServer(ctx: ServerContext): McpServer {
  const server = new McpServer({
    name: "diagrams-mcp-server",
    version: "0.8.0",
  });

  registerDiagramsList(server, ctx);
  registerDiagramsGet(server, ctx);
  registerDiagramsCreate(server, ctx);
  registerDiagramsUpdate(server, ctx);
  registerDiagramsDelete(server, ctx);
  registerDiagramsRender(server, ctx);
  registerDiagramsExport(server, ctx);
  registerDiagramsCheckConsistency(server, ctx);
  registerDiagramsGenerate(server, ctx);
  registerDiagramsGenerateSequence(server, ctx);
  registerDiagramsDiff(server, ctx);
  registerDiagramsTemplate(server, ctx);
  registerDiagramsListTemplates(server, ctx);

  return server;
}

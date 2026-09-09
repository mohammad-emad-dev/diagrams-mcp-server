import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import {
  DiagramExistsError,
  DiagramNotFoundError,
  DiagramStore,
  DiagramValidationError,
  PathTraversalError,
  UnsupportedDiagramExtensionError,
} from "../services/diagramStore.js";
import { RenderError } from "../services/renderer.js";
import { registerDiagramsCheckConsistency } from "./diagramsCheckConsistency.js";
import { registerDiagramsCreate } from "./diagramsCreate.js";
import { registerDiagramsDelete } from "./diagramsDelete.js";
import { registerDiagramsGet } from "./diagramsGet.js";
import { registerDiagramsList } from "./diagramsList.js";
import { registerDiagramsRender } from "./diagramsRender.js";
import { registerDiagramsUpdate } from "./diagramsUpdate.js";
import {
  handleRenderError,
  handleToolError,
  isExpectedRenderError,
  isExpectedToolError,
  isProgrammingError,
  logUnexpectedToolError,
} from "./toolError.js";

interface CapturedTextContent {
  type: string;
  text: string;
}

interface CapturedToolResult {
  content: CapturedTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type CapturedToolHandler = (params: Record<string, unknown>) => Promise<CapturedToolResult>;

function captureTool(
  register: (server: McpServer, ctx: ServerContext) => void,
  ctx: ServerContext,
): { handler: CapturedToolHandler } {
  const captured = {} as { handler: CapturedToolHandler };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: CapturedToolHandler): void => {
      captured.handler = handler;
    },
  } as unknown as McpServer;
  register(fakeServer, ctx);
  return captured;
}

function failingStore(methods: Record<string, (...args: never[]) => unknown>): DiagramStore {
  return methods as unknown as DiagramStore;
}

const SECRET_MARKER = "s3cr3t-marker-9f3c-unexpected";
const ABS_POSIX_LEAK = "/tmp/abs-leak-4d2a/private.puml";
const ABS_WINDOWS_LEAK = "C:\\Temp\\abs-leak-7e1b\\private.puml";

let loggedLines: string[];
let originalConsoleError: typeof console.error;

beforeEach(() => {
  loggedLines = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    loggedLines.push(args.map((arg) => String(arg)).join(" "));
  };
});

afterEach(() => {
  console.error = originalConsoleError;
});

describe("isProgrammingError", () => {
  it("flags builtin programming-error subclasses", () => {
    for (const err of [
      new TypeError("boom"),
      new ReferenceError("boom"),
      new RangeError("boom"),
      new SyntaxError("boom"),
      new URIError("boom"),
      new EvalError("boom"),
    ]) {
      assert.equal(isProgrammingError(err), true);
    }
  });

  it("does not flag domain errors or plain runtime errors", () => {
    assert.equal(isProgrammingError(new RenderError("renderer failed")), false);
    assert.equal(isProgrammingError(new DiagramNotFoundError("a.puml")), false);
    assert.equal(isProgrammingError(new Error("Command exited with code 1")), false);
    assert.equal(isProgrammingError("boom"), false);
    assert.equal(isProgrammingError(null), false);
  });
});

describe("isExpectedToolError", () => {
  it("accepts every typed domain error", () => {
    assert.equal(isExpectedToolError(new DiagramNotFoundError("a.puml")), true);
    assert.equal(isExpectedToolError(new PathTraversalError("../x.puml")), true);
    assert.equal(isExpectedToolError(new DiagramValidationError("plantuml", "bad")), true);
    assert.equal(isExpectedToolError(new DiagramExistsError("a.puml")), true);
    assert.equal(isExpectedToolError(new UnsupportedDiagramExtensionError("a.txt")), true);
    assert.equal(isExpectedToolError(new RenderError("no renderer")), true);
  });

  it("rejects generic errors, programming errors, and non-errors", () => {
    assert.equal(isExpectedToolError(new Error("boom")), false);
    assert.equal(isExpectedToolError(new TypeError("boom")), false);
    assert.equal(isExpectedToolError("boom"), false);
    assert.equal(isExpectedToolError(null), false);
    assert.equal(isExpectedToolError(undefined), false);
  });
});

describe("isExpectedRenderError", () => {
  it("accepts RenderError and child-process failures", () => {
    assert.equal(isExpectedRenderError(new RenderError("no mmdc")), true);
    assert.equal(isExpectedRenderError(new Error("Command exited with code 1")), true);
    assert.equal(isExpectedRenderError(new Error("mmdc failed: bad syntax")), true);
  });

  it("rejects programming errors and non-errors", () => {
    assert.equal(isExpectedRenderError(new TypeError("boom")), false);
    assert.equal(isExpectedRenderError("boom"), false);
    assert.equal(isExpectedRenderError(null), false);
  });
});

describe("handleToolError", () => {
  it("passes expected errors through with their message and isError", () => {
    const result = handleToolError("diagrams_get", new DiagramNotFoundError("models/m.puml"));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No diagram found at 'models\/m\.puml'/);
  });

  it("returns a generic error without leaks for unexpected failures", () => {
    const result = handleToolError(
      "diagrams_get",
      new Error(`EACCES: permission denied, open '${ABS_POSIX_LEAK}' ${SECRET_MARKER}`),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.match(result.content[0].text, /diagrams_get/);
    assert.ok(!result.content[0].text.includes(SECRET_MARKER));
    assert.ok(!result.content[0].text.includes(ABS_POSIX_LEAK));
    assert.ok(!result.content[0].text.includes("EACCES"));
  });

  it("logs unexpected errors to stderr without source, secrets, or absolute paths", () => {
    logUnexpectedToolError(
      "diagrams_create",
      new Error(
        `disk blew up ${SECRET_MARKER} at ${ABS_POSIX_LEAK} and ${ABS_WINDOWS_LEAK}\nsecond line`,
      ),
    );

    assert.equal(loggedLines.length, 1);
    assert.match(loggedLines[0], /diagrams_create/);
    assert.ok(!loggedLines[0].includes(SECRET_MARKER));
    assert.ok(!loggedLines[0].includes(ABS_POSIX_LEAK));
    assert.ok(!loggedLines[0].includes(ABS_WINDOWS_LEAK));
    assert.ok(!loggedLines[0].includes("\n"));
  });

  it("logs non-error throws without crashing", () => {
    const result = handleToolError("diagrams_list", "string failure");

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.equal(loggedLines.length, 1);
  });
});

describe("handleRenderError", () => {
  it("passes child-process failures through with their message", () => {
    const result = handleRenderError("diagrams_render", new Error("Command exited with code 1"));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Command exited with code 1/);
    assert.equal(loggedLines.length, 0);
  });

  it("routes programming errors to the generic message with a safe log", () => {
    const result = handleRenderError("diagrams_render", new TypeError("boom"));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.ok(!result.content[0].text.includes("boom"));
    assert.equal(loggedLines.length, 1);
  });
});

describe("tools preserve typed domain errors", () => {
  let tmpRoot: string;
  let ctx: ServerContext;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-tool-errors-"));
    ctx = { diagramStore: new DiagramStore(tmpRoot), codeRootDir: tmpRoot };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("diagrams_create rejects unsupported extensions without logging", async () => {
    const tool = captureTool(registerDiagramsCreate, ctx);
    const result = await tool.handler({
      relative_path: "models/notes.txt",
      content: "@startuml\nclass A\n@enduml\n",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /recognized diagram extension/);
    assert.equal(loggedLines.length, 0);
  });

  it("diagrams_create rejects existing files without logging", async () => {
    await ctx.diagramStore.write("models/dup.puml", "@startuml\nclass A\n@enduml\n", {
      overwrite: false,
    });
    const tool = captureTool(registerDiagramsCreate, ctx);
    const result = await tool.handler({
      relative_path: "models/dup.puml",
      content: "@startuml\nclass B\n@enduml\n",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already exists/);
    assert.equal(loggedLines.length, 0);
  });

  it("diagrams_get rejects unsupported extensions without logging", async () => {
    const tool = captureTool(registerDiagramsGet, ctx);
    const result = await tool.handler({ relative_path: "models/notes.txt" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /recognized diagram extension/);
    assert.equal(loggedLines.length, 0);
  });
});

describe("tools return generic errors for unexpected failures", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-unexpected-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function ctxWith(store: DiagramStore): ServerContext {
    return { diagramStore: store, codeRootDir: tmpRoot };
  }

  it("diagrams_create maps store TypeError to generic without leaks", async () => {
    const tool = captureTool(
      registerDiagramsCreate,
      ctxWith(
        failingStore({
          write: () => Promise.reject(new TypeError(`boom ${SECRET_MARKER} ${ABS_POSIX_LEAK}`)),
        }),
      ),
    );
    const result = await tool.handler({
      relative_path: "models/a.puml",
      content: "@startuml\nclass A\n@enduml\n",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.ok(!result.content[0].text.includes(SECRET_MARKER));
    assert.ok(!result.content[0].text.includes("@startuml"));
    assert.equal(loggedLines.length, 1);
    assert.ok(!loggedLines[0].includes(SECRET_MARKER));
    assert.ok(!loggedLines[0].includes(ABS_POSIX_LEAK));
  });

  it("diagrams_update maps store failure to generic without leaks", async () => {
    const tool = captureTool(
      registerDiagramsUpdate,
      ctxWith(
        failingStore({
          exists: () => Promise.reject(new Error(`EACCES ${ABS_WINDOWS_LEAK} ${SECRET_MARKER}`)),
          write: () => Promise.reject(new Error("unreached")),
        }),
      ),
    );
    const result = await tool.handler({
      relative_path: "models/a.puml",
      content: "@startuml\nclass A\n@enduml\n",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.ok(!result.content[0].text.includes(SECRET_MARKER));
    assert.equal(loggedLines.length, 1);
    assert.ok(!loggedLines[0].includes(SECRET_MARKER));
    assert.ok(!loggedLines[0].includes(ABS_WINDOWS_LEAK));
  });

  it("diagrams_delete maps store failure to generic", async () => {
    const tool = captureTool(
      registerDiagramsDelete,
      ctxWith(
        failingStore({
          delete: () => Promise.reject(new TypeError("boom")),
        }),
      ),
    );
    const result = await tool.handler({ relative_path: "models/a.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.ok(!result.content[0].text.includes("boom"));
    assert.equal(loggedLines.length, 1);
  });

  it("diagrams_get maps store failure to generic", async () => {
    const tool = captureTool(
      registerDiagramsGet,
      ctxWith(
        failingStore({
          read: () => Promise.reject(new TypeError("boom")),
        }),
      ),
    );
    const result = await tool.handler({ relative_path: "models/a.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.equal(loggedLines.length, 1);
  });

  it("diagrams_list maps store failure to generic", async () => {
    const tool = captureTool(
      registerDiagramsList,
      ctxWith(
        failingStore({
          list: () => Promise.reject(new Error(`EACCES ${ABS_POSIX_LEAK}`)),
          getRoot: () => tmpRoot,
        }),
      ),
    );
    const result = await tool.handler({ type_filter: "all" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.ok(!result.content[0].text.includes(ABS_POSIX_LEAK));
    assert.equal(loggedLines.length, 1);
  });

  it("diagrams_render maps read-phase failure to generic", async () => {
    const tool = captureTool(
      registerDiagramsRender,
      ctxWith(
        failingStore({
          read: () => Promise.reject(new TypeError("boom")),
        }),
      ),
    );
    const result = await tool.handler({ relative_path: "models/a.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.equal(loggedLines.length, 1);
  });

  it("diagrams_check_consistency maps read-phase failure to generic", async () => {
    const tool = captureTool(
      registerDiagramsCheckConsistency,
      ctxWith(
        failingStore({
          read: () => Promise.reject(new TypeError("boom")),
        }),
      ),
    );
    const result = await tool.handler({ relative_path: "models/a.puml" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unexpected internal error/);
    assert.equal(loggedLines.length, 1);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http, { type RequestListener, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { MAX_REMOTE_BODY_BYTES } from "../../constants.js";
import { defaultFetchRemote, renderPlantUmlRemote } from "./plantumlRemote.js";
import { RenderError } from "./error.js";

async function withRemoteServer(
  handler: RequestListener,
  inspect: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image`;
  try {
    await inspect(url);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }
}

async function remoteBytes(url: string, timeoutMs = 2000): Promise<ArrayBuffer> {
  const response = await defaultFetchRemote(url, timeoutMs);
  return response.arrayBuffer();
}

function endStalledResponse(response: ServerResponse, tail?: Buffer): void {
  const fallback = setTimeout(() => response.end(tail), 2000);
  response.once("close", () => clearTimeout(fallback));
}

describe("remote PlantUML body download limits", () => {
  // Regression boundaries: empty / exact cap / declared overflow / streamed
  // overflow / decompressed overflow / stalled body / failed HTTP status.
  for (const size of [0, MAX_REMOTE_BODY_BYTES]) {
    it(`accepts a complete body of ${size} bytes without Content-Length`, async () => {
      await withRemoteServer(
        (_request, response) => {
          response.writeHead(200, { "Transfer-Encoding": "chunked" });
          response.end(Buffer.alloc(size, 0x61));
        },
        async (url) => {
          const bytes = Buffer.from(await remoteBytes(url));
          assert.deepEqual(bytes, Buffer.alloc(size, 0x61));
        },
      );
    });
  }

  it("rejects a declared oversized body before waiting for payload bytes", async () => {
    await withRemoteServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Length": MAX_REMOTE_BODY_BYTES + 1 });
        response.flushHeaders();
        endStalledResponse(response, Buffer.alloc(MAX_REMOTE_BODY_BYTES + 1));
      },
      async (url) => {
        await assert.rejects(remoteBytes(url, 500), {
          name: "RenderError",
          message: /response exceeded the 5000000-byte limit/,
        });
      },
    );
  });

  it("rejects an unknown length overflow before the server ends its response", async () => {
    let disconnected: Promise<unknown> | undefined;
    await withRemoteServer(
      (_request, response) => {
        disconnected = once(response, "close", { signal: AbortSignal.timeout(1500) });
        response.writeHead(200, { "Transfer-Encoding": "chunked" });
        response.write(Buffer.alloc(MAX_REMOTE_BODY_BYTES, 0x61));
        response.write("x");
        endStalledResponse(response);
      },
      async (url) => {
        await assert.rejects(remoteBytes(url, 1000), {
          name: "RenderError",
          message: /response exceeded the 5000000-byte limit/,
        });
        assert.ok(disconnected);
        await disconnected;
      },
    );
  });

  it("caps decoded bytes when a small compressed response expands past the limit", async () => {
    const compressed = gzipSync(Buffer.alloc(MAX_REMOTE_BODY_BYTES + 1, 0x61));
    await withRemoteServer(
      (_request, response) => {
        response.writeHead(200, {
          "Content-Encoding": "gzip",
          "Content-Length": compressed.byteLength,
        });
        response.end(compressed);
      },
      async (url) => {
        await assert.rejects(remoteBytes(url), {
          name: "RenderError",
          message: /response exceeded the 5000000-byte limit/,
        });
      },
    );
  });

  it("times out a body that stalls after response headers and a partial payload", async () => {
    let sentHeaders = false;
    await withRemoteServer(
      (_request, response) => {
        response.writeHead(200, { "Transfer-Encoding": "chunked" });
        response.write("<svg>");
        sentHeaders = true;
        endStalledResponse(response);
      },
      async (url) => {
        await assert.rejects(remoteBytes(url, 500), {
          name: "RenderError",
          message: /request timed out after 500ms/,
        });
        assert.equal(sentHeaders, true);
      },
    );
  });

  it("preserves HTTP status errors without waiting for an error response body", async () => {
    await withRemoteServer(
      (_request, response) => {
        response.writeHead(503);
        response.flushHeaders();
      },
      async (url) => {
        await assert.rejects(
          renderPlantUmlRemote("@startuml\nclass Widget\n@enduml", "svg", {
            commandExists: async () => false,
            runCommand: async () => ({ stdout: "", stderr: "" }),
            fetchRemote: () => defaultFetchRemote(url, 500),
          }),
          (error: unknown) => {
            assert.ok(error instanceof RenderError);
            assert.match(error.message, /server responded with 503/);
            return true;
          },
        );
      },
    );
  });
});

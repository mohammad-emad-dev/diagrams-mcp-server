import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  MAX_REMOTE_BODY_BYTES,
  PLANTUML_SERVER_URL,
  REMOTE_FETCH_TIMEOUT_MS,
} from "../../constants.js";
import { RenderError } from "./error.js";
import type { RenderFormat, RendererDeps, RemoteRenderResponse } from "./types.js";

const deflateRawAsync = promisify(zlib.deflateRaw);

/** PlantUML's "deflate + custom base64" encoding for its HTTP rendering API. */
// Async so huge sources compress off the event loop instead of stalling
// the server. Exported as a test seam (same precedent as resolveSpawnTarget).
export async function encodePlantUmlForUrl(source: string): Promise<string> {
  const deflated = await deflateRawAsync(Buffer.from(source, "utf-8"), {
    level: 9,
  });
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

  let result = "";
  for (let i = 0; i < deflated.length; i += 3) {
    const b1 = deflated[i];
    const b2 = i + 1 < deflated.length ? deflated[i + 1] : 0;
    const b3 = i + 2 < deflated.length ? deflated[i + 2] : 0;

    result += alphabet[b1 >> 2];
    result += alphabet[((b1 & 0x3) << 4) | (b2 >> 4)];
    if (i + 1 < deflated.length) {
      result += alphabet[((b2 & 0xf) << 2) | (b3 >> 6)];
    }
    if (i + 2 < deflated.length) {
      result += alphabet[b3 & 0x3f];
    }
  }
  return result;
}

// Exported as a test seam (same precedent as resolveSpawnTarget).
export async function defaultFetchRemote(
  url: string,
  timeoutMs = REMOTE_FETCH_TIMEOUT_MS,
): Promise<RemoteRenderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const lengthHeader = response.headers.get("content-length");
    const contentLength = lengthHeader === null ? null : Number(lengthHeader);
    return {
      ok: response.ok,
      status: response.status,
      contentLength: contentLength === null || Number.isNaN(contentLength) ? null : contentLength,
      arrayBuffer: () => response.arrayBuffer(),
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RenderError(
        `PlantUML rendering request timed out after ${timeoutMs}ms and was stopped. ` +
          `Install a local 'plantuml' CLI for offline rendering.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function renderPlantUmlRemote(
  source: string,
  format: RenderFormat,
  deps: Required<RendererDeps>,
): Promise<Buffer> {
  const encoded = await encodePlantUmlForUrl(source);
  const url = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;

  const response = await deps.fetchRemote(url);
  if (!response.ok) {
    throw new RenderError(
      `PlantUML rendering server responded with ${response.status}. ` +
        `Install a local 'plantuml' CLI for offline rendering, or check the diagram syntax.`,
    );
  }
  // Bound the remote body before buffering it: a declared over-cap length
  // rejects without reading, and the buffered length is re-checked for
  // missing or lying headers. The error never includes body bytes.
  const declared = response.contentLength ?? null;
  if (declared !== null && declared > MAX_REMOTE_BODY_BYTES) {
    throw overRemoteBodyCap();
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_REMOTE_BODY_BYTES) {
    throw overRemoteBodyCap();
  }
  return Buffer.from(arrayBuffer);
}

export function overRemoteBodyCap(): RenderError {
  return new RenderError(
    `PlantUML rendering response exceeded the ${MAX_REMOTE_BODY_BYTES}-byte ` +
      `limit and was discarded. Install a local 'plantuml' CLI for offline rendering.`,
  );
}

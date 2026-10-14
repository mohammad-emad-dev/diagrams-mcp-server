export type RenderFormat = "svg" | "png";

// Minimal remote-render response shape, kept narrow for tests.
export interface RemoteRenderResponse {
  ok: boolean;
  status: number;
  contentLength?: number | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

// Seams for the process/network edges. Omitted fields use the real
// implementation; callers in production pass nothing.
export interface RendererDeps {
  commandExists?: (cmd: string) => Promise<boolean>;
  runCommand?: (
    cmd: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  fetchRemote?: (url: string) => Promise<RemoteRenderResponse>;
}

/** Which path produced a rendered image, for provenance reporting. */
export type RenderProvenance = "local-plantuml" | "remote-plantuml" | "mmdc";

export interface RenderResult {
  /** The rendered image bytes. */
  buffer: Buffer;
  /** Which path produced the buffer. */
  renderedWith: RenderProvenance;
}

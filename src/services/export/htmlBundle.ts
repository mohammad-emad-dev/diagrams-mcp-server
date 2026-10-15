// The export bundle: one self-contained HTML file holding a rendered diagram
// and, optionally, the source that produced it. Pure string building — no
// filesystem, no state, no dependencies — so the same input always yields the
// same bytes, and the wrapper is locked by exportGoldens.test.ts.
//
// Renderer markup is isolated in an SVG image, rather than parsed into the
// HTML document. SVG image processing disables scripts and external resources.
// A restrictive CSP also limits the wrapper to inline styles and data images. The
// collapsible source block is a native <details> element, which needs no
// script.
//
// The only path anywhere in the bundle is the diagram's POSIX relative_path;
// absolute paths never reach it (asserted by the tool's unit tests).

import { toPosixPath } from "../../constants.js";
import type { DiagramType } from "../../types.js";

export interface BundleInput {
  /** Diagram path as the tool received it; rendered POSIX-form. */
  relativePath: string;
  /** Dialect of the diagram, from its extension. */
  diagramType: DiagramType;
  /** Already-rendered SVG markup, straight from the renderer. */
  svg: string;
  /** Stored source; null omits the <pre> block entirely. */
  source: string | null;
  /** Renderer provenance: local-plantuml / remote-plantuml / mmdc. */
  renderedWith: string;
}

export interface ExportBundle {
  /** The complete HTML document. */
  html: string;
  /** Character length of the SVG image source after preamble stripping. */
  svgChars: number;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Preserve literal entity spellings as text: "&amp;" becomes "&amp;amp;".
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] as string);
}

/**
 * Keep the export's existing normalization of XML declarations and DOCTYPEs
 * so switching to image encoding preserves the reported SVG character count.
 * The drawing itself is untouched. The character count measures the image source,
 * before its UTF-8 bytes are encoded for the data URL.
 */
function stripSvgPreamble(svg: string): string {
  return svg.replace(/^\s*<\?xml[^>]*\?>\s*/i, "").replace(/^\s*<!DOCTYPE[^>]*>\s*/i, "");
}

// Inline styles only. No url(), no @import, no imported font: generic
// sans-serif keeps the file standalone on any platform.
const BUNDLE_CSS = [
  "body{margin:2rem auto;max-width:60rem;padding:0 1rem;font-family:sans-serif;" +
    "line-height:1.5;color:#1a1a1a;background:#fff}",
  "h1{font-size:1.25rem;word-break:break-word}",
  "p.meta{margin:0 0 1.5rem;color:#555;font-size:.9rem}",
  "main.diagram{overflow:auto;border:1px solid #ddd;padding:1rem;background:#fff}",
  "main.diagram img{max-width:100%;height:auto}",
  "details.source{margin-top:2rem;border-top:1px solid #ccc;padding-top:1rem}",
  "details.source pre{margin:0;padding:1rem;background:#f5f5f5;overflow:auto;" +
    "font-size:.85rem;line-height:1.4}",
].join("\n");

/** The dialect as a word, for the one prose line under the heading. */
function dialectName(diagramType: DiagramType): string {
  return diagramType === "plantuml" ? "PlantUML" : "Mermaid";
}

/**
 * Build the bundle. The SVG is encoded as an isolated image; the source, when
 * present, is escaped and wrapped in a native <details> disclosure. Both the
 * <title> and the <h1> carry the POSIX relative path, which is the only path
 * in the document.
 */
export function buildExportBundle(input: BundleInput): ExportBundle {
  const posixPath = toPosixPath(input.relativePath);
  const escapedPath = escapeHtml(posixPath);
  const imageSvg = stripSvgPreamble(input.svg);
  const imageData = Buffer.from(imageSvg, "utf-8").toString("base64");

  const head = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
      "img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" +
      '">',
    `<title>${escapedPath}</title>`,
    "<style>",
    BUNDLE_CSS,
    "</style>",
    "</head>",
    "<body>",
    "<header>",
    `<h1>${escapedPath}</h1>`,
    `<p class="meta">${dialectName(input.diagramType)} diagram exported from ` +
      `diagrams-mcp-server, rendered with ${escapeHtml(input.renderedWith)}.</p>`,
    "</header>",
    '<main class="diagram">',
    `<img alt="${escapedPath}" src="data:image/svg+xml;base64,${imageData}">`,
    "</main>",
  ];

  // The source block is optional and entirely absent when it is: no empty
  // <details>, no placeholder text, and source_included reports false.
  if (input.source !== null) {
    head.push(
      '<details class="source">',
      "<summary>Diagram source</summary>",
      `<pre><code>${escapeHtml(input.source)}</code></pre>`,
      "</details>",
    );
  }

  head.push("</body>", "</html>", "");

  return {
    html: head.join("\n"),
    svgChars: imageSvg.length,
  };
}

/** Bundle plus its UTF-8 size, so export and save-export measure the same bytes. */
export interface SizedExportBundle extends ExportBundle {
  /** UTF-8 byte length of `html`, the value the export cap enforces. */
  byteLength: number;
}

/**
 * Build the bundle and measure it in one step. Both export tools use this so
 * the capped size is always the finished HTML document, never the raw SVG.
 */
export function buildSizedExportBundle(input: BundleInput): SizedExportBundle {
  const bundle = buildExportBundle(input);
  return { ...bundle, byteLength: Buffer.byteLength(bundle.html, "utf-8") };
}

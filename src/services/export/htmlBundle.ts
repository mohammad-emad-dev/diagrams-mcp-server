// The export bundle: one self-contained HTML file holding a rendered diagram
// and, optionally, the source that produced it. Pure string building — no
// filesystem, no state, no dependencies — so the same input always yields the
// same bytes, and the wrapper is locked by exportGoldens.test.ts.
//
// The artifact has to work fully offline and survive a strict CSP, so it pulls
// in nothing: no src/href URLs, no @import, no script, no web font, no
// base64-in-img. The SVG is inlined as live markup (not a data URL) so it stays
// selectable and themeable, and inline <style> is the only styling. The
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
  /** Character length of the SVG as it was inlined (after preamble stripping). */
  svgChars: number;
}

/**
 * Escape text for HTML element and attribute content. The ampersand goes first
 * so an input containing a literal "&amp;" is not double-escaped into
 * "&amp;amp;". Source goes through this before it lands in <pre><code>, so a
 * diagram containing "<" or "-->" cannot break out of the block.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renderer SVG usually opens with an XML declaration and sometimes a DOCTYPE.
 * Neither is valid inside an HTML document (both are bogus-comment or
 * doctype-token territory for the parser), so they are dropped here and the
 * drawing itself is untouched. What remains starts at the <svg> element, which
 * is what the golden locks and what the inlined character count measures.
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
  "main.diagram svg{max-width:100%;height:auto}",
  "details.source{margin-top:2rem;border-top:1px solid #ccc;padding-top:1rem}",
  "details.source pre{margin:0;padding:1rem;background:#f5f5f5;overflow:auto;" +
    "font-size:.85rem;line-height:1.4}",
].join("\n");

/** The dialect as a word, for the one prose line under the heading. */
function dialectName(diagramType: DiagramType): string {
  return diagramType === "plantuml" ? "PlantUML" : "Mermaid";
}

/**
 * Build the bundle. The SVG is inlined verbatim as markup; the source, when
 * present, is escaped and wrapped in a native <details> disclosure. Both the
 * <title> and the <h1> carry the POSIX relative path, which is the only path
 * in the document.
 */
export function buildExportBundle(input: BundleInput): ExportBundle {
  const posixPath = toPosixPath(input.relativePath);
  const escapedPath = escapeHtml(posixPath);
  const inlinedSvg = stripSvgPreamble(input.svg);

  const head = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapedPath}</title>`,
    "<style>",
    BUNDLE_CSS,
    "</style>",
    "</head>",
    "<body>",
    "<header>",
    `<h1>${escapedPath}</h1>`,
    `<p class="meta">${dialectName(input.diagramType)} diagram exported from ` +
      `diagrams-mcp-server, rendered with ${input.renderedWith}.</p>`,
    "</header>",
    '<main class="diagram">',
    inlinedSvg,
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
    svgChars: inlinedSvg.length,
  };
}

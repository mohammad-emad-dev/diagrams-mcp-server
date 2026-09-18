// Golden HTML wrapper for diagrams_export. The SVG and source are fixed, so
// these assertions lock the exact bundle structure the builder emits: any drift
// in the wrapper (title, SVG position, source block, escaping) shows up here as
// a failing golden. Two variants are locked — source embedded and source
// omitted — because the <pre> block is the only structural difference between
// them, and both must stay byte-stable.
//
// The golden carries an xmlns namespace declaration on the fixture SVG because
// every real renderer output has one. It is an XML namespace identifier, not a
// resource: nothing fetches it, and it is not one of the external-resource
// patterns the unit tests grep for (src=/href=/@import/<script>).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExportBundle } from "./htmlBundle.js";

const RELATIVE_PATH = "models/order-flow.puml";

// Small, but a realistic renderer shape: a root <svg> with a namespace, a shape,
// and text. One line, no trailing newline — the way mmdc/plantuml emit SVG.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" ' +
  'viewBox="0 0 120 40"><rect width="120" height="40" rx="4" ' +
  'fill="#f5f5f5"/><text x="8" y="24">Order</text></svg>';

// Stored diagrams end with a newline, so the golden does too: the escape path
// and the trailing newline inside <pre> are part of what is locked.
const SOURCE = ["@startuml", "title Order Flow", "Order --> Payment : charge", "@enduml", ""].join(
  "\n",
);

describe("export bundle goldens", () => {
  it("locks the full wrapper with the source block embedded", () => {
    const { html, svgChars } = buildExportBundle({
      relativePath: RELATIVE_PATH,
      diagramType: "plantuml",
      svg: SVG,
      source: SOURCE,
      renderedWith: "local-plantuml",
    });

    assert.equal(svgChars, SVG.length);
    assert.equal(
      html,
      [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        "<title>models/order-flow.puml</title>",
        "<style>",
        "body{margin:2rem auto;max-width:60rem;padding:0 1rem;font-family:sans-serif;" +
          "line-height:1.5;color:#1a1a1a;background:#fff}",
        "h1{font-size:1.25rem;word-break:break-word}",
        "p.meta{margin:0 0 1.5rem;color:#555;font-size:.9rem}",
        "main.diagram{overflow:auto;border:1px solid #ddd;padding:1rem;background:#fff}",
        "main.diagram svg{max-width:100%;height:auto}",
        "details.source{margin-top:2rem;border-top:1px solid #ccc;padding-top:1rem}",
        "details.source pre{margin:0;padding:1rem;background:#f5f5f5;overflow:auto;" +
          "font-size:.85rem;line-height:1.4}",
        "</style>",
        "</head>",
        "<body>",
        "<header>",
        "<h1>models/order-flow.puml</h1>",
        '<p class="meta">PlantUML diagram exported from diagrams-mcp-server, ' +
          "rendered with local-plantuml.</p>",
        "</header>",
        '<main class="diagram">',
        SVG,
        "</main>",
        '<details class="source">',
        "<summary>Diagram source</summary>",
        "<pre><code>@startuml",
        "title Order Flow",
        "Order --&gt; Payment : charge",
        "@enduml",
        "</code></pre>",
        "</details>",
        "</body>",
        "</html>",
        "",
      ].join("\n"),
    );
  });

  it("locks the wrapper with the source block omitted", () => {
    const { html, svgChars } = buildExportBundle({
      relativePath: RELATIVE_PATH,
      diagramType: "mermaid",
      svg: SVG,
      source: null,
      renderedWith: "mmdc",
    });

    assert.equal(svgChars, SVG.length);
    assert.equal(
      html,
      [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        "<title>models/order-flow.puml</title>",
        "<style>",
        "body{margin:2rem auto;max-width:60rem;padding:0 1rem;font-family:sans-serif;" +
          "line-height:1.5;color:#1a1a1a;background:#fff}",
        "h1{font-size:1.25rem;word-break:break-word}",
        "p.meta{margin:0 0 1.5rem;color:#555;font-size:.9rem}",
        "main.diagram{overflow:auto;border:1px solid #ddd;padding:1rem;background:#fff}",
        "main.diagram svg{max-width:100%;height:auto}",
        "details.source{margin-top:2rem;border-top:1px solid #ccc;padding-top:1rem}",
        "details.source pre{margin:0;padding:1rem;background:#f5f5f5;overflow:auto;" +
          "font-size:.85rem;line-height:1.4}",
        "</style>",
        "</head>",
        "<body>",
        "<header>",
        "<h1>models/order-flow.puml</h1>",
        '<p class="meta">Mermaid diagram exported from diagrams-mcp-server, ' +
          "rendered with mmdc.</p>",
        "</header>",
        '<main class="diagram">',
        SVG,
        "</main>",
        "</body>",
        "</html>",
        "",
      ].join("\n"),
    );
  });

  it("places the SVG before the source block and escapes source markup", () => {
    const { html } = buildExportBundle({
      relativePath: RELATIVE_PATH,
      diagramType: "plantuml",
      svg: SVG,
      source: SOURCE,
      renderedWith: "remote-plantuml",
    });

    // A reader sees the drawing first, then the source that produced it.
    assert.ok(
      html.indexOf(SVG) < html.indexOf("<details"),
      "the SVG must precede the source block",
    );
    // The one character that proves escaping happened: a raw arrow would close
    // or corrupt the <pre> content if it were emitted verbatim.
    assert.ok(html.includes("Order --&gt; Payment : charge"), "source markup must be escaped");
    assert.ok(!html.includes("Order --> Payment"), "no raw source markup may survive escaping");
    // The title element and the heading both carry the POSIX relative path.
    assert.ok(html.includes("<title>models/order-flow.puml</title>"));
    assert.ok(html.includes("<h1>models/order-flow.puml</h1>"));
  });
});

// Golden HTML wrapper for diagrams_export. The SVG and source are fixed, so
// these assertions lock the exact bundle structure the builder emits: any drift
// in the wrapper (title, image position, source block, escaping) shows up here as
// a failing golden. Two variants are locked — source embedded and source
// omitted — because the <pre> block is the only structural difference between
// them, and both must stay byte-stable.
//
// The fixture includes the SVG namespace required by the decoded image source.

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
const SVG_IMAGE = `<img alt="models/order-flow.puml" src="data:image/svg+xml;base64,${Buffer.from(SVG, "utf-8").toString("base64")}">`;

const SOURCE = ["@startuml", "title Order Flow", "Order --> Payment : charge", "@enduml", ""].join(
  "\n",
);

describe("export bundle goldens", () => {
  it("isolates hostile renderer markup and escapes provenance in the HTML wrapper", () => {
    const payloads = [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://example.invalid/"></iframe></foreignObject></svg>',
      '</main><script>alert(1)</script><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>',
    ];
    for (const svg of payloads) {
      const { html, svgChars } = buildExportBundle({
        relativePath: RELATIVE_PATH,
        diagramType: "plantuml",
        svg,
        source: null,
        renderedWith: "</p><script>alert(2)</script>",
      });
      assert.ok(!html.includes("<svg"));
      assert.ok(!html.includes("<script"));
      assert.ok(!html.includes("<iframe"));
      assert.ok(html.includes("default-src 'none'; img-src data:"));
      const encoded = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(html)?.[1];
      assert.ok(encoded);
      assert.equal(Buffer.from(encoded, "base64").toString("utf-8"), svg);
      assert.equal(svgChars, svg.length);
      assert.ok(html.includes("&lt;/p&gt;&lt;script&gt;alert(2)&lt;/script&gt;"));
    }
  });

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
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">",
        "<title>models/order-flow.puml</title>",
        "<style>",
        "body{margin:2rem auto;max-width:60rem;padding:0 1rem;font-family:sans-serif;" +
          "line-height:1.5;color:#1a1a1a;background:#fff}",
        "h1{font-size:1.25rem;word-break:break-word}",
        "p.meta{margin:0 0 1.5rem;color:#555;font-size:.9rem}",
        "main.diagram{overflow:auto;border:1px solid #ddd;padding:1rem;background:#fff}",
        "main.diagram img{max-width:100%;height:auto}",
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
        SVG_IMAGE,
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
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">",
        "<title>models/order-flow.puml</title>",
        "<style>",
        "body{margin:2rem auto;max-width:60rem;padding:0 1rem;font-family:sans-serif;" +
          "line-height:1.5;color:#1a1a1a;background:#fff}",
        "h1{font-size:1.25rem;word-break:break-word}",
        "p.meta{margin:0 0 1.5rem;color:#555;font-size:.9rem}",
        "main.diagram{overflow:auto;border:1px solid #ddd;padding:1rem;background:#fff}",
        "main.diagram img{max-width:100%;height:auto}",
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
        SVG_IMAGE,
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
      html.indexOf(SVG_IMAGE) < html.indexOf("<details"),
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

  it("escapes literal entities, adjacent specials, unicode and multiline text in one pass", () => {
    const cases: Array<{
      relativePath: string;
      expectedPath: string;
      source: string;
      expectedSource: string;
    }> = [
      {
        relativePath: "models/fish&amp;chips.puml",
        expectedPath: "models/fish&amp;amp;chips.puml",
        source: "Tom &amp; Jerry &lt;3",
        expectedSource: "Tom &amp;amp; Jerry &amp;lt;3",
      },
      {
        relativePath: "models/&<>\"'.puml",
        expectedPath: "models/&amp;&lt;&gt;&quot;&#39;.puml",
        source: "&<>\"'",
        expectedSource: "&amp;&lt;&gt;&quot;&#39;",
      },
      {
        relativePath: "models/café-日本語-🎨.puml",
        expectedPath: "models/café-日本語-🎨.puml",
        source: "café — 日本語 🎨 & < >",
        expectedSource: "café — 日本語 🎨 &amp; &lt; &gt;",
      },
      {
        relativePath: "models/multi&<test>.puml",
        expectedPath: "models/multi&amp;&lt;test&gt;.puml",
        source: "first <line>\nsecond & \"quoted\"\nthird 'tick' ☃",
        expectedSource:
          "first &lt;line&gt;\nsecond &amp; &quot;quoted&quot;\nthird &#39;tick&#39; ☃",
      },
    ];

    for (const { relativePath, expectedPath, source, expectedSource } of cases) {
      const { html, svgChars } = buildExportBundle({
        relativePath,
        diagramType: "plantuml",
        svg: SVG,
        source,
        renderedWith: "local-plantuml",
      });

      assert.equal(svgChars, SVG.length);
      assert.ok(html.includes(`<title>${expectedPath}</title>`));
      assert.ok(html.includes(`<h1>${expectedPath}</h1>`));
      assert.ok(html.includes(`<pre><code>${expectedSource}</code></pre>`));
      const encoded = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(html)?.[1];
      assert.ok(encoded);
      assert.equal(Buffer.from(encoded, "base64").toString("utf-8"), SVG);
    }
  });
});

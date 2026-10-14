import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchEntities } from "./entityMatching.js";
import type { ScannedFile } from "./fileAnalysis.js";
import type { SequenceEntityKind } from "./sequence/sequenceEntities.js";

function scannedFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    relativePath: "source.ts",
    ext: ".ts",
    stripped: "Referenced",
    normalized: " referenced ",
    declared: new Set(),
    operations: new Set(),
    moduleName: "source",
    tsStrict: true,
    ...overrides,
  };
}

describe("entity matching policy", () => {
  const cases: Array<{
    name: string;
    kind: SequenceEntityKind;
    file: ScannedFile;
    matched: boolean;
  }> = [
    {
      name: "strict structural names reject incidental text",
      kind: "structural",
      file: scannedFile(),
      matched: false,
    },
    {
      name: "strict participants reject incidental text",
      kind: "participant",
      file: scannedFile(),
      matched: false,
    },
    {
      name: "heuristic structural names retain text fallback",
      kind: "structural",
      file: scannedFile({ tsStrict: false }),
      matched: true,
    },
    {
      name: "strict operations retain text fallback",
      kind: "operation",
      file: scannedFile(),
      matched: true,
    },
    {
      name: "strict structural names accept normalized module identity",
      kind: "structural",
      file: scannedFile({ moduleName: "refer_enced", stripped: "", normalized: "  " }),
      matched: true,
    },
    {
      name: "operations reject module-only identity",
      kind: "operation",
      file: scannedFile({ moduleName: "Referenced", stripped: "", normalized: "  " }),
      matched: false,
    },
    {
      name: "structural names accept exact declarations without text",
      kind: "structural",
      file: scannedFile({ declared: new Set(["Referenced"]), stripped: "", normalized: "  " }),
      matched: true,
    },
    {
      name: "operations accept exact operation declarations without text",
      kind: "operation",
      file: scannedFile({ operations: new Set(["Referenced"]), stripped: "", normalized: "  " }),
      matched: true,
    },
  ];

  for (const scenario of cases) {
    it(scenario.name, () => {
      const result = matchEntities(["Referenced"], new Map([["Referenced", scenario.kind]]), [
        scenario.file,
      ]);
      assert.equal(result.matched, scenario.matched ? 1 : 0);
      assert.deepEqual(result.matchedEntities, scenario.matched ? ["Referenced"] : []);
      assert.deepEqual(result.unmatchedEntities, scenario.matched ? [] : ["Referenced"]);
      assert.equal(result.issues.length, scenario.matched ? 0 : 1);
      assert.deepEqual(result.evidence, [
        {
          name: "Referenced",
          matched: scenario.matched,
          analyzers: scenario.matched ? ["reliable"] : [],
          matchedFiles: scenario.matched ? ["source.ts"] : [],
          matchedFileCount: scenario.matched ? 1 : 0,
        },
      ]);
    });
  }

  it("caps evidence to the first ten scanned matches while sorting mixed analyzer tiers", () => {
    const paths = [
      "z.ts",
      "a.go",
      "m.swift",
      "b.js",
      "y.ts",
      "c.go",
      "x.swift",
      "d.js",
      "w.ts",
      "e.go",
      "v.swift",
      "f.js",
    ];
    const scanned = paths.map((relativePath) => {
      const ext = relativePath.slice(relativePath.lastIndexOf("."));
      return scannedFile({ relativePath, ext, tsStrict: ext === ".ts" });
    });
    const result = matchEntities(["Referenced"], new Map([["Referenced", "operation"]]), scanned);

    assert.equal(result.matched, 1);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.evidence, [
      {
        name: "Referenced",
        matched: true,
        analyzers: ["experimental", "generic", "reliable"],
        matchedFiles: [
          "z.ts",
          "a.go",
          "m.swift",
          "b.js",
          "y.ts",
          "c.go",
          "x.swift",
          "d.js",
          "w.ts",
          "e.go",
        ],
        matchedFileCount: 12,
      },
    ]);
  });
});

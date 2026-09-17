// Golden entity lists and emitted sources for diagrams_generate. The tmp
// codebase is fixed, so these assertions lock both the emission order and
// the emitted diagram text; any drift in the shared scan/analysis stack
// shows up here first.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectScopeEntities } from "./collectEntities.js";
import type { GenerateDeps, RelationEdge } from "./collectEntities.js";
import { emitMermaid, emitPlantUml } from "./emitters.js";
import { validateDiagramSource } from "../diagramValidator.js";

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }
}

// Every emitted source must clear the same gate diagrams_create enforces.
function assertValidBoth(
  entities: string[],
  relations: RelationEdge[],
): {
  puml: string;
  mermaid: string;
} {
  const puml = emitPlantUml(entities, relations);
  const mermaid = emitMermaid(entities, relations);
  validateDiagramSource(puml, "plantuml");
  validateDiagramSource(mermaid, "mermaid");
  return { puml, mermaid };
}

const FIXTURES = {
  "base.ts":
    "export interface Named {\n  name: string;\n}\n\nexport class Base {\n  id: number;\n}\n",
  "card.tsx": "export function Card(): null {\n  return null;\n}\n",
  "legacy.rb": "class Legacy\nend\n",
  "service.py": "class Service:\n    def handle(self):\n        pass\n",
  "widget.ts":
    "import { Base } from './base';\n\nexport class Widget extends Base implements Named {\n  id: number;\n}\n",
};

/** Deps that report no compiler, exercising the regex fallback. */
const NO_COMPILER: GenerateDeps = { loadTsModule: async () => null };

describe("generate goldens", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generate-goldens-"));
    await writeFiles(tmpRoot, FIXTURES);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("emits entities in POSIX-path then declaration order", async () => {
    const result = await collectScopeEntities(tmpRoot);
    // base.ts (Named, Base), card.tsx (Card), legacy.rb (no patterns),
    // service.py (Service, handle), widget.ts (Widget).
    assert.deepEqual(result.entities, ["Named", "Base", "Card", "Service", "handle", "Widget"]);
    assert.equal(result.entitiesAvailable, 6);
    assert.equal(result.filesScanned, 5);
    assert.equal(result.truncated, false);
    assert.equal(result.scanWarning, null);
  });

  it("evidences extends and implements edges between declared entities", async () => {
    const result = await collectScopeEntities(tmpRoot, { includeRelations: true });
    assert.deepEqual(result.relations, [
      { from: "Widget", to: "Base", kind: "extends" },
      { from: "Widget", to: "Named", kind: "implements" },
    ]);
    assert.equal(result.relationsAvailable, 2);
    assert.equal(result.dialectNote, null);
  });

  it("emits no relations and a note when the compiler is unavailable", async () => {
    const result = await collectScopeEntities(tmpRoot, {
      includeRelations: true,
      deps: NO_COMPILER,
    });
    assert.deepEqual(result.relations, []);
    assert.equal(result.relationsAvailable, 0);
    assert.equal(result.tsAstAvailable, false);
    assert.match(
      result.dialectNote ?? "",
      /relations unavailable: the TypeScript compiler is not installed; entities only/,
    );
    // Entities still come from the heuristic path, never a thrown error.
    assert.ok(result.entities.includes("Widget"));
    assert.ok(result.entities.includes("Service"));
  });

  it("keeps heuristic emission order when the compiler is unavailable", async () => {
    const result = await collectScopeEntities(tmpRoot, { deps: NO_COMPILER });
    // No AST: the js-family patterns fire class-first, so Base precedes
    // Named in base.ts; ruby still contributes nothing.
    assert.deepEqual(result.entities, ["Base", "Named", "Card", "Service", "handle", "Widget"]);
  });

  it("emits no relations and a note when no TypeScript-family files exist", async () => {
    const pyOnly = await fs.mkdtemp(path.join(os.tmpdir(), "generate-py-"));
    try {
      await writeFiles(pyOnly, { "service.py": FIXTURES["service.py"] });
      const result = await collectScopeEntities(pyOnly, { includeRelations: true });
      assert.deepEqual(result.relations, []);
      assert.match(result.dialectNote ?? "", /no TypeScript-family files in the scanned scope/);
    } finally {
      await fs.rm(pyOnly, { recursive: true, force: true });
    }
  });

  it("emits no relations and a note when include_relations is false", async () => {
    const result = await collectScopeEntities(tmpRoot, { includeRelations: false });
    assert.deepEqual(result.relations, []);
    assert.equal(result.relationsAvailable, 0);
    assert.match(result.dialectNote ?? "", /include_relations is false/);
  });

  it("caps entities and drops relations to capped endpoints", async () => {
    const result = await collectScopeEntities(tmpRoot, {
      includeRelations: true,
      maxEntities: 4,
    });
    assert.deepEqual(result.entities, ["Named", "Base", "Card", "Service"]);
    assert.equal(result.entitiesAvailable, 6);
    assert.equal(result.entitiesDropped, 2);
    // Widget is beyond the cap, so its edges have an undeclared endpoint.
    assert.deepEqual(result.relations, []);
    assert.equal(result.relationsAvailable, 2);
    assert.equal(result.relationsDropped, 2);
  });

  it("caps relations independently of the entity cap", async () => {
    const result = await collectScopeEntities(tmpRoot, {
      includeRelations: true,
      maxRelations: 1,
    });
    assert.deepEqual(result.relations, [{ from: "Widget", to: "Base", kind: "extends" }]);
    assert.equal(result.relationsAvailable, 2);
    assert.equal(result.relationsDropped, 1);
  });

  it("accepts a single file scope; unevidenced parents stay out", async () => {
    const result = await collectScopeEntities(path.join(tmpRoot, "widget.ts"));
    assert.deepEqual(result.entities, ["Widget"]);
    assert.equal(result.filesScanned, 1);
    // Base and Named are not declared in this scope, so their edges have no
    // evidenced endpoint and must not appear (cross-file parents are V2).
    assert.deepEqual(result.relations, []);
    assert.equal(result.relationsAvailable, 0);
  });

  it("reports an empty result with a note for a scope without code", async () => {
    const notCode = await collectScopeEntities(path.join(tmpRoot, "readme.md"));
    assert.deepEqual(notCode.entities, []);
    assert.equal(notCode.filesScanned, 0);
    assert.match(notCode.dialectNote ?? "", /no code files found in the scanned scope/);

    const missing = await collectScopeEntities(path.join(tmpRoot, "nope"));
    assert.deepEqual(missing.entities, []);
    assert.equal(missing.filesScanned, 0);
    assert.match(missing.dialectNote ?? "", /no code files found in the scanned scope/);
  });

  it("emits validated PlantUML and Mermaid for the golden entity list", async () => {
    const result = await collectScopeEntities(tmpRoot, { includeRelations: true });
    const emitted = assertValidBoth(result.entities, result.relations);

    assert.equal(
      emitted.puml,
      [
        "@startuml",
        "class Named",
        "class Base",
        "class Card",
        "class Service",
        "class handle",
        "class Widget",
        "Widget --|> Base",
        "Widget ..|> Named",
        "@enduml",
        "",
      ].join("\n"),
    );
    assert.equal(
      emitted.mermaid,
      [
        "classDiagram",
        "class Named",
        "class Base",
        "class Card",
        "class Service",
        "class handle",
        "class Widget",
        "Widget --|> Base",
        "Widget ..|> Named",
        "",
      ].join("\n"),
    );
  });

  it("emits a valid empty diagram for a file with no declarations", async () => {
    const result = await collectScopeEntities(path.join(tmpRoot, "legacy.rb"));
    assert.deepEqual(result.entities, []);
    assert.equal(result.filesScanned, 1);
    const emitted = assertValidBoth([], []);
    assert.equal(emitted.puml, "@startuml\n@enduml\n");
    assert.equal(emitted.mermaid, "classDiagram\n");
  });

  it("ignores non-code files in a directory walk", async () => {
    await writeFiles(tmpRoot, { "readme.md": "# Widget notes\n", "notes.txt": "Widget\n" });
    const result = await collectScopeEntities(tmpRoot);
    assert.equal(result.filesScanned, 5);
    assert.deepEqual(result.entities, ["Named", "Base", "Card", "Service", "handle", "Widget"]);
  });
});

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConsistency } from "../index.js";

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }
}

function sorted(names: string[]): string[] {
  return [...names].sort();
}

function issueNames(result: { issues: Array<{ name: string }> }): string[] {
  return sorted(result.issues.map((issue) => issue.name));
}

describe("ts goldens (heuristic baseline, Phase 2)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ts-goldens-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("matches TS classes, interfaces, types, and export aliases", async () => {
    await writeFiles(tmpRoot, {
      "user.ts":
        'export class User {\n  id = 0;\n}\nexport interface HasId {\n  id: number;\n}\nexport type Role = "admin" | "member";\n',
      "cart.ts": "export class Cart {}\nexport { Cart as ShoppingCart };\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/ts.puml",
        source:
          "@startuml\nclass User\nclass HasId\nclass Role\nclass Cart\nclass ShoppingCart\nclass Missing\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 6);
    assert.equal(result.entitiesMatched, 5);
    assert.deepEqual(issueNames(result), ["Missing"]);
    assert.equal(result.confidence, "heuristic");
    assert.equal(result.truncated, false);
  });

  it("matches TSX interfaces, types, and function components", async () => {
    await writeFiles(tmpRoot, {
      "Card.tsx":
        'export interface CardProps {\n  title: string;\n}\nexport type CardKind = "basic" | "rich";\nexport function Card({ title }: CardProps): string {\n  return title;\n}\n',
      "App.tsx":
        'import { Card } from "./Card";\nexport function App(): string {\n  return Card({ title: "x" });\n}\n',
    });
    const result = await checkConsistency(
      {
        relativePath: "models/card.puml",
        source: "@startuml\nclass Card\nclass CardProps\nclass CardKind\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 3);
    assert.equal(result.entitiesMatched, 3);
    assert.deepEqual(issueNames(result), []);
    assert.equal(result.filesScanned, 2);
  });

  it("keeps unparseable files on the fallback path (unmatched stays unmatched)", async () => {
    await writeFiles(tmpRoot, {
      "other.ts": "export class {{{ oops\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/broken.puml",
        source: "@startuml\nclass Broken\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 1);
    assert.equal(result.entitiesMatched, 0);
    assert.deepEqual(issueNames(result), ["Broken"]);
  });

  it("locks the V1 barrel limit: direct declarations match, export-star adds nothing", async () => {
    await writeFiles(tmpRoot, {
      "models/user.ts": "export class Profile {}\n",
      "models/index.ts": 'export * from "./user";\n',
    });
    const result = await checkConsistency(
      {
        relativePath: "models/barrel.puml",
        source: "@startuml\nclass Profile\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.evidence[0]?.matchedFileCount, 1);
    assert.deepEqual(result.evidence[0]?.matchedFiles, ["models/user.ts"]);
  });

  it("applies AST strictness: incidental-only names stop matching on parsed TS", async () => {
    await writeFiles(tmpRoot, {
      "orders.ts":
        "export interface Order {\n  User: string;\n}\nexport const orders: Order[] = [];\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/strict.puml",
        source: "@startuml\nclass User\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    // `User` is a property type, not a declaration: the AST-strict path
    // skips the whole-word fallback that matched it before Phase 3.
    assert.equal(result.entitiesMatched, 0);
    assert.deepEqual(issueNames(result), ["User"]);
  });
});

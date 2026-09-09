import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConsistency, extractEntities } from "./consistencyChecker.js";

const USER_CLASS_PUML = `@startuml
title User Domain Model
class User {
  +id: int
  +name: string
  +email: string
}
class Order {
  +id: int
  +userId: int
  +total: float
}
User "1" -- "many" Order : places
@enduml
`;

const ORDER_FLOW_MMD = `sequenceDiagram
    participant Customer
    participant OrderService
    participant PaymentService
    participant Inventory

    Customer->>OrderService: Create order
    OrderService->>Inventory: Reserve items
    Inventory-->>OrderService: Reserved
    OrderService->>PaymentService: Charge payment
    PaymentService-->>OrderService: Payment confirmed
    OrderService-->>Customer: Order confirmed
`;

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

describe("extractEntities (plantuml)", () => {
  it("extracts classes, interfaces, enums, records, abstract, generics, and aliases", () => {
    const source = `@startuml
abstract class AbstractRepo
class User<T> {
  +id: int
}
interface HasId
enum Role
record Session
class "Spaced Name" as SpacedAlias
@enduml
`;
    const entities = extractEntities(source, "plantuml");
    for (const expected of ["AbstractRepo", "User", "HasId", "Role", "Session", "SpacedAlias"]) {
      assert.ok(entities.includes(expected), `expected entity '${expected}'`);
    }
  });

  it("extracts namespaces, components, and participants", () => {
    const source = `@startuml
namespace App.Models {
  class User
}
package shop {
  class Cart
}
component [Billing]
component "Reporting" as Reports
participant OrderService
actor Customer
participant "Old Name" as NewName
@enduml
`;
    const entities = extractEntities(source, "plantuml");
    for (const expected of [
      "Models",
      "shop",
      "Billing",
      "Reporting",
      "Reports",
      "OrderService",
      "Customer",
      "NewName",
    ]) {
      assert.ok(entities.includes(expected), `expected entity '${expected}'`);
    }
  });

  it("extracts sequence message calls but ignores plain labels", () => {
    const source = `@startuml
Alice -> Bob : charge(card)
User "1" -- "many" Order : places
@enduml
`;
    assert.deepEqual(sorted(extractEntities(source, "plantuml")), ["charge"]);
  });

  it("keeps the bundled class-diagram syntax working", () => {
    assert.deepEqual(sorted(extractEntities(USER_CLASS_PUML, "plantuml")), ["Order", "User"]);
  });
});

describe("extractEntities (mermaid)", () => {
  it("extracts classDiagram classes, annotations, and namespaces", () => {
    const source = `classDiagram
  class Animal {
    +name : string
  }
  <<interface>> Pet
  namespace shop {
    class Cart
  }
`;
    const entities = extractEntities(source, "mermaid");
    for (const expected of ["Animal", "Pet", "shop", "Cart"]) {
      assert.ok(entities.includes(expected), `expected entity '${expected}'`);
    }
  });

  it("extracts sequence participants and actors including aliases", () => {
    const source = `sequenceDiagram
  participant Customer
  participant OrderService
  actor Inventory
  participant O as OldSystem
  create participant Audit
`;
    const entities = extractEntities(source, "mermaid");
    for (const expected of ["Customer", "OrderService", "Inventory", "O", "OldSystem", "Audit"]) {
      assert.ok(entities.includes(expected), `expected entity '${expected}'`);
    }
  });

  it("extracts message calls with parentheses and ignores plain labels", () => {
    const source = `sequenceDiagram
  Customer->>OrderService: doThing(item)
  Customer->>OrderService: Create order
`;
    assert.deepEqual(sorted(extractEntities(source, "mermaid")), ["doThing"]);
  });

  it("keeps the bundled order-flow sequence diagram working", () => {
    assert.deepEqual(sorted(extractEntities(ORDER_FLOW_MMD, "mermaid")), [
      "Customer",
      "Inventory",
      "OrderService",
      "PaymentService",
    ]);
  });
});

describe("checkConsistency", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consistency-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("matches JavaScript classes, functions, and exports; flags the missing one", async () => {
    await writeFiles(tmpRoot, {
      "user.js":
        "export class User {}\nexport function login(name) {\n  return name;\n}\nexport const helper = 42;\nexport { login };\n",
    });
    const result = await checkConsistency(
      "models/auth.puml",
      "@startuml\nclass User\nclass login\nclass helper\nclass Missing\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 4);
    assert.equal(result.entitiesMatched, 3);
    assert.deepEqual(issueNames(result), ["Missing"]);
    assert.equal(result.filesScanned, 1);
  });

  it("matches TypeScript interfaces, types, functions, and TSX components", async () => {
    await writeFiles(tmpRoot, {
      "models.ts":
        'export interface User {\n  id: number;\n}\nexport type Role = "admin" | "user";\nexport function greet(name: string): string {\n  return name;\n}\n',
      "Button.tsx": "export function Button() {\n  return null;\n}\n",
    });
    const result = await checkConsistency(
      "models/ui.puml",
      "@startuml\nclass Button\nclass User\nclass Role\nclass greet\nclass Ghost\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 4);
    assert.deepEqual(issueNames(result), ["Ghost"]);
    assert.equal(result.filesScanned, 2);
  });

  it("matches Python classes and functions; flags the missing one", async () => {
    await writeFiles(tmpRoot, {
      "services.py": "class Order:\n    pass\n\n\ndef charge(amount):\n    return amount\n",
    });
    const result = await checkConsistency(
      "models/shop.puml",
      "@startuml\nclass Order\nclass charge\nclass Missing\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 3);
    assert.equal(result.entitiesMatched, 2);
    assert.deepEqual(issueNames(result), ["Missing"]);
  });

  it("matches PHP classes, interfaces, traits, functions, and namespaces", async () => {
    await writeFiles(tmpRoot, {
      "src/User.php":
        "<?php\nnamespace App\\Models;\n\nclass User {}\ninterface HasId {}\ntrait Timestamps {}\nfunction boot() {}\n",
    });
    const result = await checkConsistency(
      "models/user.puml",
      "@startuml\nclass User\nclass HasId\nclass Timestamps\nclass boot\nclass Models\nclass Missing\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 6);
    assert.equal(result.entitiesMatched, 5);
    assert.deepEqual(issueNames(result), ["Missing"]);
  });

  it("matches Java classes, interfaces, enums, records, and packages", async () => {
    await writeFiles(tmpRoot, {
      "shop/User.java":
        "package com.example.shop;\n\npublic record User(String name) {}\npublic enum Role { ADMIN }\npublic interface Repo {}\n",
    });
    const result = await checkConsistency(
      "models/user.puml",
      "@startuml\nclass User\nclass Role\nclass Repo\nclass shop\nclass Missing\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 4);
    assert.deepEqual(issueNames(result), ["Missing"]);
  });

  it("normalizes case and separators between diagram and code names", async () => {
    await writeFiles(tmpRoot, {
      "user_service.py": "def user_service():\n    pass\n",
    });
    const result = await checkConsistency(
      "models/svc.puml",
      "@startuml\nclass UserService\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 1);
    assert.equal(result.entitiesMatched, 1);
    assert.deepEqual(result.issues, []);
  });

  it("ignores names that appear only in comments", async () => {
    await writeFiles(tmpRoot, {
      "app.js":
        "// UserService handles everything\n/* OrderService is legacy */\nconst active = true;\n",
    });
    const result = await checkConsistency(
      "models/svc.puml",
      "@startuml\nclass UserService\nclass OrderService\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesMatched, 0);
    assert.deepEqual(issueNames(result), ["OrderService", "UserService"]);
  });

  it("ignores names that appear only in quoted strings", async () => {
    await writeFiles(tmpRoot, {
      "app.js": "const primary = \"UserService\";\nconst backup = 'OrderService';\n",
      "notes.py": 'summary = """GhostService is planned"""\n',
    });
    const result = await checkConsistency(
      "models/svc.puml",
      "@startuml\nclass UserService\nclass OrderService\nclass GhostService\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesMatched, 0);
    assert.deepEqual(issueNames(result), ["GhostService", "OrderService", "UserService"]);
  });

  it("skips ignored directories when scanning", async () => {
    await writeFiles(tmpRoot, {
      "node_modules/ghost/index.js": "export class Phantom {}\n",
      "dist/bundle.js": "export class Specter {}\n",
      "app.js": "export class Real {}\n",
    });
    const result = await checkConsistency(
      "models/svc.puml",
      "@startuml\nclass Real\nclass Phantom\nclass Specter\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesMatched, 1);
    assert.deepEqual(issueNames(result), ["Phantom", "Specter"]);
    assert.equal(result.filesScanned, 1);
  });

  it("does not match misleading substrings or superstrings", async () => {
    await writeFiles(tmpRoot, {
      "shop.js": "const Reorder = [];\nconst PreOrders = 1;\n",
    });
    const result = await checkConsistency(
      "models/shop.puml",
      "@startuml\nclass Order\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 1);
    assert.equal(result.entitiesMatched, 0);
    assert.deepEqual(issueNames(result), ["Order"]);
  });

  it("matches module names against file basenames", async () => {
    await writeFiles(tmpRoot, {
      "billing.py": "def charge():\n    pass\n",
    });
    const result = await checkConsistency(
      "models/billing.puml",
      "@startuml\nclass Billing\nclass charge\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 2);
    assert.equal(result.entitiesMatched, 2);
    assert.deepEqual(result.issues, []);
  });

  it("keeps the bundled example outcome: User matched, Order missing", async () => {
    await writeFiles(tmpRoot, {
      "user.ts": "export class User {\n  id: number;\n  name: string;\n  email: string;\n}\n",
    });
    const result = await checkConsistency(
      "models/user-class.puml",
      USER_CLASS_PUML,
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 2);
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.entitiesUnmatched, 1);
    assert.deepEqual(issueNames(result), ["Order"]);
    assert.equal(result.searchedDirectory, tmpRoot);
  });
});

describe("checkConsistency (experimental languages)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consistency-exp-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("matches C# declarations without crashing; flags missing, comment, string, and ignored names", async () => {
    await writeFiles(tmpRoot, {
      "shapes.cs":
        '// Phantom is legacy.\npublic class Widget {\n  public string Label = "Specter";\n}\n',
      "node_modules/ignored.cs": "public class Ignored {}\n",
    });
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\nclass Phantom\nclass Specter\nclass Ignored\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.entitiesUnmatched, 4);
    assert.deepEqual(issueNames(result), ["Ignored", "Missing", "Phantom", "Specter"]);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.searchedDirectory, tmpRoot);
  });

  it("matches Go declarations without crashing; flags missing, comment, string, and ignored names", async () => {
    await writeFiles(tmpRoot, {
      "shapes.go":
        'package shapes\n\n// Phantom is legacy.\ntype Widget struct {\n  Label string\n}\n\nfunc Render() string {\n  return "Specter"\n}\n',
      "dist/ignored.go": "package ghost\n\ntype Ignored struct{}\n",
    });
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\nclass Phantom\nclass Specter\nclass Ignored\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.entitiesUnmatched, 4);
    assert.deepEqual(issueNames(result), ["Ignored", "Missing", "Phantom", "Specter"]);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.searchedDirectory, tmpRoot);
  });

  it("matches Ruby declarations without crashing; flags missing, comment, string, and ignored names", async () => {
    await writeFiles(tmpRoot, {
      "shapes.rb": '# Phantom is legacy.\nclass Widget\n  def render\n    "Specter"\n  end\nend\n',
      "build/ignored.rb": "class Ignored\nend\n",
    });
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\nclass Phantom\nclass Specter\nclass Ignored\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.entitiesUnmatched, 4);
    assert.deepEqual(issueNames(result), ["Ignored", "Missing", "Phantom", "Specter"]);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.searchedDirectory, tmpRoot);
  });

  it("matches Kotlin declarations without crashing; flags missing, comment, string, and ignored names", async () => {
    await writeFiles(tmpRoot, {
      "shapes.kt": '// Phantom is legacy.\nclass Widget {\n  val label: String = "Specter"\n}\n',
      "out/ignored.kt": "class Ignored\n",
    });
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\nclass Phantom\nclass Specter\nclass Ignored\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.entitiesUnmatched, 4);
    assert.deepEqual(issueNames(result), ["Ignored", "Missing", "Phantom", "Specter"]);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.searchedDirectory, tmpRoot);
  });

  it("matches Rust declarations without crashing; flags missing, comment, string, and ignored names", async () => {
    await writeFiles(tmpRoot, {
      "shapes.rs":
        '// Phantom is legacy.\npub struct Widget {\n  pub label: String,\n}\n\nfn render() -> &\'static str {\n  "Specter"\n}\n',
      "target/ignored.rs": "pub struct Ignored;\n",
    });
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\nclass Phantom\nclass Specter\nclass Ignored\n@enduml\n",
      "plantuml",
      tmpRoot,
    );
    assert.equal(result.entitiesFound, 5);
    assert.equal(result.entitiesMatched, 1);
    assert.equal(result.entitiesUnmatched, 4);
    assert.deepEqual(issueNames(result), ["Ignored", "Missing", "Phantom", "Specter"]);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.searchedDirectory, tmpRoot);
  });
});

describe("checkConsistency scan limit observability", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consistency-scan-limit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reports no truncation below the scan cap and preserves existing fields", async () => {
    await writeFiles(tmpRoot, {
      "user.ts": "export class User {\n  id: number;\n}\n",
    });
    const result = await checkConsistency(
      "models/user-class.puml",
      "@startuml\nclass User\nclass Ghost\n@enduml\n",
      "plantuml",
      tmpRoot,
    );

    assert.equal(result.truncated, false);
    assert.equal(result.scanLimit, 5000);
    assert.equal(result.scanWarning, null);
    assert.equal(result.entitiesFound, 2);
    assert.equal(result.entitiesMatched, 1);
    assert.deepEqual(result.matchedEntities, ["User"]);
    assert.deepEqual(result.unmatchedEntities, ["Ghost"]);
  });

  it("reports truncation when the scan cap is reached with an incomplete-unmatched warning", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 5005; index += 1) {
      files[`bulk/file${index}.js`] = "export class Widget {}\n";
    }
    await writeFiles(tmpRoot, files);
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\n@enduml\n",
      "plantuml",
      tmpRoot,
    );

    assert.equal(result.truncated, true);
    assert.equal(result.scanLimit, 5000);
    assert.ok(result.filesScanned <= result.scanLimit);
    assert.ok(typeof result.scanWarning === "string" && result.scanWarning.length > 0);
    assert.match(result.scanWarning as string, /incomplete/i);
    assert.match(result.scanWarning as string, /unmatched/i);
    assert.deepEqual(result.matchedEntities, ["Widget"]);
    assert.deepEqual(result.unmatchedEntities, ["Missing"]);
  });
});

describe("checkConsistency evidence", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consistency-evidence-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reports extracted/matched/unmatched entities with reliable analyzer evidence", async () => {
    await writeFiles(tmpRoot, {
      "user.ts": "export class User {\n  id: number;\n}\n",
    });
    const result = await checkConsistency(
      "models/user-class.puml",
      "@startuml\nclass User\nclass Ghost\n@enduml\n",
      "plantuml",
      tmpRoot,
    );

    assert.deepEqual(sorted(result.entities), ["Ghost", "User"]);
    assert.deepEqual(result.matchedEntities, ["User"]);
    assert.deepEqual(result.unmatchedEntities, ["Ghost"]);

    assert.deepEqual(result.analyzers.reliable, [".ts"]);
    assert.deepEqual(result.analyzers.experimental, []);
    assert.deepEqual(result.analyzers.generic, []);

    assert.equal(result.confidence, "heuristic");
    assert.match(result.heuristicWarning, /heuristic/i);
    assert.ok(!/semantic|AST/i.test(result.heuristicWarning));

    assert.equal(result.evidence.length, 2);
    const userEvidence = result.evidence.find((entry) => entry.name === "User");
    assert.ok(userEvidence);
    assert.equal(userEvidence.matched, true);
    assert.deepEqual(userEvidence.analyzers, ["reliable"]);
    assert.deepEqual(userEvidence.matchedFiles, ["user.ts"]);
    assert.equal(userEvidence.matchedFileCount, 1);

    const ghostEvidence = result.evidence.find((entry) => entry.name === "Ghost");
    assert.ok(ghostEvidence);
    assert.equal(ghostEvidence.matched, false);
    assert.deepEqual(ghostEvidence.analyzers, []);
    assert.deepEqual(ghostEvidence.matchedFiles, []);
    assert.equal(ghostEvidence.matchedFileCount, 0);
  });

  it("marks experimental-language matches with the experimental tier and heuristic confidence", async () => {
    await writeFiles(tmpRoot, {
      "shapes.go": "package shapes\n\ntype Widget struct {\n  Label string\n}\n",
    });
    const result = await checkConsistency(
      "models/shapes.puml",
      "@startuml\nclass Widget\nclass Missing\n@enduml\n",
      "plantuml",
      tmpRoot,
    );

    assert.equal(result.entitiesFound, 2);
    assert.equal(result.entitiesMatched, 1);
    assert.deepEqual(result.matchedEntities, ["Widget"]);
    assert.deepEqual(result.unmatchedEntities, ["Missing"]);

    assert.deepEqual(result.analyzers.reliable, []);
    assert.deepEqual(result.analyzers.experimental, [".go"]);

    assert.equal(result.confidence, "heuristic");

    const widgetEvidence = result.evidence.find((entry) => entry.name === "Widget");
    assert.ok(widgetEvidence);
    assert.equal(widgetEvidence.matched, true);
    assert.deepEqual(widgetEvidence.analyzers, ["experimental"]);
    assert.deepEqual(widgetEvidence.matchedFiles, ["shapes.go"]);
  });

  it("bounds matched files and keeps them relative POSIX without source leakage", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      files[`nested/mod${index}.js`] = `export const Shared = ${index};\n`;
    }
    await writeFiles(tmpRoot, files);
    const result = await checkConsistency(
      "models/shared.puml",
      "@startuml\nclass Shared\n@enduml\n",
      "plantuml",
      tmpRoot,
    );

    assert.equal(result.entitiesMatched, 1);
    const sharedEvidence = result.evidence.find((entry) => entry.name === "Shared");
    assert.ok(sharedEvidence);
    assert.equal(sharedEvidence.matchedFileCount, 12);
    assert.ok(sharedEvidence.matchedFiles.length <= 10);
    assert.ok(sharedEvidence.matchedFiles.length > 0);
    for (const matchedFile of sharedEvidence.matchedFiles) {
      assert.ok(!matchedFile.includes("\\"), `expected POSIX path, got '${matchedFile}'`);
      assert.ok(!path.isAbsolute(matchedFile), `expected relative path, got '${matchedFile}'`);
      assert.ok(!matchedFile.includes(tmpRoot), "matched files must not leak absolute paths");
    }
  });
});

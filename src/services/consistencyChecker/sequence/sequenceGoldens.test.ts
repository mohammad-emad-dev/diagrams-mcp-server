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

function issueTexts(result: { issues: Array<{ issue: string }> }): string[] {
  return sorted(result.issues.map((issue) => issue.issue));
}

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

describe("sequence goldens (baseline pin, Seq P2)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-goldens-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("pins the order-flow outcome: participants matched, labels ignored", async () => {
    await writeFiles(tmpRoot, {
      "customer.js": "export class Customer {}\n",
      "orderService.js": "export class OrderService {}\n",
      "paymentService.js": "export class PaymentService {}\n",
      "inventory.js": "export class Inventory {}\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/order-flow.mmd",
        source: ORDER_FLOW_MMD,
        type: "mermaid",
      },
      tmpRoot,
    );
    assert.deepEqual(sorted(result.entities), [
      "Customer",
      "Inventory",
      "OrderService",
      "PaymentService",
    ]);
    assert.equal(result.entitiesFound, 4);
    assert.equal(result.entitiesMatched, 4);
    assert.deepEqual(result.issues, []);
  });

  it("locks the Java gap: method-only operations match via fallback only", async () => {
    await writeFiles(tmpRoot, {
      "shop/Shop.java":
        "package com.example.shop;\n\npublic class Shop {\n  public String charge(String card) {\n    return card;\n  }\n}\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/shop.puml",
        source: "@startuml\nparticipant Shop\nShop -> Shop : charge(card)\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    // Java has no method-declaration patterns: `charge` matches through the
    // whole-word fallback by design, in Phase 3 as well as today.
    assert.deepEqual(sorted(result.entities), ["Shop", "charge"]);
    assert.equal(result.entitiesMatched, 2);
    assert.deepEqual(result.issues, []);
  });

  it.skip("missing participant reports a participant issue", async () => {
    await writeFiles(tmpRoot, {
      "shop/Shop.java": "package com.example.shop;\n\npublic class Shop {}\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/shop.puml",
        source: "@startuml\nparticipant Shop\nparticipant Courier\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    assert.deepEqual(issueNames(result), ["Courier"]);
    assert.deepEqual(issueTexts(result), [
      "'Courier' appears as a participant in the diagram but no matching identifier " +
        "was found in the scanned codebase. It may be renamed, removed, or not yet implemented.",
    ]);
  });

  it.skip("missing operation reports an operation issue", async () => {
    await writeFiles(tmpRoot, {
      "shop.js": "export class Shop {}\n",
    });
    const result = await checkConsistency(
      {
        relativePath: "models/shop.puml",
        source: "@startuml\nparticipant Shop\nShop -> Shop : charge(card)\n@enduml\n",
        type: "plantuml",
      },
      tmpRoot,
    );
    assert.deepEqual(issueNames(result), ["charge"]);
    assert.deepEqual(issueTexts(result), [
      "'charge' appears as an operation in the diagram but no matching function " +
        "was found in the scanned codebase. It may be renamed, removed, or not yet implemented.",
    ]);
  });
});

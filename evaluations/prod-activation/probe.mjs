#!/usr/bin/env node
// PROD activation probe for the TS AST layer (Option B gate, binding).
//
// Proves the AST path activates for real users, not just dev checkouts:
//   1. Availability gate: isTsAstAvailable() in the target install.
//   2. Behavioral gate: an incidental-only name must NOT match once the
//      AST-strict path is live (it DOES match on the heuristic fallback).
//
// Usage:
//   node evaluations/prod-activation/probe.mjs [installDir]
// installDir defaults to the repo root (dev-mode). For the binding gate,
// point it at a clean `npm install <tgz>` directory (see README tarball
// flow). Exit 0 = AST ACTIVE, exit 1 = DORMANT (pay Option A).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installDir = path.resolve(process.argv[2] ?? ".");
const tsParseUrl = pathToFileURL(
  path.join(installDir, "dist/services/consistencyChecker/ts/tsParse.js"),
).href;
const checkerUrl = pathToFileURL(
  path.join(installDir, "dist/services/consistencyChecker/index.js"),
).href;

let tsParse;
try {
  tsParse = await import(tsParseUrl);
} catch (error) {
  console.log(`AST probe: tsParse module missing (${error.message}) -> DORMANT`);
  process.exit(1);
}

const available = await tsParse.isTsAstAvailable();
console.log(`AST probe: isTsAstAvailable=${available} [${installDir}]`);
if (!available) {
  console.log("AST probe verdict: DORMANT (compiler not installed) -> pay Option A");
  process.exit(1);
}

const { checkConsistency } = await import(checkerUrl);
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ast-probe-"));
try {
  await fs.writeFile(
    path.join(tmpRoot, "orders.ts"),
    "export interface Order {\n  User: string;\n}\nexport const orders: Order[] = [];\n",
    "utf-8",
  );
  const result = await checkConsistency(
    {
      relativePath: "models/probe.puml",
      source: "@startuml\nclass User\n@enduml\n",
      type: "plantuml",
    },
    tmpRoot,
  );
  if (result.entitiesMatched === 0) {
    console.log("AST probe verdict: ACTIVE (incidental-only name correctly unmatched)");
    process.exit(0);
  }
  console.log("AST probe verdict: DORMANT (heuristic fallback still matching) -> wire Phase 3");
  process.exit(1);
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

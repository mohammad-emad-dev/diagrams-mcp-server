import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagramStore } from "./diagramStore.js";

it("concurrent HTML saves preserve the complete winning payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-html-race-"));
  try {
    const store = new DiagramStore(root);
    const payloads = ["<html>" + "أ".repeat(800) + "</html>", "<html>second</html>"];
    const attempts = await Promise.allSettled(
      payloads.map((html) => store.writeHtmlExport("reports/race.HTML", html)),
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    const winner = attempts.findIndex((attempt) => attempt.status === "fulfilled");
    assert.equal(await fs.readFile(path.join(root, "reports/race.HTML"), "utf8"), payloads[winner]);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("diagrams-html-race-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

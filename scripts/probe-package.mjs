import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_TOOLS = [
  "diagrams_check_consistency",
  "diagrams_create",
  "diagrams_delete",
  "diagrams_diff",
  "diagrams_export",
  "diagrams_generate",
  "diagrams_generate_sequence",
  "diagrams_get",
  "diagrams_list",
  "diagrams_list_templates",
  "diagrams_render",
  "diagrams_save_export",
  "diagrams_scaffold",
  "diagrams_template",
  "diagrams_update",
];
const DIAGRAM_PATH = "models/release.puml";
const MERMAID_PATH = "models/release.mmd";
const SOURCE =
  "@startuml\n!pragma layout smetana\nclass User {\nname: string\n}\nclass Order\nUser --> Order : orders\n@enduml\n";
const MERMAID = "classDiagram\nclass User\nclass Order\nUser --> Order : orders\n";

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function installedPackage(installRoot) {
  const root = path.resolve(installRoot, "node_modules", "diagrams-mcp-server");
  const manifest = await readJson(path.join(root, "package.json"));
  const expected = await readJson(new URL("../package.json", import.meta.url));
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  assert.deepEqual(manifest.dependencies, expected.dependencies);
  assert.deepEqual(manifest.bin, expected.bin);
  assert.doesNotMatch(await fs.readFile(path.join(root, "README.md"), "utf8"), /[.,]/);
  await fs.access(path.join(root, "LICENSE"));
  const runtimeFiles = await fs.readdir(path.join(root, "dist"), { recursive: true });
  assert.ok(runtimeFiles.every((filename) => !filename.endsWith(".test.js")));
  const parser = await import(
    pathToFileURL(path.join(root, "dist/services/consistencyChecker/ts/tsParse.js"))
  );
  assert.equal(
    await parser.isTsAstAvailable(),
    false,
    "probe requires a production install without TypeScript",
  );
  return { root, manifest };
}

async function prepareFixtures(root) {
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src/user.ts"),
    "export class User {}\nexport function checkout() { charge(); }\n",
  );
  await fs.writeFile(
    path.join(root, "src/order.ts"),
    "export class Order {}\nexport function charge() { return 1; }\n",
  );
  await fs.mkdir(path.join(root, ".diagrams-templates"));
  await fs.writeFile(
    path.join(root, ".diagrams-templates/release.json"),
    JSON.stringify({
      puml: { source: "@startuml\n{{entities}}\n@enduml\n", entity: "class {{name}}" },
    }),
  );
}

async function packageClient(pkg, projectRoot) {
  const resolve = createRequire(path.join(pkg.root, "package.json"));
  const { Client } = await import(
    pathToFileURL(resolve.resolve("@modelcontextprotocol/sdk/client/index.js"))
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(resolve.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
  );
  const client = new Client({ name: "diagrams-package-probe", version: pkg.manifest.version });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pkg.root, pkg.manifest.bin["diagrams-mcp-server"])],
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      DIAGRAMS_DIR: "diagrams",
      DISABLE_REMOTE_PLANTUML: "true",
    },
  });
  return { client, transport };
}

async function call(context, name, args) {
  const response = await context.client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
  context.called.add(name);
  return response;
}

async function verifyDiscovery(context) {
  const { tools } = await context.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  const listed = await call(context, "diagrams_list", {});
  assert.equal(listed.structuredContent.total, 0);
  const templates = await call(context, "diagrams_list_templates", {});
  assert.equal(templates.structuredContent.custom_count, 1);
  const unknown = await context.client.callTool({
    name: "diagrams_list",
    arguments: { unknown: true },
  });
  assert.equal(unknown.isError, true);
}

async function verifyDrafts(context) {
  for (const template of ["class", "custom"]) {
    const args = { template, entities: ["User", "Order"], format: "puml" };
    if (template === "custom") args.custom_template = "release";
    const draft = await call(context, "diagrams_template", args);
    assert.match(draft.structuredContent.source, /class User/);
  }
  const generated = await call(context, "diagrams_generate", { scope: "src" });
  assert.ok(generated.structuredContent.entities.includes("User"));
  assert.equal(generated.structuredContent.written, false);
  const sequence = await call(context, "diagrams_generate_sequence", { scope: "src" });
  assert.ok(sequence.structuredContent.participants.length > 0);
  assert.equal(sequence.structuredContent.written, false);
}

async function verifyStoredDiagrams(context) {
  await call(context, "diagrams_create", { relative_path: DIAGRAM_PATH, content: SOURCE });
  await call(context, "diagrams_create", { relative_path: MERMAID_PATH, content: MERMAID });
  const source = await call(context, "diagrams_get", { relative_path: DIAGRAM_PATH });
  assert.equal(source.structuredContent.content, SOURCE);
  const consistency = await call(context, "diagrams_check_consistency", {
    relative_path: DIAGRAM_PATH,
  });
  assert.equal(consistency.structuredContent.entities_matched, 2);
  const difference = await call(context, "diagrams_diff", {
    a_relative_path: DIAGRAM_PATH,
    b_content: MERMAID + "class Invoice\n",
  });
  assert.ok(difference.structuredContent.added.some((entity) => entity.name === "Invoice"));
  const scaffold = await call(context, "diagrams_scaffold", {
    relative_path: DIAGRAM_PATH,
    include_relations: true,
  });
  assert.equal(scaffold.structuredContent.relations_included, 1);
  assert.match(scaffold.structuredContent.source, /orders!: Order;/);
}

async function verifyImages(context) {
  for (const relative_path of [DIAGRAM_PATH, MERMAID_PATH]) {
    for (const format of ["svg", "png"]) {
      const rendered = await call(context, "diagrams_render", { relative_path, format });
      const image = rendered.content.find((block) => block.type === "image");
      assert.ok(image, "real renderer must return an image");
      const bytes = Buffer.from(image.data, "base64");
      if (format === "svg") assert.match(bytes.toString("utf8"), /<svg\b/);
      else assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  }
}

async function verifyExports(context) {
  for (const relative_path of [DIAGRAM_PATH, MERMAID_PATH]) {
    const exported = await call(context, "diagrams_export", {
      relative_path,
      include_source: false,
    });
    assert.equal(exported.structuredContent.source_included, false);
    assert.match(exported.content[0].text, /data:image\/svg\+xml;base64/);
    assert.notEqual(exported.structuredContent.rendered_with, "remote-plantuml");
  }
  const output_path = "exports/release.html";
  await call(context, "diagrams_save_export", { relative_path: DIAGRAM_PATH, output_path });
  const output = path.join(context.root, "diagrams", output_path);
  const html = await fs.readFile(output, "utf8");
  assert.match(html, /data:image\/svg\+xml;base64/);
  const duplicate = await context.client.callTool({
    name: "diagrams_save_export",
    arguments: { relative_path: DIAGRAM_PATH, output_path },
  });
  assert.equal(duplicate.isError, true);
  assert.equal(await fs.readFile(output, "utf8"), html);
}

async function verifyMutations(context) {
  const updated = SOURCE.replace("@startuml\n", "@startuml\ntitle Release verification\n");
  await call(context, "diagrams_update", { relative_path: DIAGRAM_PATH, content: updated });
  const source = await call(context, "diagrams_get", { relative_path: DIAGRAM_PATH });
  assert.equal(source.structuredContent.content, updated);
  for (const relative_path of [DIAGRAM_PATH, MERMAID_PATH])
    await call(context, "diagrams_delete", { relative_path });
  const listed = await call(context, "diagrams_list", {});
  assert.equal(listed.structuredContent.total, 0, "saved HTML must stay outside diagram discovery");
}

async function closeProbe(context) {
  try {
    await context.client?.close();
  } finally {
    const resolved = path.resolve(context.root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("diagrams-package-probe-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function main() {
  assert.equal(process.argv.length, 3, "Usage: npm run probe:package -- <clean-install-root>");
  const pkg = await installedPackage(process.argv[2]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagrams-package-probe-"));
  const context = { root, called: new Set() };
  try {
    Object.assign(context, await packageClient(pkg, root));
    await prepareFixtures(root);
    await context.client.connect(context.transport);
    assert.equal(context.client.getServerVersion().version, pkg.manifest.version);
    for (const verify of [
      verifyDiscovery,
      verifyDrafts,
      verifyStoredDiagrams,
      verifyImages,
      verifyExports,
      verifyMutations,
    ])
      await verify(context);
    assert.deepEqual([...context.called].sort(), EXPECTED_TOOLS);
    console.log(
      JSON.stringify({
        version: pkg.manifest.version,
        node: process.version,
        tools: context.called.size,
        images: 4,
        compiler: "absent",
        remoteRendering: "disabled",
        result: "passed",
      }),
    );
  } finally {
    await closeProbe(context);
  }
}

await main();

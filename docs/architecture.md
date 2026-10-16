# Architecture

Describes the current checkout, including the unreleased `diagrams_save_export` and `diagrams_scaffold` tools after 0.8.0. CLI dispatch lives in
`src/index.ts`; MCP construction lives in `src/server.ts`
(`createDiagramServer`).

The [cleanup handoff](cleanup-handoff.md) records the completed structural
cleanup, local verification results, and remaining release checks.

## Request path

```
MCP client (stdio)
  -> src/index.ts main()            # CLI dispatch: setup | --help | serve
  -> src/context.ts                 # one ServerContext for the process
  -> src/server.ts                  # createDiagramServer(ctx): builds McpServer, registers 15 tools
  -> src/tools/diagrams*.ts         # 15 tool adapters, one file per tool
  -> src/services/*                 # filesystem, analysis, rendering, emitters
  -> src/tools/toolError.ts         # expected vs. unexpected error mapping
```

`main()` serves by: `createServerContext()`, `diagramStore.ensureRootExists()`,
`createDiagramServer(ctx)`, then `server.connect(new StdioServerTransport())`.
`createDiagramServer` builds `new McpServer({ name: "diagrams-mcp-server",
... })`, runs the fifteen `registerDiagrams*` calls, and returns the server.
`setup` dispatches to `runSetup` in `src/setup/index.ts` (clients, prompts,
terminal helpers in the same directory); `--help` / `-h` prints help and exits.

Setup flag parsing lives in `src/setup/arguments.ts` (`parseSetupArgs` and
`SetupOptions`). `src/setup/configuration.ts` resolves client configuration
paths, builds server entries, merges them into existing JSON, and writes the
result. `src/setup/projectRoot.ts` owns the project-root prompt loop and the
scope rule for including `PROJECT_ROOT` in client configuration.
`src/setup/clients.ts` keeps the client catalog, PATH lookup, and CLI command
construction, and re-exports the moved symbols for existing callers.
The setup orchestrator imports argument, configuration, and project-root
functions from their owning modules; the client re-exports remain compatibility
entry points.
`src/setup/terminal.ts` builds terminal strings; each box computes its line
and title widths once per call. Color selection reads `NO_COLOR` and stdout's
TTY state.
Interactive prompt drivers reuse the initial rendered frame for its line count
and first write, while subsequent key events still render the updated state.

## Shared foundation

- `src/context.ts` — `ServerContext`: `diagramStore`, `codeRootDir`, optional
  `rendererDeps` test seam (unset in production, so the real CLIs and fetch
  are used).
- `src/types.ts` — `DiagramType`, `DiagramFile`, `ConsistencyCheckResult` and
  its evidence types, `AnalyzerTier` (`reliable` / `experimental` / `generic`).
- `src/constants.ts` — `toPosixPath`, `EXTENSION_TO_TYPE` (`.puml`, `.plantuml`,
  `.mmd`, `.mermaid`), `TYPE_TO_EXTENSION`, `DEFAULT_DIAGRAMS_DIR`, and the
  `MAX_*` caps for pagination, rendering, generation, templates (incl. `MAX_CUSTOM_TEMPLATE_BYTES` 65,536, `MAX_CUSTOM_TEMPLATE_NAME_CHARS` 64, `MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS` 1,000,000, introduced in 0.8.0), export, and scaffold (`MAX_SCAFFOLD_SOURCE_BYTES` 1,000,000, unreleased after 0.8.0).
- `src/tools/toolError.ts` — `handleToolError` / `handleRenderError`: expected
  domain errors (`DiagramNotFoundError`, `PathTraversalError`,
  `DiagramValidationError`, `DiagramExistsError`,
  `UnsupportedDiagramExtensionError`, `ScopeEscapeError`, `RenderError`,
  `CustomTemplateError`, `CallOrderLimitError`, `ScaffoldSourceTooLargeError`)
  pass through with their message; everything else is logged to stderr (name only)
  and returned as a generic internal-error result.

## Tools (`src/tools/`)

One adapter per tool, each exporting `registerDiagrams*(server, ctx)` — except
`diagramsTemplate.ts`, whose `registerDiagramsTemplate(server, ctx?)` takes an
optional context: built-in skeletons are pure (no store, no project root, no
state), while `template="custom"` reads one file under `ctx.codeRootDir`.
`createDiagramServer` passes `ctx` through. Both `diagramsExport.ts` and `diagramsSaveExport.ts` read the optional `ctx.rendererDeps` seam so the
render step is testable without a CLI or the network.

| Tool                         | Adapter                       |
| ---------------------------- | ----------------------------- |
| `diagrams_list`              | `diagramsList.ts`             |
| `diagrams_get`               | `diagramsGet.ts`              |
| `diagrams_create`            | `diagramsCreate.ts`           |
| `diagrams_update`            | `diagramsUpdate.ts`           |
| `diagrams_delete`            | `diagramsDelete.ts`           |
| `diagrams_render`            | `diagramsRender.ts`           |
| `diagrams_export`            | `diagramsExport.ts`           |
| `diagrams_save_export`       | `diagramsSaveExport.ts`       |
| `diagrams_check_consistency` | `diagramsCheckConsistency.ts` |
| `diagrams_generate`          | `diagramsGenerate.ts`         |
| `diagrams_generate_sequence` | `diagramsGenerateSequence.ts` |
| `diagrams_diff`              | `diagramsDiff.ts`             |
| `diagrams_template`          | `diagramsTemplate.ts`         |
| `diagrams_list_templates`    | `diagramsListTemplates.ts`    |
| `diagrams_scaffold`          | `diagramsScaffold.ts`         |

Adapters validate input with strict Zod schemas and map failures through
`toolError.ts`. Successful responses pair `content` with `structuredContent`:
source tools return their source as text, report tools return a summary, and
`diagrams_render` returns image content. There is no `toolOutput.ts` module; the
`toolOutput.test.ts` file next to the adapters tests the content/structured
contract through captured registrations.

Introduced in 0.8.0: register adapters with `inputSchema: InputSchema`, passing the complete Zod object. Passing `InputSchema.shape` makes the SDK reconstruct a plain object and loses root strictness. Full schemas preserve unknown-key rejection over MCP alongside existing defaults and field refinements; real stdio tests cover all 15 tools in the current checkout (thirteen in 0.8.0 plus `diagrams_save_export` and `diagrams_scaffold`, unreleased after 0.8.0) and verify rejected mutation requests leave files unchanged.

`diagramsDiff.ts` delegates its input schema, validation, and side loading to
`diffInput.ts`, and its text summaries to `diffSummary.ts`. Validation runs
before either side is read; stored sides still use the store's path guards.

`diagramsGet.ts` validates the requested range before reading the stored source,
then constructs the character-window response in a private formatter. Offsets
and lengths follow JavaScript string slicing (UTF-16 code units).

The class and sequence generation adapters keep scope resolution, collection,
emission, and validation in their handlers, then assemble responses in private
formatters. `diagramsExport.ts` reads before rendering and passes the rendered
SVG to a private formatter that builds the HTML and enforces the UTF-8 byte cap.
Formatting stays inside each adapter's existing error boundary.
`diagramsCheckConsistency.ts` also keeps report formatting private to the
adapter, including evidence field names, summary branches, and scan warnings.
Unreleased after 0.8.0, `diagramsScaffold.ts` reads one stored diagram, builds
TypeScript class shells through `services/scaffold/scaffold.ts`, and reports
candidate counts with a heuristic warning; the text block is the emitted
source itself. `include_members` defaults to false. Opt-in results also report
`include_members`, `members_included`, `members_capped`, and `member_limit`;
default results retain their existing shape. `include_types` implies member
generation and additionally reports `include_types`, `typed_fields`, and
`unresolved_fields`. It preserves only explicit supported field labels;
method signatures and runtime behavior remain unrecovered.

## Services (`src/services/`)

- `diagramStore.ts` — filesystem CRUD rooted at one directory; paths escaping
  the root are rejected (`PathTraversalError`), plus typed errors for missing
  diagrams, existing diagrams, and unsupported extensions.
  `write` validates the target before dispatching to private exclusive-create
  or atomic-replacement operations; these retain the original open flags,
  rename behavior, error mapping, and handle cleanup.
- `store/diagramMetadata.ts` — `diagramTypeFromPath` maps file extensions to
  diagram types; `readDiagramTitlePrefix` reads the bounded prefix through the
  store's open file handle; `extractDiagramTitle` reports an exact, partial,
  or absent title. The store owns path validation and handle cleanup.
- `diagramValidator.ts` — creation/update syntax gate: PlantUML needs
  `@startuml`/`@enduml` boundaries, Mermaid needs a known leading keyword.
  Mermaid header parsing skips leading blanks, comments, and optional
  frontmatter, then stops at the first meaningful line. Anything deeper is
  left to the renderer.
- `renderer.ts` — diagram source to SVG/PNG via local CLIs (`mmdc` for
  Mermaid; local `plantuml` preferred). The remote PlantUML fallback is
  opt-in (`ALLOW_REMOTE_PLANTUML=true`) and `DISABLE_REMOTE_PLANTUML=true`
  always wins. `RendererDeps` (`commandExists`, `runCommand`, `fetchRemote`)
  is the process/network seam.
- `renderer/types.ts` — rendering formats, provenance, results, and process/
  network dependency contracts. Backends import these types directly; the
  renderer entry re-exports them for existing callers. The module has no runtime
  declarations.
- `renderer/command.ts` — executable detection, Windows command-shim
  arguments, bounded process output, and renderer timeouts.
  `renderer/error.ts` defines the shared `RenderError` class. `renderer.ts`
  re-exports `RenderError`, `runCommand`, `resolveSpawnTarget`, and the
  `SpawnTarget` type so existing callers keep their imports.
- `renderer/local.ts` — local Mermaid and PlantUML execution, input/output
  files, and temporary-directory cleanup. The renderer entry retains backend
  selection, remote-fallback policy, and provenance reporting.
- `renderer/plantumlRemote.ts` — PlantUML URL encoding, remote requests,
  timeouts, and response-size checks. The renderer entry owns the fallback
  decision and re-exports `encodePlantUmlForUrl` and `defaultFetchRemote` for
  existing callers.
- `scopeResolve.ts` — `resolveScope(projectRoot, scope)` bounds the read-only
  tools to `PROJECT_ROOT`; anything resolving outside is refused
  (`ScopeEscapeError`) before a file is read.
- `nameNormalize.ts` — `normalizeForMatch`: lowercase, separator-free
  comparison key shared by the consistency checker and `diagrams_diff`, so
  matching and rename pairing cannot drift apart.
- `consistencyChecker/` — diagram-vs-code drift detection. `index.ts`
  orchestrates scan, match, report; `fileAnalysis.ts` reads and analyzes code
  files; `entityMatching.ts` matches structural and operation names and
  collects issues and evidence. `entities.ts` composes dialect-specific
  declaration, participant, and message-call collectors in a fixed order;
  `codeAnalysis.ts` holds per-language declaration patterns and tiers;
  `scanning.ts` walks the filesystem with scan limits and ignored directories;
  `sequence/` holds the call-graph edges, participant mapping, and message
  ordering; `ts/` holds the optional TypeScript AST path, reached by dynamic
  import only (`tsParse.ts`), so installs without `typescript` use the
  heuristic fallback.
  Consistency checks derive names and construct kinds from one tagged entity
  extraction. Message ordering builds one first-position map for direct calls
  and reuses it for membership and order comparisons; callbacks remain separate.
  Directory reads recover only from the existing missing/unreadable-directory
  errors; traversal keeps its depth-first entry order and original cap checks.
  `entityMatching.ts` keeps structural and operation rules in separate private
  queries sharing the text fallback. AST-backed structural names require a
  declaration or module match; operations retain heuristic text matching.
  `codeAnalysis.ts` parses each comma-list item once and retains alias-before-
  original declaration order. Call extraction resolves each line's definition
  once and passes that name to its call collector.
  Callback-wrapper detection runs once per line; each call still checks its own
  preceding text for an arrow callback.
  `tsHeritage.ts` separates AST traversal from class/interface clause
  collection. Invalid root shapes return no edges; unexpected visitor
  failures propagate through `analyzeTsFile`.
  Introduced in 0.8.0: `ts/tsCalls.ts` collects ordered AST call edges plus callable operations via optional `includeCalls` in `tsIndex.ts` (methods/accessors/property-held functions; `f()`, `obj.m()`, `obj["m"]()`; enclosing-caller reset; multiline callback deferral). Missing compiler, non-TS extensions, or parse failure keep the heuristic fallback. Mapping stays file-level first-owner matching with no semantic type resolution.
  Participant mapping uses case-insensitive operation names and the first
  declaring participant in file order. Its lookup is rebuilt per call,
  so changes to the declaration set are visible to the next call.
- `diff/diffDiagram.ts` — pure added/removed/renamed comparison of two
  sources; rename pairing uses `normalizeForMatch` and carries
  `confidence: "heuristic"`. A cursor per normalized name consumes added
  candidates in order, avoiding repeated scans of already-used candidates.
- `export/htmlBundle.ts` — pure builder: an HTML wrapper around an SVG-as-image plus
  optional source. Introduced in 0.8.0: the stripped SVG source is base64-encoded into `<img src="data:image/svg+xml;base64,...">`, never parsed as live markup; scripts/external resources are disabled by SVG-image processing under `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. Isolation is the boundary — no sanitization or removal of encoded markup is claimed. It escapes path, source, and provenance in one pass, preserving
  literal entity spellings. The wrapper adds inline CSS and no scripts or
  fetched styles; `svgChars` is the decoded source length after XML-declaration/DOCTYPE strip, not the base64 length. No filesystem operations.
- `generate/` — `collectEntities.ts` (scope scan to ordered entities plus
  evidenced relations), `emitters.ts` (class-diagram emitters),
  `sequence.ts` (candidate-message construction, participant/message caps,
  and dialect naming),
  `sequenceEmitters.ts` (sequence-diagram emitters), `scopeFiles.ts` (scope
  listing shared by both generators).
  `types.ts` owns shared options, results, relations, messages, and compiler
  dependency contracts. Collectors retain their original type exports; emitters
  and tool adapters import the contracts directly. The shared module contains
  type declarations only.
  The class emitters share their declaration and relation body; each dialect
  retains its own header and footer.
  PlantUML sequence emission quotes each distinct participant or message
  endpoint once per call, with no lookup state shared between emissions.
  Sequence generation builds its operation lookup after merging files that
  share a participant name. The first participant declaring a lowercase
  operation name wins, including when a later participant has an exact-case
  match. Candidate caller and callee lookups reuse that index. Introduced in 0.8.0: `sequence.ts` prefers AST edges/operations (`includeCalls: true`) when the compiler resolves, else the heuristic `extractCallEdges` fallback.
  Introduced in 0.8.0: `SequenceOptions.includeCallParentheses` (wire: `include_call_parentheses`, default false) reaches only the sequence emitter. When enabled, labels append `()`; structured messages retain their operation names, and collection/capping behavior is unchanged.
- `templates/skeletons.ts` — six pure built-in emitters (class, sequence, C4-context
  × PlantUML, Mermaid). Fixed tables in source; identical inputs yield
  byte-identical output. Introduced in 0.8.0: `templates/customTemplates.ts` is the separate read-only loader for `<PROJECT_ROOT>/.diagrams-templates/<id>.json` (strict `puml`/`mermaid` objects, `{{title}}`/`{{entities}}` + `{{name}}` single-pass expansion, 65,536-byte / 1,000,000-char bounds, regular-files-only).
- `scaffold/scaffold.ts` — unreleased after 0.8.0, pure code-from-diagram draft: `buildScaffold` checks the 1,000,000 UTF-8 byte cap before calling the shared `extractEntities` unchanged, partitions candidates into emittable and skipped names (identifier grammar, 60 chars, conservative reserved set, order-preserving dedupe), caps valid names, and emits `export class Name {}` blocks. `ScaffoldSourceTooLargeError` is an expected error in `toolError.ts`. No filesystem, rendering, network, or execution.
- `scaffold/members.ts` — unreleased after 0.8.0, opt-in subset parser for plain multiline class blocks in PlantUML and Mermaid class diagrams. Only emitted class names receive descriptors, at most 30 unique member names per class. Member-only mode emits `unknown` fields; methods discard signature details and throw until implemented. Unsupported syntax is skipped. Defaults still emit empty shells; the unknown-member mode ignores type labels. Neither mode recovers relations or behavior.
- `buildScaffoldWithTypes` adds explicit field-label preservation over the same bounded member extraction, resolved through `scaffold/fieldTypes.ts`. Labels are retained only up to 62 characters; accepted types are `string`, `number`, `boolean`, `bigint`, or selected emitted class names, optionally with one array suffix. Accepted fields receive definite-assignment markers; unresolved labels stay `unknown`. No initializer values, imports, relationship inference, or method-type recovery are generated.

Introduced in 0.8.0, `diff/callOrder.ts` compares recognized call-name arrays in order, keeping repetitions. `diffDiagrams` requests it only through `compareCallOrder`; the wire option is `compare_call_order`. `entities.ts` supplies the bounded ordered extractor using the existing call grammar. Both sides are capped by `MAX_DIFF_ORDER_CALLS` (10,000); `CallOrderLimitError` rejects over-limit comparisons and is an expected error in `toolError.ts`. The default diff result shape remains unchanged. Enabled responses include `call_order`, contribute to `is_same`, and append a call-order summary; no arguments, endpoints, labels, control flow, or runtime behavior are compared.

Introduced in 0.8.0, message-call extraction shares one lazy line scanner between deduplicated and ordered collectors. Whole-line apostrophe/`%%` comments and PlantUML blocks starting with `/'` at the first non-whitespace character are skipped; scanning resumes after `'/`. Unclosed blocks consume the remaining source. Regex and block state belong to each invocation, so a bounded early return cannot affect later calls. Inline blocks after content, nested blocks, note bodies, declaration comments, and participant comments remain outside this scanner's scope.

Introduced in 0.8.0, template discovery uses `templates/templateCatalog.ts` through `diagramsListTemplates.ts`. `listCustomTemplates` examines at most `MAX_TEMPLATE_SCAN_ENTRIES` (1,000) directory entries plus one lookahead, skips subfolders and symlink files, and returns candidate identifiers without opening their JSON. Discovery and instantiation share `resolveCustomTemplateDirectory` in `customTemplates.ts`. A missing directory gives built-ins only; a redirected directory is rejected. The tool reports partial scans explicitly and writes nothing.

## Tests

Tests are colocated with the source they cover (`*.test.ts`) and compile to
`dist/`. `npm run build` runs `scripts/build.mjs`, which cleans the project's
`dist/` before compiling with TypeScript. `npm test` runs `scripts/test.mjs`,
which discovers compiled `*.test.js` recursively and passes the sorted file
list to `node --test`. An empty suite or a failing test returns a nonzero
exit code. New tests need no package-script edits. Build before testing.
Lint and formatting checks cover both `src/` and `scripts/`.

`src/integration/mcpServer.test.ts` drives the compiled `dist/index.js`
over real stdio with the SDK client and asserts the fifteen names in
`EXPECTED_TOOLS` (thirteen in 0.8.0 plus `diagrams_save_export` and `diagrams_scaffold`, unreleased after 0.8.0); rendering stays stubbed or discovery-only there.

Renderer tests give `TEMP`, `TMP`, and `TMPDIR` a file-owned temporary
directory so parallel test workers cannot interfere with cleanup assertions.

## Examples and evaluations

- `examples/` is the reference fixture project: `examples/src/user.ts` plus
  `examples/diagrams/models/user-class.puml` and `order-flow.mmd`. Point the
  server at it (`PROJECT_ROOT=./examples DIAGRAMS_DIR=diagrams`) to exercise
  the list/read/check loop locally.
- `evaluations/eval.xml` holds read-only Q&A against that fixture (list, get,
  check_consistency).
- `evaluations/prod-activation/probe.mjs` (`npm run probe:prod`) checks the
  TypeScript AST layer in a target install: availability gate plus a
  behavioral gate distinguishing the AST path from the heuristic fallback.

## Adding or changing a tool

1. Put the MCP adapter in `src/tools/diagramsX.ts` as
   `registerDiagramsX(server, ctx)` (use optional `ctx?` only when built-ins are pure and one mode needs the project root, as `diagrams_template` does for custom templates) and register
   it from `createDiagramServer` in `src/server.ts` (which passes `ctx`).
2. Put the logic in `src/services/`; parser and filesystem code does not
   belong in the registration file.
3. Validate input with a strict Zod schema (`.strict()`); keep writes inside
   the diagrams root via the store's guards.
4. Return `content` and `structuredContent` consistently; failures are
   `Error: ...` text with `isError: true` via `toolError.ts`. Never surface a
   stack trace.
5. Document the tool description as the client contract: when to use it, args,
   return shape, and every error string.
6. Add colocated unit tests (`*.test.ts`) and extend `EXPECTED_TOOLS` in
   `src/integration/mcpServer.test.ts` when the server surface changes. Add a
   README table row when a tool ships.

Unreleased after 0.8.0: `diagrams_save_export` (`diagramsSaveExport.ts`) saves a self-contained HTML bundle through the dedicated `DiagramStore.writeHtmlExport` method. This path accepts only `.html`, creates files exclusively, and leaves the normal diagram extension gates intact. Both export tools use the same bundle builder and UTF-8 byte limit; only the explicit save tool writes. Export files are excluded from normal diagram listing and CRUD.

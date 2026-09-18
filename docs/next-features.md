# Next Features — Development Phase Reference

> **Status:** the single to-do reference for this development phase. Every feature
> ships by checking off its boxes, in phase order. Nothing here is implemented yet.
> Repo baseline: `diagrams-mcp-server` v0.6.0, TypeScript ESM, Node >=18 runtime,
> Node >=20.19 dev toolchain, 7 MCP tools, zero production dependencies beyond
> `@modelcontextprotocol/sdk` and `zod`.

## Identity recap

`diagrams-mcp-server` is a **local-first MCP server** giving AI coding agents
structured access to a project's PlantUML and Mermaid diagrams — **manage**,
**render**, and **verify them against the codebase**, over stateless stdio.

Every feature below serves that identity, and is rejected if it does not:

- **Dependency-free** — no new production dependencies; optional capabilities
  resolve at runtime and degrade openly (see the `typescript` dynamic-import
  precedent in `src/services/consistencyChecker/ts/tsParse.ts`).
- **No network** — the only existing network path is the opt-in PlantUML remote
  fallback, gated by `ALLOW_REMOTE_PLANTUML` and overridden by
  `DISABLE_REMOTE_PLANTUML`. Nothing new may add a second one.
- **Explicit caps** — every bound is a named `MAX_*` constant in
  `src/constants.ts` with an explanatory comment, echoed in the tool description
  and the README, and reported in the tool output when it bites.
- **Never silently truncate** — a capped result always says so in-band
  (`truncated` / `scan_warning` / `*_limit`), the way
  `diagrams_check_consistency` and `diagrams_get` already do.
- **Heuristic confidence labeled honestly** — every heuristic output carries
  `confidence: "heuristic"` plus a `heuristic_warning` that says what the
  heuristic can and cannot tell you. Deterministic outputs say so instead.

## How to use this file

1. Work the phases in order (see [Phase order](#phase-order-and-dependencies)).
2. Before opening a PR for a feature, tick every box in its
   [Acceptance checklist](#1-diagrams_generate). Each box is verifiable by
   running a command or reading a file — none is subjective.
3. Cross-cutting rules that apply to all six live in
   [Global gates](#global-gates). They are not repeated per feature.
4. [6. Watch note](#6-watch-note) is a decision record, not a backlog item. It
   is in force from day one of the phase; do not re-litigate it mid-phase.

---

## 1. `diagrams_generate`

**Goal:** draft a class diagram *from a slice of the codebase*, returning source
text the agent reviews and then saves with `diagrams_create`.

**Why it fits the identity:** it closes the loop the consistency checker opened —
the same code-reading machinery that detects drift can seed the diagram in the
first place. It stays local, dependency-free, and read-only: the tool never
writes, so nothing lands in `diagrams/` without an explicit
`diagrams_create` call. It is heuristic (name extraction, not full type
modeling) and says so in every result.

**Proposed tool contract**

- **Tool name:** `diagrams_generate` · **File:** `src/tools/diagramsGenerate.ts`
  · registered in `src/index.ts`.
- **Inputs** (strict zod object):
  - `scope` (string, required) — relative path under `PROJECT_ROOT` pointing at
    a file or a directory. Reject anything that resolves outside `PROJECT_ROOT`
    with a typed error. Default when omitted: `.` (the whole project root,
    matching `diagrams_check_consistency`).
  - `format` (enum `"puml" | "mermaid"`, default `"puml"`) — output dialect.
  - `max_entities` (integer `1`–`60`, default `30`) — hard cap on emitted
    declarations.
  - `include_relations` (boolean, default `true`) — emit `A <|-- B` /
    `A <|.. B` style edges when relation evidence is available.
- **Outputs** — text block = the generated source; `structuredContent`:
  ```jsonc
  {
    "scope": "src/services",            // POSIX, as resolved
    "format": "puml",
    "source": "<the generated diagram>", // identical to the text block
    "entities": ["User", "Order"],      // in emission order, capped
    "entities_included": 12,
    "entities_available": 40,           // total found, may exceed the cap
    "entities_capped": true,            // never silently drop
    "entity_limit": 30,
    "relations": [{ "from": "User", "to": "Entity", "kind": "implements" }],
    "relations_available": 9,
    "relations_capped": false,
    "relation_limit": 60,
    "files_scanned": 38,
    "truncated": false,                 // scan-cap reached (mirrors consistency check)
    "scan_limit": 5000,
    "scan_warning": null,
    "dialect_note": "relations unavailable: the TypeScript compiler is not installed; entities only",
    "confidence": "heuristic",
    "heuristic_warning": "<what name extraction can and cannot tell you>",
    "written": false                    // always false; save with diagrams_create
  }
  ```
- **Annotations:** `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`.

**Reuses what**

- `collectCodeFiles` and the scan-limit reporting pattern
  (`src/services/consistencyChecker/scanning.ts`, `index.ts`).
- `stripCommentsAndStrings` / `extractDeclaredIdentifiers` /
  `familyForExtension` (`codeAnalysis.ts`) for the non-TS heuristic path.
- `analyzeTsFile` → `parseTsSource` + `collectTsDeclaredSymbols`
  (`consistencyChecker/ts/`) for the AST path, including its dynamic-import
  fallback so a missing `typescript` degrades openly instead of failing.
- `validateDiagramSource` (`diagramValidator.ts`) as a self-check: the emitted
  source must pass the same gate `diagrams_create` enforces.
- `toPosixPath`, `TYPE_TO_EXTENSION`, and the `MAX_*` constant style
  (`constants.ts`); `handleToolError` + a new typed domain error
  (`toolError.ts`).
- **New (small):** a scope resolver that bounds reads to `PROJECT_ROOT`
  (consistency scanning has no such scoping today), and — only if
  `include_relations` ships in phase 1 — an `extends`/`implements` visitor next
  to `tsSymbols.ts`. If the visitor is deferred, `relations: []` plus an explicit
  `dialect_note` is acceptable for phase 1.

**Non-goals / V2**

- No layout control, no member/attribute emission, no package/namespace nesting.
- No semantic type resolution — cross-file inheritance through re-exports is out.
- No writing to `diagrams/` (the agent pairs this with `diagrams_create`).
- No generation from non-class diagram kinds (see feature 3 for sequences).

**Acceptance checklist**

- [x] `src/tools/diagramsGenerate.ts` exists and `registerDiagramsGenerate` is
      called from `src/index.ts` after the existing seven registrations.
- [x] The zod schema is `.strict()`, every input has a `.describe(...)` line, and
      `max_entities` is bounded `1`–`60` with the bounds echoed in the tool
      description text.
- [x] A new `MAX_GENERATE_ENTITIES` (and, if shipped, `MAX_GENERATE_RELATIONS`)
      constant is added to `src/constants.ts` with an explanatory comment, and
      the same value appears in the tool description and README.
- [x] `written` is always `false` in output, and a test asserts no file is
      created under the diagrams root or anywhere under `PROJECT_ROOT` after a
      call.
- [x] A call whose `scope` resolves outside `PROJECT_ROOT` returns
      `isError: true` with a message naming the refusal, and no file is read.
- [x] When the entity count exceeds `max_entities`, output carries
      `entities_capped: true`, `entities_available` above `entities_included`,
      and `entity_limit` equal to the applied cap.
- [x] When the scan reaches the file cap, output carries `truncated: true` and a
      non-null `scan_warning`, matching the consistency checker's wording.
- [x] Emitted source passes `validateDiagramSource` for both `puml` and
      `mermaid` (asserted in a unit test for every emitted dialect).
- [x] The new typed domain error is added to `isExpectedToolError` in
      `src/tools/toolError.ts`; unexpected failures still return the generic
      "Unexpected internal error" result with an stderr log that carries no
      paths, source, or arguments.
- [x] `README.md` gains a table row and the tool count is updated everywhere it
      appears (features table and any "7 tools" phrasing).
- [x] `src/integration/mcpServer.test.ts` `EXPECTED_TOOLS` includes the new name
      and the discovery assertion passes.
- [x] `npm run build`, `npm test`, `npm run lint`, and `npm run format:check`
      all pass; `node dist/index.js --help` exits 0.

**Test plan**

- **Unit:** `src/tools/diagramsGenerate.test.ts` — caps, capping flags, scope
  rejection, both output dialects, `written: false`, and the AST-missing path
  (stub `loadTsModule` to `null`; assert `relations: []` plus a non-empty
  `dialect_note`, never a thrown error).
- **Goldens:** `src/services/generate/generateGoldens.test.ts` — a fixed tmp-dir
  codebase (the `writeFiles` helper pattern from
  `consistencyChecker/ts/tsGoldens.test.ts`) asserting the exact emitted entity
  list for TS, TSX, Python, and one generic-extension file; plus a golden for the
  `mermaid` dialect output.
- **Integration:** one `diagrams_generate` call through the real stdio server in
  `mcpServer.test.ts` against the existing `widget.ts` fixture, asserting
  `structuredContent.entities` contains `Widget`, plus a POSIX `scope` field.

---

## 2. `diagrams_diff`

**Goal:** compare two diagram sources — two stored files, or a stored file
against working text — and report **added / removed / renamed** entities in
structured form.

**Why it fits the identity:** drift detection today answers "does the diagram
match the *code*?" This answers "what changed between *two versions of the
diagram*?" — the review-time question an agent faces after editing one. It is
pure string/structure comparison over sources the store already knows how to
read: no new I/O surface, no writes, no network, and the same honest
`confidence: "heuristic"` label because rename detection is name-similarity, not
semantic identity.

**Proposed tool contract**

- **Tool name:** `diagrams_diff` · **File:** `src/tools/diagramsDiff.ts`.
- **Inputs** (strict zod object). Two sides, `a` and `b`; each side supplies
  **exactly one** of:
  - `a_relative_path` / `b_relative_path` (string, diagram in the diagrams root)
  - `a_content` / `b_content` (string, inline source — lets an agent diff
    unstaged text without a round trip)
  - Supplying both for one side, or neither, is an `isError` result with an
    actionable message.
- **Outputs** — text block = a human-readable summary; `structuredContent`:
  ```jsonc
  {
    "a": { "source": "models/user.puml", "type": "plantuml" },  // path, or "<inline>"
    "b": { "source": "<inline>", "type": "mermaid" },
    "added": [{ "name": "Invoice" }],
    "removed": [{ "name": "LegacyUser" }],
    "renamed": [
      { "from": "User", "to": "Account", "confidence": "heuristic" }
    ],
    "unchanged": ["Order", "Cart"],
    "unchanged_count": 2,
    "participants_added": ["PaymentGateway"],   // sequence diagrams only
    "participants_removed": [],
    "calls_added": ["charge"],
    "calls_removed": ["refund"],
    "is_same": false,
    "confidence": "heuristic",
    "heuristic_warning": "<rename detection is name-similarity, not semantic identity>"
  }
  ```
- **Annotations:** `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`.

**Reuses what**

- `extractEntities` (`consistencyChecker/entities.ts`) for declaration names in
  both dialects; `extractPlantUmlParticipants` / `extractMermaidParticipants`
  and `extractMessageCalls` for the sequence-side fields.
- The lenient normalizer used for matching — currently the private
  `normalizeForMatch` in `consistencyChecker/index.ts`. **Extract it to a shared
  module** (e.g. `src/services/nameNormalize.ts`) and have both
  `consistencyChecker/index.ts` and this feature import it, so rename detection
  and consistency matching cannot drift apart.
- `DiagramStore.read` for stored sides (inherits path-traversal protection,
  extension gating, and `DiagramNotFoundError`).
- `toPosixPath`, `handleToolError`, and the existing typed store errors — no new
  domain error is expected beyond an input-shape one.

**Non-goals / V2**

- No layout, position, or style diff; no member-level diff.
- No git integration (no `HEAD:` revisions, no `git show`) — inline
  `*_content` covers the "previous version" case for now.
- No merge or patch generation; the tool reports, the agent edits.
- Rename confidence stays `"heuristic"` — a real "did this get renamed?" verdict
  needs call-site analysis and is V2.

**Acceptance checklist**

- [x] `src/tools/diagramsDiff.ts` exists and is registered in `src/index.ts`.
- [x] Exactly-one-per-side validation returns `isError: true` for all four
      malformed combinations (both, neither, and the two mixed cases), with a
      message that names the offending side.
- [x] Reading a stored side goes through `ctx.diagramStore.read`, so a missing
      diagram yields `Error: No diagram found at '<path>'` and a traversal
      attempt yields `Error: Refused to access path outside the diagrams root`.
- [x] `added` and `removed` are exact set differences of extracted entity names,
      and a test asserts they are symmetric when the two sides are swapped.
- [x] `renamed` pairs a removed name with an added name only via the shared
      normalizer, each entry carries `confidence: "heuristic"`, and a purely
      reordering change produces zero renames.
- [x] Sequence-side fields are populated for both `puml` and `mmd` sequence
      sources, and are `[]` (never `undefined`) for class diagrams.
- [x] `is_same` is `true` iff `added`, `removed`, and `renamed` are all empty,
      and the text summary then says so in one line.
- [x] The shared normalizer module is imported by both
      `consistencyChecker/index.ts` and the diff service; no duplicated
      normalization logic exists (verifiable by grepping the two call sites).
- [x] Output paths are POSIX on both `a` and `b` sides, asserted by a test on
      Windows CI as well as Linux.
- [x] `README.md` gains a table row; `EXPECTED_TOOLS` and the discovery test in
      `mcpServer.test.ts` are updated.
- [x] `npm run build`, `npm test`, `npm run lint`, and `npm run format:check`
      pass; `node dist/index.js --help` exits 0.

**Test plan**

- **Unit:** `src/tools/diagramsDiff.test.ts` — added/removed symmetry, rename
  pairing and its `confidence` label, four input-shape errors, both dialects,
  sequence participants/calls, identical sides, and a path/inline mix.
- **Goldens:** `src/services/diff/diffGoldens.test.ts` — fixed source pairs
  (PlantUML class, Mermaid class, PlantUML sequence, Mermaid sequence) asserting
  the exact `added` / `removed` / `renamed` arrays, so a future extraction
  regression is caught by a diff of the golden, not by a human.
- **Integration:** in `mcpServer.test.ts`, create a diagram, `diagrams_update`
  it, then `diagrams_diff` the stored v2 against `a_content` = v1, asserting
  `added` contains the newly introduced entity.

---

## 3. Sequence-from-code — `diagrams_generate_sequence`

**Goal:** generate a starter **sequence** diagram from the message-call patterns
found in a codebase slice.

**Why it fits the identity:** the roadmap already names "sequence diagram
consistency checks against actual function call graphs", and the ordered
call-graph machinery to do it is already in the tree
(`consistencyChecker/sequence/callGraph.ts`). This is the generative flip side
of the same evidence — and it is *even more* clearly a heuristic: static
call-site order is not runtime order, so every output says so and every
callback-deferred call is reported rather than silently sequenced. Local,
read-only, dependency-free, capped.

**Proposed tool contract**

- **Tool name:** `diagrams_generate_sequence` · **File:**
  `src/tools/diagramsGenerateSequence.ts`.
- **Inputs** (strict zod object):
  - `scope` (string, required) — same resolution and rejection rules as
    `diagrams_generate`, reusing the same scope resolver.
  - `format` (enum `"puml" | "mermaid"`, default `"puml"`).
  - `max_participants` (integer `1`–`20`, default `8`).
  - `max_messages` (integer `1`–`50`, default `20`).
- **Outputs** — text block = the generated source; `structuredContent`:
  ```jsonc
  {
    "scope": "src/services",
    "format": "puml",
    "source": "<generated sequence diagram>",
    "participants": ["Checkout", "Payment"],
    "participants_included": 2,
    "participants_available": 5,
    "participants_capped": true,
    "participant_limit": 8,
    "messages": [
      { "from": "Checkout", "to": "Payment", "message": "charge", "line": 14,
        "via_callback": false }
    ],
    "messages_included": 4,
    "messages_available": 11,
    "messages_capped": true,
    "message_limit": 20,
    "deferred_count": 3,     // call sites inside callbacks/promises, excluded from ordering
    "unresolved_callees": ["logger"],  // callees with no declared participant
    "files_scanned": 12,
    "truncated": false,
    "scan_limit": 5000,
    "scan_warning": null,
    "confidence": "heuristic",
    "heuristic_warning": "<static call order is not runtime order; participant mapping is identifier equality only>",
    "written": false
  }
  ```
- **Annotations:** `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`.

**Reuses what**

- `extractCallEdges` (`sequence/callGraph.ts`) — ordered `caller → callee` edges
  with `viaCallback` and source line numbers; its `CALL_KEYWORDS` /
  construction-skipping rules are inherited as-is.
- `buildOperationIndex` and `mapParticipants` (`sequence/`) for
  callee-to-participant resolution by declared-identifier equality.
- The same scan + AST stack as feature 1: `collectCodeFiles`,
  `stripCommentsAndStrings`, `analyzeTsFile`, and the shared scope resolver.
- `validateDiagramSource` as the emitted-source self-check (must be accepted by
  `diagrams_create`), `toPosixPath`, `handleToolError`, and the shared
  normalizer for case-insensitive participant matching.

**Non-goals / V2**

- No type-based participant resolution (no "which class is this method on") —
  unresolved callees are reported in `unresolved_callees`, not guessed.
- No async/ordering semantics: `await` chains and callback orderings are not
  sequenced; deferred calls are counted and excluded.
- No cross-language or dynamic-dispatch inference; no message arguments.
- No writing to `diagrams/` — same rule as feature 1.

**Acceptance checklist**

- [x] `src/tools/diagramsGenerateSequence.ts` exists and is registered in
      `src/index.ts`; the tool description states up front that static call
      order is not runtime order.
- [x] `max_participants` (`1`–`20`) and `max_messages` (`1`–`50`) are enforced by
      the zod schema, and both bounds appear in the tool description and README.
- [x] `MAX_SEQUENCE_PARTICIPANTS` and `MAX_SEQUENCE_MESSAGES` constants are added
      to `src/constants.ts` with explanatory comments.
- [x] A call site with `via_callback: true` is never emitted as an ordered
      message; it is counted in `deferred_count` (asserted against a fixture
      containing a `setTimeout`/`.then(` call).
- [x] Callees with no matching declared participant appear in
      `unresolved_callees` and are emitted as self-messages or skipped — never
      as an invented participant.
- [x] Participant names containing characters illegal in a sequence participant
      are sanitized or quoted per dialect, and the emitted source still passes
      `validateDiagramSource`.
- [x] `written` is always `false`; a test asserts no new file exists under
      `PROJECT_ROOT` after a call.
- [x] Scope rejection reuses the exact typed error and message as feature 1
      (shared resolver, not a second implementation).
- [x] `README.md` gains a table row and mentions the roadmap item this delivers;
      `EXPECTED_TOOLS` and the discovery test are updated.
- [x] `npm run build`, `npm test`, `npm run lint`, and `npm run format:check`
      pass; `node dist/index.js --help` exits 0.

**Test plan**

- **Unit:** `src/tools/diagramsGenerateSequence.test.ts` — participant/message
  caps and their flags, callback deferral, unresolved callees, scope rejection,
  both dialects, and `written: false`.
- **Goldens:** `src/services/generate/sequenceGoldens.test.ts` — a fixed
  tmp-dir module pair (a caller file calling a callee file) asserting the exact
  ordered `messages` array and the emitted source; a second golden where the
  only call is inside a callback, asserting `messages: []` and
  `deferred_count: 1`.
- **Integration:** one call through the real stdio server against a fixture with
  two TS files, asserting `isError` is unset, `participants` is non-empty, and
  the first message's `from`/`to` are among the participants.

---

## 4. Starter templates — `diagrams_template`

**Goal:** let the agent instantiate a minimal, always-valid skeleton (class,
sequence, C4-context) instead of hand-writing boilerplate.

**Why it fits the identity:** boilerplate is where syntax errors, missing
`@startuml`/`@enduml` boundaries, and inconsistent style enter the repo. One
capped, deterministic, dependency-free generator removes that failure mode and
keeps every diagram the store sees uniform. Templates live in source as data —
the published payload ships only `dist/`, `README.md`, and `LICENSE`, so nothing
new is added to `files`, and no template file can go missing at install time.

**Proposed tool contract**

- **Tool name:** `diagrams_template` · **File:** `src/tools/diagramsTemplate.ts`.
- **Inputs** (strict zod object):
  - `template` (enum `"class" | "sequence" | "c4_context"`, required).
  - `format` (enum `"puml" | "mermaid"`, default `"puml"`).
  - `title` (string, optional, max `200` characters — empty/whitespace is
    rejected rather than emitting an empty `title` line).
  - `entities` (array of strings, `1`–`20` items; each matches
    `/^[A-Za-z_][A-Za-z0-9_]*$/` and is at most `60` characters).
- **Outputs** — text block = the skeleton source; `structuredContent`:
  ```jsonc
  {
    "template": "class",
    "format": "puml",
    "title": "User Model",
    "source": "<skeleton, identical to the text block>",
    "entities": ["User", "Order"],
    "entities_included": 2,
    "deterministic": true,   // no heuristics, no reading of code or disk
    "written": false
  }
  ```
- **Annotations:** `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true` (same inputs → byte-identical source),
  `openWorldHint: false`.

**Reuses what**

- `validateDiagramSource` (`diagramValidator.ts`) — the emitted skeleton must
  clear the exact gate `diagrams_create` applies, so a template output can
  always be passed straight to `diagrams_create`.
- `EXTENSION_TO_TYPE` / `TYPE_TO_EXTENSION` and `toPosixPath` (`constants.ts`);
  `handleToolError` for input validation failures.
- `MAX_TEMPLATE_ENTITIES` and `MAX_ENTITY_NAME_CHARS` as new `MAX_*` constants.
- **New:** a small pure module (`src/services/templates/`) holding the skeleton
  tables — one emitter per template kind per dialect, no filesystem, no state.

**Non-goals / V2**

- No wizard, no interactive prompts, no writing to `diagrams/` — the agent saves
  with `diagrams_create`, same as features 1 and 3.
- No styling/theming, no member bodies, no relationship inference (features 1 and
  3 own generated content; this is hand-instantiated scaffolding).
- No custom template files or user template directory — the set is fixed at
  three; a fourth is a deliberate schema change.

**Acceptance checklist**

- [x] `src/tools/diagramsTemplate.ts` exists and is registered in `src/index.ts`.
- [x] All three templates are emitted in **both** dialects (six emitters), and
      every one of the six outputs passes `validateDiagramSource` — asserted in
      a table-driven unit test.
- [x] A Mermaid C4-context skeleton uses only `c4Context`/`c4Container`-style
      starters accepted by `MERMAID_STARTERS` in `diagramValidator.ts`.
- [x] `entities` validation rejects: empty array, more than 20 items, a name
      over 60 characters, a name failing the identifier pattern, and duplicate
      names — each with `isError: true` and a message naming the offending input.
- [x] `title` over 200 characters or whitespace-only is rejected; an accepted
      title appears in the source in the dialect-correct form (`title X` for
      PlantUML, `%% title: X` for Mermaid).
- [x] `deterministic: true` and a test asserting two identical input sets return
      byte-identical `source` across separate process runs.
- [x] `written` is always `false`, and no file under `PROJECT_ROOT` is created
      or modified by a call.
- [x] The skeleton set is fixed in source under `src/services/templates/` with
      no runtime file reads; `package.json` `files` is unchanged (verified by
      reading the array, not by inference).
- [x] `README.md` gains a table row; `EXPECTED_TOOLS` and the discovery test are
      updated.
- [x] `npm run build`, `npm test`, `npm run lint`, and `npm run format:check`
      pass; `node dist/index.js --help` exits 0.

**Test plan**

- **Unit:** `src/tools/diagramsTemplate.test.ts` — the six-emitter validity table
  above, all input-validation rejections, idempotence, and `written: false`.
- **Goldens:** `src/services/templates/templateGoldens.test.ts` — the exact
  emitted source string per (template, format) pair with a two-entity input, so
  any cosmetic drift in a skeleton shows up as a failing golden.
- **Integration:** in `mcpServer.test.ts`, call `diagrams_template`, then feed
  the returned `source` straight into `diagrams_create`, asserting the create
  succeeds and `diagrams_get` reads it back unchanged — proving the
  template→create handoff works over real stdio.

---

## 5. Export bundle — `diagrams_export`

**Goal:** package a stored diagram plus its rendered SVG into **one self-contained
HTML file** for sharing outside the repo.

**Why it fits the identity:** the renderer already produces SVG locally; this is
purely packaging of two existing artifacts. It adds no dependency (the HTML is
string concatenation), no network (it reuses the *existing* renderer path with
its existing opt-in rules), and no new write surface — the artifact is returned
as text so the agent decides where it lands. Caps and the
never-silently-truncate rule apply to the bundle bytes exactly as they do to
renderer output.

**Proposed tool contract**

- **Tool name:** `diagrams_export` · **File:** `src/tools/diagramsExport.ts`.
- **Inputs** (strict zod object):
  - `relative_path` (string, required) — diagram in the diagrams root.
  - `include_source` (boolean, default `true`) — embed the diagram source in a
    collapsible `<pre>` block so the artifact is self-documenting.
- **Outputs** — text block = the HTML (a `text` content block, not an image
  block); `structuredContent`:
  ```jsonc
  {
    "relative_path": "models/order-flow.puml",
    "diagram_type": "plantuml",
    "format": "html",
    "bytes": 18432,          // length of the returned HTML
    "svg_chars": 14200,      // size of the inlined SVG
    "source_included": true,
    "truncated": false,      // always false; over-cap bundles are an error, never a cut file
    "rendered_with": "local-plantuml"  // or "remote-plantuml" / "mmdc", mirroring renderer provenance
  }
  ```
- **Annotations:** `readOnlyHint: true` (reads the diagram and renders it;
  writes nothing), `destructiveHint: false`, `idempotentHint: true`,
  `openWorldHint: true` — same as `diagrams_render`, because rendering may touch
  a local CLI or the opt-in remote fallback.

**Reuses what**

- `renderDiagram` (`renderer.ts`) with its `RendererDeps` seam, so the bundle is
  unit-testable with stubbed CLIs exactly as `renderer.test.ts` does.
- The renderer's availability contract verbatim: Mermaid requires `mmdc` (no
  fallback), PlantUML prefers the local CLI and only uses the remote server when
  `ALLOW_REMOTE_PLANTUML=true` and `DISABLE_REMOTE_PLANTUML` is not `true`.
- `handleToolError` for the read step and `handleRenderError` for the render
  step — the same two-`try` structure as `diagramsRender.ts`.
- `DiagramStore.read` (path-traversal safe), `toPosixPath`, and a new
  `MAX_EXPORT_HTML_BYTES` constant (proposed `5_000_000`, matching
  `MAX_REMOTE_BODY_BYTES`).

**Non-goals / V2**

- **No writing of the `.html` file.** `DiagramStore` only handles diagram
  extensions, so a `.html` write would need a second write path and a second
  security review. Returning the HTML as text keeps the write surface
  unchanged; the agent writes it wherever it wants. (Optional in-repo saving is
  a V2 follow-up and must go through its own store method, not a loosened
  extension check.)
- No PNG embedding, no theming, no interactivity, no JS — inline styles only.
- No external resources of any kind (no CDN, no fonts, no network fetch), so the
  artifact works fully offline and survives CSP.

**Acceptance checklist**

- [x] `src/tools/diagramsExport.ts` exists and is registered in `src/index.ts`.
- [x] The produced HTML is a single file: it contains no `src=`, `href=`, `@import`,
      or `<script>` referencing any URL, and no external resource is fetched
      (asserted by a test that greps the output for those patterns).
- [x] The SVG is inlined as markup, not base64-in-`img`, so it stays selectable
      and themeable; the diagram's POSIX `relative_path` is the only path
      present — no absolute paths anywhere in the bundle (asserted by a test).
- [x] A bundle larger than `MAX_EXPORT_HTML_BYTES` returns `isError: true` with an
      actionable message; `truncated` is never `true` (no partial bundles).
- [x] Rendering failures surface through `handleRenderError` with the existing
      `RenderError` messages (missing `mmdc`, missing local `plantuml` with
      remote disabled, remote non-2xx) — no new wording invented here.
- [x] A missing diagram returns `Error: No diagram found at '<path>'` via
      `handleToolError`, before any render attempt.
- [x] `include_source: false` omits the `<pre>` block and sets
      `source_included: false`; default `true` includes it.
- [x] The tool works with `DISABLE_REMOTE_PLANTUML=true` set (the CI test
      environment), asserting no network path is taken.
- [x] `README.md` gains a table row noting the offline/self-contained property;
      `EXPECTED_TOOLS` and the discovery test are updated.
- [x] `npm run build`, `npm test`, `npm run lint`, and `npm run format:check`
      pass; `node dist/index.js --help` exits 0.

**Test plan**

- **Unit:** `src/tools/diagramsExport.test.ts` — with `RendererDeps` stubs
  returning a fixed SVG (no real CLI, no network): HTML self-containment, no
  absolute paths, `include_source` both ways, byte cap refusal, and every
  renderer-error path above.
- **Goldens:** `src/services/export/exportGoldens.test.ts` — a fixed small SVG
  plus a fixed source asserting the exact HTML wrapper structure (title, SVG
  position, source block), so wrapper drift is caught as a golden diff.
- **Integration:** discovery-only in `mcpServer.test.ts` (the tool appears in
  `listTools`), matching the existing precedent that no global renderer is
  installed in CI — full render paths stay in the stubbed unit tests.

---

## 6. Watch note

**Goal:** record, in the project's own reference file, that **live watch mode is
out of scope** for this server, with the reason — so nobody re-proposes it
mid-phase.

**Decision record (in force from day one of this phase):**

- **The server is stateless stdio.** An MCP client launches `dist/index.js` per
  session, talks request/response, and tears it down. There is no long-lived
  process to register a file watcher in, and no session-scoped notification
  channel to push "diagram X changed" into.
- **The existing surface is deliberately pull-based.** `diagrams_list`,
  `diagrams_get`, `diagrams_diff`, and `diagrams_check_consistency` answer
  drift questions *when the agent asks*. That is the whole design: the agent
  owns the loop, the server owns bounded, honest computation per call.
- **A watcher would break the local-first posture.** It means a background
  process surviving the client, an open file handle set, and a second
  notification path to secure — the opposite of "no accounts, no services,
  nothing running when the client is closed."
- **What would change the decision (re-proposal gate):** MCP resource
  subscription / server-initiated notification support landing as a stable,
  client-adopted feature of the transport, *and* a client that keeps the server
  alive for the session. Until both exist, the answer is no.

**Acceptance checklist**

- [ ] This section remains in `docs/next-features.md` for the whole phase and is
      referenced (by anchor) from any feature whose design touches freshness —
      specifically, features 2 and 3 state that re-checking is the agent's job,
      not the server's.
- [ ] No file-watcher dependency (`chokidar`, `nsfw`, or similar) appears in
      `package.json` `dependencies` or `devDependencies` during the phase
      (verified by reading `package.json`).
- [ ] No `fs.watch` / `fs.watchFile` call is added to `src/` during the phase
      (verified by grepping `src/`).
- [ ] If watch mode is raised in a PR review, the reviewer closes it by pointing
      at this section and the re-proposal gate above, not by re-arguing it.

**Test plan**

- None. This is a decision record; its "tests" are the two greps in the
  checklist above, which can be run at any point in the phase.

---

## Phase order and dependencies

Ship in this order. Each phase's checklist is complete only when its
predecessor's is.

| # | Feature                | Tool                          | Depends on                          | Unblocks                          |
|---|------------------------|-------------------------------|-------------------------------------|-----------------------------------|
| 1 | `diagrams_generate`    | `diagrams_generate`           | existing scan + AST stack           | features 2, 3, 4 demos            |
| 2 | `diagrams_diff`        | `diagrams_diff`               | feature 1's scope resolver (none — shared module extracted in phase 2) | feature 5's review story  |
| 3 | Sequence-from-code     | `diagrams_generate_sequence`  | feature 1's scope resolver + scan caps | feature 2's sequence-side diff fields |
| 4 | Starter templates      | `diagrams_template`           | nothing (pure, can parallelize)     | agent onboarding flow             |
| 5 | Export bundle          | `diagrams_export`             | existing renderer only              | sharing outside the repo          |
| - | Watch note             | —                             | nothing                             | nothing (decision record, live from day one) |

**Why this order:**

1. **`diagrams_generate` first** — the scope resolver, the scan-cap reporting,
   and the emitted-source self-check are the shared spine. Every later demo
   ("draft it, then diff it, then export it") starts from a generated diagram,
   so landing it first unblocks the others' demos.
2. **`diagrams_diff` second** — it is the natural review companion to feature 1
   and forces the shared name-normalizer out of `consistencyChecker/index.ts`
   early, while only one consumer exists. Phase 3 depends on that extraction
   being clean.
3. **Sequence-from-code third** — it reuses feature 1's resolver and the phase-2
   normalizer, and its `viaCallback` honesty rule needs the AST path from
   feature 1 to be settled.
4. **Starter templates fourth** — pure and dependency-free; safe to develop in
   parallel from phase 2 onward, but it ships after 3 so the "generated vs.
   templated" split stays clear in docs.
5. **Export bundle last among features** — it depends only on the renderer, but
   it is the demo payoff ("generate → refine → export"), so it lands once the
   pipeline behind it exists.
6. **Watch note** — in force from day one; it has no phase and no ship date.

---

## Global gates

Every feature, without exception, must satisfy all of these before its
checkboxes count as done.

**CI gates — all four green, on both OSes:**

- [ ] `npm run build` passes (`tsc`, no new errors, no `any`-leaks the config
      already forbids).
- [ ] `npm test` passes — and every new `*.test.ts` file is **added to the `test`
      script's explicit file list in `package.json`**, because the runner does
      not glob `dist/` (the README calls this out under "Project layout").
- [ ] `npm run lint` passes with `--max-warnings 0`.
- [ ] `npm run format:check` passes (Prettier: 100-col, double quotes,
      semicolons, trailing commas — see `.prettierrc.json`).
- [ ] `node dist/index.js --help` exits 0.
- [ ] All of the above pass on the CI matrix: `ubuntu-latest` and
      `windows-latest`, Node `20.x` and `22.x` (`.github/workflows/ci.yml`).

**Dependency rule:**

- [ ] `package.json` `dependencies` still contains exactly
      `@modelcontextprotocol/sdk` and `zod` — no new production dependency. Any
      optional capability must resolve at runtime and degrade openly, following
      the `typescript` dynamic-import precedent in
      `src/services/consistencyChecker/ts/tsParse.ts` (`typescript` stays a
      `devDependency`; it is not part of the published payload).

**Existing tool patterns — follow them, do not invent parallels:**

- [ ] One tool per file under `src/tools/`, registered from `src/index.ts` via a
      `registerDiagrams*` export that takes `(server, ctx)`.
- [ ] Strict zod input schema with `.describe(...)` on every field; tool
      `description` follows the existing sections: summary, `Args:`,
      `Returns:` (with the JSON schema inline), `Examples:` (use/don't-use), and
      `Error Handling:` (every documented error string, plus the generic
      "Unexpected internal error" line).
- [ ] `structuredContent` plus a text block, where the text block is the primary
      payload or a one-line summary that agrees with it — never a divergent
      restatement (see `diagrams_get`, where the text block *is* `content`).
- [ ] MCP `annotations` set deliberately (`readOnlyHint`, `destructiveHint`,
      `idempotentHint`, `openWorldHint`) and consistent with the tool's real
      effects.
- [ ] **Typed domain errors via `src/tools/toolError.ts`**: expected domain
      errors pass through with their message; everything else is logged to
      stderr (tool name and error *name* only — no arguments, messages, stacks,
      source, secrets, or paths) and returned as the generic
      "Unexpected internal error" result. Any new domain error class is added to
      `isExpectedToolError` (or `isExpectedRenderError` for the render step).
- [ ] **POSIX paths in outputs** — every path a tool returns goes through
      `toPosixPath`; Windows separators never reach the client (asserted in
      `mcpServer.test.ts` with `assertPosixPath`).
- [ ] **Never silently truncate** — every cap reports itself in-band, in the
      same shape as the existing `truncated` / `scan_limit` / `scan_warning`
      triple and the `is_partial` / `has_more` pair.
- [ ] **Heuristics labeled honestly** — heuristic outputs carry
      `confidence: "heuristic"` and a `heuristic_warning` naming the limits;
      deterministic outputs (feature 4) say `deterministic: true` instead.
- [ ] **Read-only tools never write** — features 1, 3, and 4 return source with
      `written: false`; the agent saves via `diagrams_create`. No feature adds a
      write path outside `DiagramStore`, and no feature writes outside the
      configured diagrams root.
- [ ] No absolute paths in tool output, and no diagram source in error messages
      (the existing precedent: validation and render errors describe the
      problem, never the content).
- [ ] New `MAX_*` caps live in `src/constants.ts` with an explanatory comment,
      are echoed in the tool description, and are documented in the README at
      the same value.

**Docs and discovery:**

- [ ] `README.md` tool table gains a row per shipped tool, and every place that
      says "7 tools" (or lists the count) is updated; the roadmap section is
      trimmed of any item a feature now delivers.
- [ ] `src/integration/mcpServer.test.ts` `EXPECTED_TOOLS` lists every shipped
      tool and the discovery assertion passes; the suite stays hermetic
      (`DISABLE_REMOTE_PLANTUML=true`, no global renderers, no network).
- [ ] `npm pack` payload stays `dist/**` (minus `*.test.js`), `README.md`,
      `LICENSE` — no new shipped data files; templates and goldens live in
      `src/` and are excluded like the rest of the test surface.
- [ ] Boxes in this file are ticked as features ship, and the phase-order table
      above is updated if an order change is ever agreed — this file is the
      phase's single source of truth, not a post-hoc write-up.

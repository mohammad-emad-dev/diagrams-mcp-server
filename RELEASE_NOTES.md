# Unreleased after 0.9.0

Sequence generation now anchors each sender to the file containing the call
site. Duplicate or case-colliding caller declarations in earlier files no
longer redirect that sender. Callee lookup retains its case-insensitive first
declaring participant behavior and same-basename merging. This applies with
the optional TypeScript compiler and the heuristic fallback.

Typed scaffold fields accept one nullable arm around a supported scalar or
selected emitted-class type with an optional single array suffix. Both
`string | null` and `null | string` emit `string | null`. This also applies to
body fields when relationship mode implies typed members. Other unions and
bare `null` remain unsupported. Unknown-member and default modes are unchanged.
Labels remain bounded to 69 characters with a separate 60-character identifier
limit. Nullable labels use colon field notation and whitespace around the
separator counts toward the raw label limit. No runtime value or file write
is introduced.

# Release notes — 0.9.0

Fifteen tools (thirteen released in 0.8.0 plus `diagrams_save_export` and `diagrams_scaffold`, introduced in 0.9.0).

The SDK dependency floor is now `^1.31.0` and the lockfile uses SDK 1.32.1 with
updated affected transitive dependencies. Release verification resolved audit
findings affecting five dependency packages without adding production dependencies or changing
the Node engine range. Fresh publication also runs `npm audit` and a clean
tarball acceptance probe with actual local renderers before uploading that exact
verified tarball.

Local PlantUML and Mermaid SVG or PNG output is now limited to 5,000,000 bytes
before base64 encoding or HTML bundling. The reader stats and reads the same
open handle and reads at most one byte beyond the cap to detect observed file
growth. Images exactly at the limit remain valid. Oversized output raises an
actionable `RenderError` and the handle closes before temporary directory cleanup.
The file-size limit is separate from captured renderer stdout and stderr limits.

Remote PlantUML requests now retain their timeout through response body download
and reject decoded streams as soon as they exceed 5,000,000 bytes. Oversized
declared lengths are refused before payload buffering. Failed downloads and
unused HTTP error bodies are aborted. Existing status and limit error messages
and the injected `fetchRemote` response contract are preserved. No new dependency
or remote-rendering permission is introduced.

`diagrams_scaffold` adds `include_relations` (default `false`), implying typed
member generation. Labeled top-level `Owner --> Target : role` links between
explicit plain declared and emitted classes become typed fields; supported
target multiplicities `"*"`, `"0..*"`, `"1..*"` yield arrays. Body members win
conflicts, then the first accepted role wins. Limits are 30 total members per
class and 300 appended relationship fields per result. New relationship counts
and cap metadata report recognized candidates that were added or skipped.
Unsupported arrows, notes, comments and nested blocks are ignored. Existing
modes retain their outputs; no runtime values, inheritance or semantic recovery
are introduced. Comment/note/scope scanning is shared by members and relations.

`diagrams_scaffold` also accepts `include_types` (default `false`), which implies
member generation. It retains explicit field labels from the supported subset:
`string`, `number`, `boolean`, `bigint`, or an emitted class name, optionally with
one `[]`. Accepted fields use definite assignment (`name!: Type;`) without a
runtime initializer. Missing/unsupported labels and references to non-emitted
classes fall back to `unknown`. Type-mode responses add `include_types: true`,
`typed_fields`, and `unresolved_fields` alongside member metadata. Methods stay
unknown stubs. Existing modes remain unchanged; no semantic type inference or
relationship inference is added by field-type mode.

`diagrams_scaffold` now accepts `include_members` (default `false`). Opt-in mode
drafts fields as `unknown` and methods as throwing stubs from a limited grammar
of plain multiline PlantUML/Mermaid class blocks. Without `include_types`, it
discards field labels too; all modes discard method arguments, return labels,
modifiers, and implementation text. Only selected emitted classes receive
members, capped at 30 unique names per class. Opt-in responses add
`include_members: true`, `members_included`, `members_capped`, and `member_limit`.
Default source and response fields remain unchanged; both modes remain read-only.
Unsupported syntax, relationships, and runtime behavior are not recovered.

New: `diagrams_save_export` adds a fourteenth MCP tool. It saves the same
self-contained HTML bundle `diagrams_export` returns (SVG as a base64 data
image under `default-src 'none'; img-src data:; style-src 'unsafe-inline';
base-uri 'none'; form-action 'none'`) inside the diagrams root as a `.html`
file. Inputs are `relative_path`, `output_path` (`.html`, case-insensitive),
and `include_source` (default `true`); there is no overwrite option and the
response carries only a short acknowledgement plus `relative_path`,
`output_path`, `diagram_type`, `format`, `bytes`, `svg_chars`,
`source_included`, `truncated: false`, and `rendered_with`. The bundle is
measured against the existing 5,000,000-byte cap before any output directory or file
is created, and existing targets are refused atomically. Writes go through the
new `DiagramStore.writeHtmlExport` path only; diagram `read`/`write`/`delete`/
`list`/`exists` gates still reject `.html`, and `diagrams_export` keeps its
read-only response and cap behavior unchanged.

- AST-backed TypeScript sequence generation excludes inline callback bodies
  passed to constructors, using the same policy as ordinary call arguments.
  Eager constructor arguments remain direct; constructor names are not emitted.
  This is conservative static evidence, not a claim of asynchronous execution.
  The non-AST fallback is unchanged.

New: `diagrams_scaffold` adds a fifteenth MCP tool. It drafts empty exported
TypeScript classes from the heuristic entity-name candidates in a stored
diagram. It reads one diagram through the traversal-protected store, reuses
the existing `extractEntities(source, type)` unchanged, and emits
`export class Name {}` per emittable name with no writes, rendering, network,
or execution. Save the emitted TypeScript yourself manually, never via
`diagrams_create`.

Default candidate-only draft limits: names may include aliases, namespaces,
components, participants, and call names such as `charge`; class
kinds, members, field types, relations, and runtime behavior are not
recovered. Only `^[A-Za-z_][A-Za-z0-9_]*$` names at most 60 characters outside
the reserved and TypeScript-forbidden set are emitted; the rest are reported in
`skipped_entities`/`skipped_count` without renaming. Valid candidates before
the requested cap (default 30, maximum 60) are counted in `entities_available`;
over-cap UTF-8 sources above
1,000,000 bytes are rejected before extraction. Empty candidate sets succeed
with empty source. The optional member mode above adds limited stubs;
broader member syntax, richer types, broader relationships, and additional languages remain open.

---

# Release notes — 0.8.0

Package, runtime, lockfile, and registry metadata are aligned to `0.8.0`.
This release includes the earlier `0.7.0` development wave
documented below, which was not published to npm. Historical notes are
preserved as development records.

## Features and corrections

- `diagrams_list_templates` adds a thirteenth MCP tool. It lists the three
  built-in kinds and custom JSON filename candidates, scanning at most 1,000
  directory entries plus one lookahead. Discovery does not read file contents;
  candidates are validated when instantiated.
- Custom templates live in `.diagrams-templates/<id>.json`, with strict
  `puml`/`mermaid` source and entity objects and single-pass
  `{{title}}`/`{{entities}}`/`{{name}}` placeholders. Reads are capped at
  65,536 bytes and expanded output at 1,000,000 UTF-16 code units.
  Symlink template files and directories are rejected.
- TypeScript sequence generation uses AST call sites when the optional compiler
  is available. Missing compiler, non-TS files, and parse failures retain the
  heuristic fallback. Participant ownership remains file-level name matching;
  semantic type resolution and runtime ordering remain out of scope.
- `diagrams_generate_sequence` accepts `include_call_parentheses: true` to
  emit labels such as `charge()`. It defaults to false; raw message metadata
  and default output remain unchanged.
- `diagrams_diff` accepts `compare_call_order: true`, preserving recognized
  call-name repetitions and rejecting more than 10,000 calls on either side.
  It defaults to false. Arguments, endpoints, and runtime order are excluded.
- Shared call extraction recognizes short names such as `f()` and skips
  whole-line apostrophe/`%%` comments and line-leading PlantUML blocks.
  Inline/nested blocks and note bodies are not parsed specially.
- Structural cleanup separates tool adapters, services, setup modules, and
  build/test scripts. Registry metadata is aligned with the release version:
  both `server.json` versions are `0.8.0`.

## Compatibility changes

- All thirteen tools reject unknown argument keys. Correct misspelled or
  unsupported fields rather than relying on them being ignored.
- The SDK dependency floor is `^1.30.0`, matching the already-locked version.
- HTML exports embed SVG as a base64 data image under a restrictive CSP.
  SVG text is no longer selectable. Encoding isolates the image; it does not
  sanitize the SVG payload. The 5,000,000-byte cap measures the complete HTML
  bundle, and `svg_chars` measures the decoded, preamble-stripped SVG source.

---

# Release notes — 0.7.0

`diagrams-mcp-server` v0.7.0 is a backward-compatible minor release: no
existing MCP tool signature changes, no config changes. It grows the server
from 7 to 12 tools — five additive tools built in one phased wave, each
local-first, dependency-free, and covered by unit, golden, and stdio
integration tests. It also folds in the render/store hardening that closed
the wave's only CI failure.

## New tools

- `diagrams_generate` — drafts a capped class diagram (PlantUML or Mermaid)
  from a scoped codebase slice; returns source with `written: false` for the
  agent to save via `diagrams_create`. Reuses the consistency checker's scan
  stack and TypeScript AST relations.
- `diagrams_diff` — compares two diagram sources (stored path or inline text
  per side) reporting added / removed / renamed (renames labeled
  `confidence: "heuristic"`) plus sequence participant and call deltas.
- `diagrams_generate_sequence` — drafts a starter sequence diagram from
  ordered call-graph edges; callback-deferred calls are counted, never
  sequenced; unresolved callees are reported, never invented.
- `diagrams_template` — deterministic class / sequence / C4-context skeletons
  in both dialects, all six passing the same gate `diagrams_create` enforces.
- `diagrams_export` — packages a stored diagram plus its rendered SVG into one
  self-contained offline HTML file; over-cap bundles are refused, never cut.

## Render/store hardening

- Windows npm-shim spawning hardened: verbatim-argument gating on real
  `cmd.exe` targets, no `%` doubling, and `/c`-line wrapping for
  `cmd.exe /s` quote stripping (the CI-only 8.3-path failure that gated the
  wave is covered by a real-shim test).
- `DiagramStore.delete()`/`exists()` now enforce the diagram-extension gate
  like every other path; `overwrite: true` writes atomically via sibling temp
  file plus rename.

## Verification status (this release)

- `npm run build` (`tsc`): exit 0. `npm run lint` (zero warnings) and
  `npm run format:check`: pass.
- `npm test`: 405 tests across 81 suites — 396 passed, 0 failed,
  9 skipped (pre-existing environment-conditional skips: symlink creation and
  permission cases unobservable on Windows/OneDrive). Numbers measured on the
  release branch; rerun `npm run build` and `npm test` to re-verify.

## Known V2 follow-ups

- Renderer SVG is inlined as live markup in export bundles; a hostile SVG
  would come out active. Filed in `docs/next-features.md` (V2 follow-ups):
  allowlist SVG sanitizer plus inert-output tests. Threat model note:
  local-first, own diagrams, local CLIs — acceptable for V1.

---

# Release notes — 0.6.0

`diagrams-mcp-server` v0.6.0 is a backward-compatible minor release: no MCP
tool signature changes, no config changes. It sharpens consistency checking
with a real TypeScript parser and kind-aware sequence-diagram existence
checks. All findings stay `confidence: "heuristic"` evidence, never verdicts.

## TypeScript AST analyzer layer

- `.ts`/`.tsx` files now parse with the real TypeScript compiler API
  (`typescript` ships as a runtime dependency so the layer is active in
  packed installs, not just source checkouts).
- A successful parse matches on declarations only (strict-on-parsed: the
  whole-word fallback is skipped for that file); an unparseable file keeps
  the previous regex behavior. Either way the matched/unmatched contract is
  unchanged — the layer only widens what counts as evidence.

## Sequence-diagram existence layer

- Diagram entities are tagged by construct — participant, operation
  (message call), or structural — and unmatched names report
  construct-specific issue text instead of the generic message.
- Structural entities (class diagrams and everything else) keep the
  long-standing generic text byte-identical.
- Known gap, locked by test: Java has no method-declaration patterns, so
  method-only operations match via the whole-word fallback by design.

## Verification status (this release)

- `npm run build` (`tsc`): exit 0. `npm run lint` (zero warnings) and
  `npm run format:check`: pass.
- `npm test`: 222 tests across 58 suites — 221 passed, 0 failed,
  1 skipped (the documented Java method-pattern gap). Numbers measured on
  the release branch; rerun `npm run build` and `npm test` to re-verify.

---

# Release notes — V1 Preview / Technical Preview (0.1.0)

`diagrams-mcp-server` v0.1.0 is a Technical Preview (V1 Preview): a local-first
MCP server that gives AI coding agents
structured access to a project's PlantUML and Mermaid diagrams. The V1 focus
is architecture drift detection: answering "does this diagram still describe
what exists in the repository?" Diagram CRUD and rendering support that
workflow.

## MCP tools

| Tool | What it does |
|---|---|
| `diagrams_list` | List all PlantUML/Mermaid diagrams under the diagrams root, with extracted titles and explicit `offset`/`limit` pagination |
| `diagrams_get` | Read the raw source of a diagram, in full or as an explicit `offset`/`max_chars` window |
| `diagrams_create` | Create a new diagram file (refuses to overwrite) |
| `diagrams_update` | Replace an existing diagram's content |
| `diagrams_delete` | Delete a diagram (explicit, marked `destructiveHint`) |
| `diagrams_render` | Render a diagram to SVG/PNG |
| `diagrams_check_consistency` | Compare diagram entities against the codebase and flag drift (read-only) |

Transport is stdio only, for local MCP clients. Every tool uses a strict Zod
input schema and stable structured output; expected failures (missing file,
unsupported extension, unsafe path, missing renderer) return `isError: true`
with a human-readable message.

## Pagination and source windows

Paging is explicit and opt-in; the server never pages or truncates on its own.

- `diagrams_list` accepts optional `offset` (non-negative integer, default
  `0`) and `limit` (integer `1`–`500`). Omitting both returns every match,
  preserving the previous default behavior. The response carries `count`,
  `total`, the effective `offset`/`limit`, and `has_more`. An `offset` past
  the end yields an empty page with `has_more: false`. Invalid values
  (negative or non-integer `offset`, `limit` outside `1`–`500`) return an
  `isError` result. Paths stay POSIX-normalized and no match is silently
  dropped. Example: `diagrams_list({ "type_filter": "all", "limit": 10 })`,
  then repeat with `offset: 10` while `has_more` is true.
- `diagrams_get` accepts optional `offset` (zero-based character offset,
  default `0`) and `max_chars` (integer `1`–`100000`). Omitting both returns
  the full source, preserving the previous default behavior. The response
  carries `is_partial`, the effective `offset`, `total_chars`,
  `returned_chars`, and `has_more`, and the text block always equals the
  returned `content`. An `offset` past the end of the source returns an
  `isError` result. Example:
  `diagrams_get({ "relative_path": "models/big.puml", "offset": 0, "max_chars": 2000 })`.

## Diagram support

- PlantUML: `.puml`, `.plantuml`
- Mermaid: `.mmd`, `.mermaid`

`diagrams_render` behavior:

- Mermaid is always local-only. It requires the `mmdc` CLI
  (`npm install -g @mermaid-js/mermaid-cli`); without it, rendering fails
  with an actionable error. There is no remote fallback.
- PlantUML prefers a local `plantuml` CLI when available. Otherwise it fails
  with an actionable error unless remote rendering is explicitly enabled
  with `ALLOW_REMOTE_PLANTUML=true`, in which case it falls back to the
  public PlantUML rendering server over HTTPS (override with
  `PLANTUML_SERVER_URL`, e.g. a self-hosted instance).
- Privacy control: remote rendering is opt-in and disabled by default. Only
  the exact value `ALLOW_REMOTE_PLANTUML=true` enables the fallback; unset,
  `"false"`, or any other value keeps it disabled.
  `DISABLE_REMOTE_PLANTUML=true` always disables the fallback and takes
  precedence, even when the allow flag is also set. When remote rendering
  is disabled and no local CLI exists, rendering fails with an actionable
  error instead of sending diagram source off-machine.
- The remote fallback sends diagram source to the configured renderer. The
  consistency checker never sends code anywhere: it only reads local files.

## Language support

Reliable V1 analysis (fixture-backed, with documented limitations):

- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`) — classes, functions, modules,
  exported identifiers, and React components in JSX
- TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) — classes, interfaces, types,
  functions, modules, exported identifiers, and React components in TSX
- Python (`.py`) — classes, functions, module basenames
- PHP (`.php`) — classes, interfaces, traits, functions, last namespace segment
- Java (`.java`) — classes, interfaces, enums, records, last package segment

React support belongs to JavaScript/TypeScript (JSX/TSX), not a separate tier.
Hooks such as `useState`/`useEffect` are supporting signals, not architecture
entities.

Experimental (C#, Go, Ruby, Kotlin, Rust): these stay on the generic
whole-word heuristic path — no per-language declaration patterns, just
normalized/basename matching after comment and string stripping (Ruby also
strips `#` line comments; `=begin`/`=end` blocks and heredocs are not
specially handled). They are covered by smoke tests confirming the analyzer
does not crash or scan unrelated files, and must not be treated as equivalent
to the five reliable analyzers.

## Heuristic-analysis limitations

The consistency checker is a fast, dependency-free text heuristic, not a full
semantic or AST analysis:

- Matching prefers real declarations but still falls back to whole-word
  occurrence, case/separator-insensitive comparison, and file-basename
  comparison — an incidental reference can count as a match. Results are
  evidence, not a semantic verdict.
- Comments and quoted strings are stripped before matching, except template
  literal interpolations (treated as string content) and PHP heredoc/nowdoc
  blocks (not specially handled).
- Mermaid flowchart node ids and bare message labels without parentheses are
  not treated as entities.
- Scans are bounded (default exclusions for `node_modules`, `.git`, `dist`,
  `build`, virtual environments, and similar; 5,000-file and file-size caps).
  When the 5,000-file cap is reached, the result sets `truncated: true` with
  `scan_limit: 5000` and a `scan_warning` stating that unmatched results may
  be incomplete; a capped scan is never reported as complete without that
  warning, including in the human-readable summary text.
- A diagram with no supported entity declarations reports no checkable
  entities found; that is not a successful full match.
- Structured output carries the evidence behind the verdict:
  `entities`/`matched_entities`/`unmatched_entities`, per-entity `evidence`
  with matched files (POSIX paths relative to the searched directory,
  capped), the scanned `analyzers` extensions per tier
  (reliable vs experimental/generic heuristic), scan observability
  (`truncated`, `scan_limit`, `files_scanned`, `scan_warning`), and an
  explicit `confidence: "heuristic"` warning. Matched files are paths only —
  no source contents are included.

## Local-first behavior

- No telemetry, accounts, hosted storage, or remote project access.
- Configuration resolves once at startup (`PROJECT_ROOT`, `DIAGRAMS_DIR`,
  `PLANTUML_SERVER_URL`, `ALLOW_REMOTE_PLANTUML`, `DISABLE_REMOTE_PLANTUML`).
- All filesystem writes stay inside the configured diagrams directory. Path
  traversal outside the root is rejected, as are symlinked diagram paths that
  resolve outside it (see Security notes).
- Diagram source and scanned code are treated as sensitive local data: error
  messages do not include file contents, environment values, or credentials.

## Security notes

- `resolveSafe()` confines every read/write/delete to the diagrams root.
- Symlink escapes are rejected by policy: if the target or any ancestor path
  inside the root is a symlink, the operation fails with
  `PathTraversalError` before any file is read, modified, or deleted.
  Symlinked entries are also skipped during `list()`.
- `diagrams_check_consistency` only reads the codebase; it never modifies
  code or diagrams.
- Rendering temp files live in the OS temp directory and are removed after
  completion; child-process renderers run with timeouts and bounded
  stdout/stderr capture (`MAX_RENDER_OUTPUT_CHARS`, 1,000,000 characters
  per stream, enforced while collecting). A renderer that exceeds the cap
  is stopped and rendering fails with an actionable `RenderError` that
  never includes the captured output. A renderer that exceeds its timeout
  budget is stopped the same way — output pipes closed, process killed —
  and rendering fails with an explicit timeout `RenderError` naming only
  the timeout budget. The timeout error is delivered immediately rather
  than waiting for a descendant process that inherited the renderer's
  output pipes (the Windows `cmd.exe` shim chain makes this the common
  case) to release them.

## What V1 does not claim to support

- A web dashboard or hosted service.
- Automatic code generation from diagrams, or full two-way synchronization.
- A full parser for every supported language (reliable support means
  representative fixtures and predictable matching, not complete parsing).
- Sequence-diagram checks against actual call graphs.
- Pull request comments or hosted GitHub integration.
- Automatic rewriting of diagrams from heuristic findings.
- Authentication, accounts, or remote project storage.

## Verification status

Results below are from the final verification session — rerun `npm run build`
and `npm test` to re-verify. The official test command is `npm test`
(`node --test` over the explicit list of compiled `dist/**/*.test.js` files
declared in package.json — no shell globbing, so it behaves identically on
Windows and Linux, works on every supported Node version, and never executes
`dist/index.js`); adding a test file means adding it to that list. Running
`node --test src/**/*.test.ts` is unsupported because the source tests use
compiled `.js` ESM specifiers that only resolve in `dist/` after `tsc`.

- `npm ci` from removed `node_modules/` and `dist/`: passed,
  0 vulnerabilities.
- `npm run build` (`tsc`) from the clean install: exit 0.
- `npm test` on the compiled suites: 143 tests across 30 suites:
  140 passed, 0 failed, 3 skipped, 0 cancelled — 4 `DiagramStore`
  symlink-safety tests (read/write/delete rejection plus an in-root
  round-trip guard), 3 `diagrams_delete` tool tests, 3 constants tests
  (2 `toPosixPath` POSIX conversion cases plus the `CHARACTER_LIMIT`
  removal guard), 4 tool-output tests (3 POSIX relative-path cases plus
  full content without truncation), 34 renderer tests (11 PlantUML remote
  opt-in cases including default-blocked, explicit allow, `DISABLE`
  precedence, and malformed allow values; 3 local-only Mermaid cases;
  7 Windows npm-shim resolution tests; 1 `diagrams_render` MCP
  error-behavior test; 12 bounded-output cases covering normal
  stdout/stderr diagnostics, at-cap acceptance, stdout/stderr overflow,
  explicit timeout error wording, bounded timeout delivery when a
  descendant process holds the renderer's output pipes (including through
  the killed `cmd.exe` shim wrapper on Windows), stopping the renderer
  process itself on timeout, temp-directory cleanup after a timeout and
  after a non-zero exit, non-zero exit, and the centralized cap
  constant),
  30 consistency-checker tests (8
  entity-extraction cases including the bundled diagrams, 12
  reliable-language matching cases, 5 experimental-language smoke cases,
  3 structured-evidence cases covering extracted/matched/unmatched
  entities, analyzer tiers, and bounded matched files, plus 2
  scan-limit observability cases covering the `truncated`/`scan_limit`/
  `scan_warning` contract), 16 pagination/window/validation tool tests
  (7 `diagrams_create`/`diagrams_update` syntax-validation cases, 4
  `diagrams_list` pagination cases, 5 `diagrams_get` source-window
  cases), 14 diagram-validator tests (6 PlantUML basic checks, 8 Mermaid
  basic checks including the no-source-leak case), 22 normalized
  error-handling tests (2 `isProgrammingError`, 2 `isExpectedToolError`,
  2 `isExpectedRenderError`, 4 `handleToolError`, 2 `handleRenderError`,
  3 typed-domain-error preservation cases, 7 unexpected-failure mapping
  cases across create/update/delete/get/list/render/check-consistency),
  and 13 MCP stdio integration tests covering all 7 tools plus CRUD,
  explicit pagination, source windows, error cases, consistency, and
  delete flows.
- Symlink tests: on machines where symlink creation is available they run
  for real; on this verification machine (Windows without symlink support)
  the 3 symlink-escape rejection tests skipped with explicit reasons and
  the in-root read/write round-trip guard ran.
- Live timeout verification against the compiled renderer: a hung renderer
  rejects at its budget with `Renderer timed out after <budget>ms and was
  stopped.` — never `Command exited with code null`. Through the Windows
  shim shape (`cmd.exe /d /s /c <renderer>`), killing the wrapper at the
  timeout while its grandchild still held the inherited output pipes
  delivered the same timeout error at the budget (~0.3s probe; the
  pre-fix code waited for the descendant to release the pipes — a 45s
  delay was observed in release verification — and then reported
  `Command exited with code null`). Timeout messages carry only the
  budget: probed with planted secret, path, and environment markers and
  none leaked. A live `diagrams_render` through the real `mmdc.cmd` shim
  chain still rendered successfully (SVG produced in ~1.7s), confirming
  the timeout redesign causes no false timeouts on real renders.
- Live MCP smoke test over stdio against a temporary fixture (OS temp
  `PROJECT_ROOT`, `DIAGRAMS_DIR=diagrams`, `DISABLE_REMOTE_PLANTUML=true`,
  real SDK `Client` + `StdioClientTransport`, no network use): all checks
  passed (7/7). All 7 tools were discoverable; `diagrams_create`,
  `diagrams_list`, `diagrams_get`, `diagrams_update`,
  `diagrams_check_consistency` (2 entities found, 2 matched against a
  `Driver`/`Car` fixture), `diagrams_render`, and `diagrams_delete` all
  behaved as documented.
- Live Mermaid rendering verified with the local `mmdc` 11.17.0 CLI:
  `diagrams_render` returned `rendered: true` with one `image/svg+xml`
  block for a user-provided Mermaid class diagram. The materialized output
  file existed and was verified before cleanup (19,297 bytes, `.svg`
  extension, `<svg` document head). The temporary diagram was deleted, the
  original Downloads file was verified unchanged by SHA256, no network
  request occurred, and no server process remained (node PID set identical
  before and after).
- Note: user-facing relative paths (`relative_path`, `diagram_path`, and
  `diagrams_list` entries) always use POSIX `/` separators
  (e.g. `smoke/widget.puml`), even on Windows. Filesystem access still uses
  native paths internally.
- Windows renderer behavior: bare CLI names resolve first, then
  `.cmd`/`.exe`/`.bat` shims executed via the command interpreter (no
  `shell: true`, command names remain hardcoded literals); a
  detected-but-unlaunchable CLI returns an actionable `RenderError`
  instead of a raw spawn error.
- Bundled evaluation (`evaluations/eval.xml`, `PROJECT_ROOT=./examples`):
  documented answers match the implementation (2 diagrams, `User Domain
  Model` title, 2 entities with User matched and Order unmatched).

Lint and formatting are covered separately and both pass: `npm run lint`
(ESLint over `src/`, zero warnings allowed) and `npm run format:check`
(Prettier over `src/`). They run in CI (`.github/workflows/ci.yml`,
Node 20.x/22.x matrix) before the build; the development toolchain
requires Node >=20.19 while the server runtime still supports Node >=18.

Not covered by this session: live PlantUML rendering — no local `plantuml` CLI
was asserted, so the PlantUML remote-fallback path was exercised with
stubs only and `plantuml` output was not live-rendered.

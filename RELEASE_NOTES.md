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

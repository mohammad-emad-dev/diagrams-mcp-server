# Contributing to diagrams-mcp-server

This is a personal project kept up by one maintainer, currently a Technical Preview (v0.9.0). Outside contributions are welcome, but the scope stays small on purpose: everything should serve the drift-detection loop of listing diagrams, reading source, checking consistency, reporting evidence, and updating only when asked. If an idea does not fit that loop, open an issue first before writing code.

## Requirements

Two Node versions matter here, and they are different.

- Running the server takes Node 18 or newer (`engines: >=18` in `package.json`). The compiled `dist/` output, `npm test`, and `npm start` all work on Node 18.
- Developing takes Node 20.19 or newer. `npm ci`, `npm run lint`, `npm run format:check`, and `npm run build` need the newer toolchain because ESLint 10 does not run on older Node.

CI builds and tests on Node 20.x and 22.x (see `.github/workflows/ci.yml`).

## Local setup

```bash
git clone https://github.com/mohammad-emad-dev/diagrams-mcp-server.git
cd diagrams-mcp-server
npm ci        # reproducible install from package-lock.json; prefer this over npm install
npm run build # cleans dist/ and compiles src/ with tsc
npm start     # runs node dist/index.js over stdio
```

Two environment variables control what the server sees:

- `PROJECT_ROOT` — the project under analysis (defaults to the current directory)
- `DIAGRAMS_DIR` — diagram files, relative to `PROJECT_ROOT` unless absolute (defaults to `diagrams`)

`examples/` is the reference fixture project: `examples/src/user.ts` plus two diagrams under `examples/diagrams/models/`. Point the server at it to try the full loop locally.

## Checks to run before a pull request

The [current roadmap](docs/roadmap.md) separates completed work from optional
extensions. Release candidates also follow the
[packaged acceptance checklist](docs/release-checklist.md) with real renderers.

Run all four, in this order:

```bash
npm run lint          # ESLint over src/ and scripts/, zero warnings allowed
npm run format:check  # Prettier check over src/ and scripts/
npm run build         # clean dist/ and run tsc, must exit 0
npm test              # discover compiled *.test.js under dist/ and run node --test
```

Lint covers `src/` and `scripts/`. The format check enforces the Prettier style (100 columns, double quotes, semicolons). `scripts/build.mjs` removes the project's `dist/` before type-checking and compiling, so deleted or moved source files leave no stale output. `scripts/test.mjs` discovers compiled `*.test.js` recursively and runs them with `node --test`; new colocated tests need no package-script edits. Always build before testing. CI runs the same four steps.

## Adding a language fixture

Consistency checking scans code with per-extension analyzers in `src/services/consistencyChecker/` — declaration patterns and tiers live in `codeAnalysis.ts`, diagram-side extraction in `entities.ts`. Three tiers exist (`AnalyzerTier` in `src/types.ts`):

- `reliable` — JavaScript/TypeScript (`.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts`), Python, PHP, Java. These have per-language declaration patterns.
- `experimental` — C#, Go, Ruby, Kotlin, Rust. Generic whole-word heuristic, covered by smoke tests.
- `generic` — every other scanned extension, whole-word matching only.

To touch language support:

1. Add or extend the declaration patterns in `FAMILY_PATTERNS` in `codeAnalysis.ts`, and move the extension between `RELIABLE_ANALYZER_EXTENSIONS` and `EXPERIMENTAL_ANALYZER_EXTENSIONS` if the tier changes.
2. Add fixture tests in `src/services/consistencyChecker.test.ts`. Fixtures are inline: the `writeFiles` helper writes source files into a fresh tmp dir, then `checkConsistency` runs against an inline diagram string. Cover the declaration forms being claimed, plus a missing entity, a name that only appears in a comment or string literal, and a file under an ignored directory (`node_modules/`, `dist/`, and the rest of `DEFAULT_IGNORED_DIRS`).
3. Document what the analyzer recognizes and what stays heuristic in the module comments at the top of `codeAnalysis.ts` and `entities.ts`.

The bar for calling a language reliable is representative fixtures, documented limitations, predictable matching, and tests for every declaration form claimed. An experimental language must never be presented as reliable, and its results keep the heuristic warning in the structured output. Promoting a language from experimental to reliable needs fixtures and passing tests first.

## Adding or modifying an MCP tool

The fifteen tools (`diagrams_list`, `diagrams_get`, `diagrams_create`, `diagrams_update`, `diagrams_delete`, `diagrams_render`, `diagrams_export`, `diagrams_save_export`, `diagrams_check_consistency`, `diagrams_generate`, `diagrams_generate_sequence`, `diagrams_diff`, `diagrams_template`, `diagrams_list_templates`, `diagrams_scaffold`) each live in their own file under `src/tools/`, as a `registerDiagramsX(server, ctx)` function. `src/server.ts` wires them up via `createDiagramServer` (see `docs/architecture.md` for the current CLI → composition → tools → services boundaries), and `src/context.ts` builds the shared `ServerContext` once at startup. Most adapters take `(server, ctx)`. `registerDiagramsTemplate(server, ctx?)` accepts optional context because built-in templates are pure while custom templates read the project root; `createDiagramServer` passes `ctx` to it. A tool that renders but must stay unit-testable without a CLI — `diagrams_export`, which builds on `renderDiagramWithProvenance` — reads its optional `ctx.rendererDeps` seam, left unset in production so the real CLIs and fetch are used.

For a new or changed tool:

1. Put the adapter in `src/tools/` and the logic in `src/services/`. Parser and filesystem logic does not belong in the registration file.
2. Validate input with a strict Zod schema (`.strict()`), with a `z.infer` type for the handler. Keep filesystem writes inside the configured diagrams directory and reuse the store's path guards.
3. Return both `content` (text) and `structuredContent`, and keep them consistent: the text block must equal the main content field. Failures come back as `Error: ...` text with `isError: true`. Never surface a raw stack trace.
4. Write the tool description as the contract MCP clients rely on: when to use the tool, when not to, the args, the return shape, and every error string.
5. Add unit tests next to the source (`*.test.ts` files compile to `dist/` and are discovered automatically by `npm test`). If the tool changes the server surface, add an integration case in `src/integration/mcpServer.test.ts` too (including `EXPECTED_TOOLS`).

## Security and privacy

This project is local-first: no telemetry, no accounts, no hosted storage. Diagram source and scanned code are sensitive local data.

- Never log or return full source files, secrets, tokens, or environment values. Error messages stay actionable without exposing internals.
- Validate every input with Zod before touching the filesystem or a child process. Renderer command names are hardcoded literals. The remote PlantUML fallback stays opt-in (`ALLOW_REMOTE_PLANTUML=true`), and `DISABLE_REMOTE_PLANTUML=true` always wins.
- Keep all writes inside the diagrams root. Anything near those boundaries gets tested for path traversal (`../..`), missing files, unsupported extensions, and missing renderer CLIs.

## Pull request checklist

- [ ] `npm run lint`, `npm run format:check`, `npm run build`, and `npm test` all pass from a clean `npm ci`
- [ ] New behavior has tests; changed tools have updated descriptions and output contracts
- [ ] Language changes include fixtures and documented limitations; no experimental language is presented as reliable
- [ ] No secrets, tokens, full source dumps, or local paths in code, logs, tests, or error messages
- [ ] The diff touches only what the change needs: no unrelated files, generated output, or config drift
- [ ] The README or RELEASE_NOTES.md is updated if behavior or support claims changed

Small, focused pull requests get reviewed fastest. One change per request, with the verification output pasted in.

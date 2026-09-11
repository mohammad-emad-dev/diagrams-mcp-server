# Contributing to diagrams-mcp-server

This is a personal project kept up by one maintainer, currently a Technical Preview (v0.5.2). Outside contributions are welcome, but the scope stays small on purpose: everything should serve the drift-detection loop of listing diagrams, reading source, checking consistency, reporting evidence, and updating only when asked. If an idea does not fit that loop, open an issue first before writing code.

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
npm run build # compiles src/ to dist/ with tsc
npm start     # runs node dist/index.js over stdio
```

Two environment variables control what the server sees:

- `PROJECT_ROOT` — the project under analysis (defaults to the current directory)
- `DIAGRAMS_DIR` — diagram files, relative to `PROJECT_ROOT` unless absolute (defaults to `diagrams`)

`examples/` is the reference fixture project: `examples/src/user.ts` plus two diagrams under `examples/diagrams/models/`. Point the server at it to try the full loop locally.

## Checks to run before a pull request

Run all four, in this order:

```bash
npm run lint          # ESLint over src/, zero warnings allowed
npm run format:check  # Prettier check over src/
npm run build         # tsc, must exit 0
npm test              # node --test over the compiled test files listed in package.json (build first: tests run from dist/; add new test files to that list)
```

Lint applies the TypeScript recommended rules to everything under `src/`. The format check enforces the Prettier style (100 columns, double quotes, semicolons). The build type-checks and emits `dist/`, and the tests run against that compiled output, so a stale `dist/` gives stale results — always rebuild before testing. CI runs the same four steps.

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

The seven tools (`diagrams_list`, `diagrams_get`, `diagrams_create`, `diagrams_update`, `diagrams_delete`, `diagrams_render`, `diagrams_check_consistency`) each live in their own file under `src/tools/`, as a `registerDiagramsX(server, ctx)` function. `src/index.ts` wires them up, and `src/context.ts` builds the shared `ServerContext` once at startup.

For a new or changed tool:

1. Put the adapter in `src/tools/` and the logic in `src/services/`. Parser and filesystem logic does not belong in the registration file.
2. Validate input with a strict Zod schema (`.strict()`), with a `z.infer` type for the handler. Keep filesystem writes inside the configured diagrams directory and reuse the store's path guards.
3. Return both `content` (text) and `structuredContent`, and keep them consistent: the text block must equal the main content field. Failures come back as `Error: ...` text with `isError: true`. Never surface a raw stack trace.
4. Write the tool description as the contract MCP clients rely on: when to use the tool, when not to, the args, the return shape, and every error string.
5. Add unit tests next to the source (`*.test.ts` files compile to `dist/` and run under `node --test`). If the tool changes the server surface, add an integration case in `src/integration/mcpServer.test.ts` too.

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

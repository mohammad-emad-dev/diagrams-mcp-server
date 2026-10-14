# diagrams-mcp-server

> **Technical Preview (V1 Preview, v0.8.0 â€” unreleased)** â€” local-first MCP server for
> PlantUML and Mermaid diagrams: manage, render, and share them, check them
> against your codebase, and draft new ones from your code.

[![CI](https://github.com/mohammad-emad-dev/diagrams-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mohammad-emad-dev/diagrams-mcp-server/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)](https://modelcontextprotocol.io/)
[![PlantUML](https://img.shields.io/badge/PlantUML-supported-2f855a)](https://plantuml.com/)
[![Mermaid](https://img.shields.io/badge/Mermaid-supported-ff3670)](https://mermaid.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An MCP (Model Context Protocol) server that gives AI coding agents structured access to your project's **PlantUML** and **Mermaid** architecture diagrams. It can list, read, create, update, and delete diagrams, render and export them, check them against the codebase, diff two versions, and draft new diagrams from code or from starter skeletons â€” all locally, with no accounts and no network calls unless you explicitly opt in.

Works with **any MCP-compatible client** over stdio: Claude Code, Codex (Desktop & CLI), Antigravity (IDE, 2.0 & CLI), OpenCode (Desktop & CLI), Cursor, and VS Code. See [Client setup](#client-setup) below.

## Why this exists

I built this after running into the same problem while using AI to work on software design. The diagram was in one place, the code was in another, and I kept having to paste context into the conversation. After a few rounds, it became hard to tell whether the diagram still described the project. I wanted a small local MCP server that could keep the diagram in the project, let the agent read it, and check it against the code when needed.

`diagrams-mcp-server` keeps diagrams in the project next to the code so an agent can read and check them in the same workflow. It uses the standard stdio MCP transport and does not require client-specific server code.

## Features

Thirteen tools in four groups. UNRELEASED items below target the upcoming 0.8.0 release. The read-only drafting tools (`diagrams_generate`, `diagrams_generate_sequence`, `diagrams_template`, `diagrams_export`) never write: they return source text and you save it yourself with `diagrams_create`.

### Manage diagrams

| Tool | What it does |
|---|---|
| `diagrams_list` | List all PlantUML/Mermaid diagrams in the project, with extracted titles and explicit `offset`/`limit` pagination |
| `diagrams_get` | Read the raw source of a diagram, in full or as an explicit `offset`/`max_chars` window |
| `diagrams_create` | Create a new diagram file (refuses to overwrite) |
| `diagrams_update` | Replace an existing diagram's content |
| `diagrams_delete` | Delete a diagram (explicit, marked `destructiveHint`) |

### Render and share

| Tool | What it does |
|---|---|
| `diagrams_render` | Render a diagram to SVG/PNG |
| `diagrams_export` | **Package a stored diagram and its rendered SVG into one self-contained HTML file (SVG as base64 image)** â€” fully offline, no external resources, nothing written to disk |

### Check and compare

| Tool | What it does |
|---|---|
| `diagrams_check_consistency` | **Compare class/interface/component names in a diagram against your actual codebase** and flag anything that looks outdated |
| `diagrams_diff` | **Compare two diagram sources â€” two stored files, or a stored file against inline text â€” and report added, removed, and renamed entity names** |

### Draft new diagrams

| Tool | What it does |
|---|---|
| `diagrams_list_templates` | **UNRELEASED: discover built-in kinds and project-local custom-template candidates** without reading template contents or writing files |
| `diagrams_generate` | **Draft a PlantUML or Mermaid class diagram from a slice of your codebase**, returning source text to review and then save with `diagrams_create` |
| `diagrams_generate_sequence` | **Draft a PlantUML or Mermaid sequence diagram from the message-call patterns in a slice of your codebase**, returning source text to review and then save with `diagrams_create` |
| `diagrams_template`          | **Instantiate a minimal, always-valid starter skeleton (class, sequence, C4-context, or project-local custom) in PlantUML or Mermaid** â€” one declaration per entity, nothing inferred, nothing written |

### Tool notes

#### Argument validation (UNRELEASED)

All 13 tools reject unknown argument keys over MCP instead of silently ignoring them. For example, `include_sorce` is rejected; the export option is `include_source`. This change targets unreleased v0.8.0. Existing fields, defaults, refinements, and response shapes are unchanged. The SDK dependency now requires `^1.30.0`, matching the already-installed and locked version verified with full-schema registration.

#### Call-name extraction (UNRELEASED)

UNRELEASED parser correction: valid one-character operation names such as `f()` and `_()` are recognized by consistency checks, name-based diffs, and optional call-order comparison. They count toward the 10,000-call limit like longer names. Plain labels remain ignored; recognized call names still use the existing ASCII identifier grammar. This correction targets unreleased v0.8.0.

UNRELEASED message-call extraction also skips whole-line apostrophe and `%%` comments, plus PlantUML `/' ... '/` blocks beginning at the first non-whitespace character of a line. Calls inside these comments do not affect consistency call names, name-based diffs, or the optional call-order limit. Parsing resumes after a block closes; an unclosed block hides the rest of the source. Inline blocks after diagram content, nested blocks, and note text are not parsed specially. This applies to call names only; declaration and participant extraction remain heuristic. See [PlantUML comments](https://plantuml.com/commons) and [Mermaid sequence comments](https://mermaid.js.org/syntax/sequenceDiagram#comments).

#### `diagrams_list_templates` (UNRELEASED)

Call with `{}` to discover the three built-in kinds and custom-template candidate names under `<PROJECT_ROOT>/.diagrams-templates`. Each custom result includes `custom_template` and a relative POSIX `relative_path`; use the identifier with `diagrams_template`, which validates the definition, selected dialect, and emitted source. Discovery reads directory entries only, so malformed JSON files can appear as candidates.

The tool writes nothing and does not create a missing template directory. It examines at most 1,000 entries (`MAX_TEMPLATE_SCAN_ENTRIES`), counting non-template entries too, plus one lookahead to detect a cap. A capped scan returns `truncated: true` and `scan_warning`; `custom_count` describes the returned candidates, not a full directory total. Returned names are sorted, but a capped subset depends on filesystem iteration order. Subdirectories, symlink files/directories, invalid identifiers, and extensions other than `.json` are excluded or rejected.

#### `diagrams_check_consistency` It reads entity names from `class`/`interface`/`enum`/`component` declarations, aliases, namespaces, packages, sequence participants, message calls such as `charge(card)`, C4 blocks, and subgraph groupings. It then searches source files for matching identifiers, using declaration patterns for JavaScript/TypeScript, Python, PHP, and Java, and whole-word matching elsewhere. It helps detect common drift, such as a renamed or removed class or a component that has not been implemented. Structured output includes extracted, matched, and unmatched entities, per-entity file evidence, analyzer tiers, and an explicit heuristic confidence warning. The scan limits are listed under [Consistency scan limits](#consistency-scan-limits).

#### `diagrams_generate`

`diagrams_generate` is the generative flip side of that check: it reads the same declarations from a file or directory under your project root and drafts a class diagram from them â€” one box per declared name, plus `extends`/`implements` edges when the TypeScript compiler can evidence them. It is read-only and **never writes**: the source text comes back in the response, and nothing lands in `diagrams/` until you save it with an explicit `diagrams_create` call. It is a heuristic (name extraction, not full type modeling): member lists, generics, namespace nesting, and cross-file inheritance through re-exports are out of scope, and a scope without TypeScript-family files yields entities with no relations and a `dialect_note` saying why. Every result is labeled `confidence: "heuristic"` with a `heuristic_warning`, and every cap reports itself in-band (`entities_capped` / `entities_available` / `relations_capped` / `truncated`), so a capped draft is never mistaken for a complete one. The generation limits are listed under [Generation limits](#generation-limits).

#### `diagrams_generate_sequence`

`diagrams_generate_sequence` drafts the other half of the picture: not the boxes, but the **conversation** between them. It reads the message-call patterns in a file or directory under your project root â€” participants named by module, merging files that share a basename â€” and emits ordered `from -> to : message` lines from the caller-to-callee edges the consistency checker's call graph already extracts. **Static call-site order is not runtime order**, and every result says so: a call inside a callback, promise, or listener is counted in `deferred_count` and excluded from the messages, because its real position in the conversation is unknowable from source. Participant mapping uses case-insensitive declared-identifier matching (the first declaring participant wins) â€” a callee that no file in the scope declares is listed in `unresolved_callees` rather than attached to an invented participant, because which class owns a method is a type question and out of scope. Like `diagrams_generate` it is read-only and **never writes** â€” nothing lands in `diagrams/` until you save it with an explicit `diagrams_create` call â€” and every result is labeled `confidence: "heuristic"` with a `heuristic_warning`, with every cap reporting itself in-band (`participants_capped` / `messages_capped` / `*_available` / `*_limit` / `truncated`). The sequence limits are listed under [Sequence limits](#sequence-limits).

UNRELEASED (for upcoming 0.8.0): TypeScript files additionally use AST-backed extraction from `src/services/consistencyChecker/ts/tsCalls.ts` via optional `includeCalls` in `tsIndex.ts` â€” named functions, variable-bound arrows/functions, methods/accessors, object-literal identifier/quoted static bare-identifier properties holding arrow/function expressions, and quoted static class property initializers as operations; `f()`, `obj.m()` and `obj["m"]()` callees; enclosing-caller reset after each function; multiline callback arguments deferred, including calls inside callback object properties (`register({handler:()=>charge()})` never emits `charge`). Missing compiler, non-TS files, or parse failure keep the heuristic fallback. Mapping stays file-level first-owner name matching, with no semantic type resolution and no runtime ordering.

UNRELEASED sequence-generation option (for upcoming v0.8.0): set `include_call_parentheses: true` on `diagrams_generate_sequence` to emit labels such as `charge()` in either format. This lets the existing heuristic call-name extractor recognize generated operations in consistency checks and optional call-order diffs. The default is `false`, preserving plain labels and existing output. Structured `messages[].message` values remain bare operation names. Empty parentheses mark a call; they do not reproduce its arguments or signature. Call extraction still follows the ASCII name grammar described above.

#### `diagrams_diff`

`diagrams_diff` answers the review-time question that follows an edit: **what changed between two versions of the same diagram?** Each side supplies exactly one of a stored path or inline text, so unstaged edits can be compared without a round trip, and the two sides may even use different dialects â€” each is read with its own syntax. It reports `added` / `removed` / `renamed` entity names, the `unchanged` list, and the sequence-side `participants_*` / `calls_*` fields (`[]`, never absent, for class diagrams). Rename detection pairs a removed name with an added one only when the two are identical once lowercased and stripped of separators â€” the same shared normalizer the consistency checker uses to match names against code â€” so a genuine rename with a different spelling stays a plain add plus a remove, and every pair carries `confidence: "heuristic"`. It compares declared names only: member lists, layout, and style are out of scope, and it never patches or merges â€” it reports, and you edit. Like the other read-only tools it touches nothing on disk; a malformed request is rejected before any file is read.

UNRELEASED `diagrams_diff` option: set `compare_call_order: true` to compare recognized message-call names in source order, preserving repeated calls. The response adds `call_order: { a, b, changed }`; `is_same` also accounts for this comparison. Each side is limited to 10,000 recognized calls (`MAX_DIFF_ORDER_CALLS`), and an over-limit comparison returns an error rather than partial arrays. It reuses the existing heuristic call grammar (for example, `charge()`); plain labels such as `charge`, endpoints, arguments, control flow, and runtime order are outside this comparison. Omit the option for the existing name-based diff. This targets unreleased v0.8.0.

#### `diagrams_template`

`diagrams_template` is the blank-page tool that precedes all of them: **give it a kind, a dialect, and the entity names, and it hands back a minimal skeleton that already clears every syntax gate.** The three built-in kinds (class, sequence, C4-context Ã— PlantUML, Mermaid) are fixed tables in `src/services/templates/skeletons.ts` â€” pure, no filesystem, no code scan, identical inputs yield byte-identical source. Unlike `diagrams_generate` there is no `confidence` field: one declaration per entity plus a TODO hint, nothing more. The PlantUML C4-context skeleton stays self-contained with plain rectangles (no C4-PlantUML stdlib fetch); Mermaid uses native `C4Context`. Nothing is ever written: the source comes back in the response until you save it with `diagrams_create`. The template limits are listed under [Template limits](#template-limits).

UNRELEASED (for upcoming 0.8.0): `template="custom"` with `custom_template="<id>"` loads `<PROJECT_ROOT>/.diagrams-templates/<id>.json` (no env override). `custom_template` is 1â€“64 chars matching `/^[A-Za-z0-9_-]+$/`. The JSON may define optional `puml`/`mermaid` objects; the selected object must contain `source` and `entity` strings, and unknown fields are rejected. `source` supports `{{title}}`/`{{entities}}`, `entity` supports `{{name}}`, substituted once with no recursive expansion or eval. Reads are capped at 65,536 bytes and expansion at 1,000,000 UTF-16 chars; entity validation (1â€“20 names, identifier, 60 chars, no duplicates) is unchanged. Files must be regular files; symlinks are rejected. The loader is read-only, and `registerDiagramsTemplate(server, ctx)` takes an optional context (the factory passes `ctx`); custom results additionally return `custom_template`.

#### `diagrams_export`

`diagrams_export` is the sharing tool that closes the loop: **package a stored diagram and its rendered SVG into one self-contained HTML file** that opens anywhere, inside or outside the repo. It is packaging of two artifacts the server already produces â€” the stored source and the locally rendered SVG â€” so it adds no dependency (the HTML is string concatenation) and no new write surface: the tool never writes a file, the HTML comes back as text, and you decide where it lands. UNRELEASED (for upcoming 0.8.0): the SVG is embedded as a base64 data image (`<img src="data:image/svg+xml;base64,...">`), not live inline SVG â€” scripts and external resources are disabled by SVG-image processing, so SVG text is no longer selectable. The wrapper CSP is `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. Isolation in the image is the security boundary; encoded renderer markup is not claimed sanitized or removed. See [SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image) for the restrictions. The diagram's POSIX `relative_path` is the only path in the document. With `include_source` (the default), the source is escaped into a collapsible native `<details>` block needing no JavaScript; `false` omits it. Rendering follows `diagrams_render` exactly, including CLI requirements and opt-in remote fallback, and `rendered_with` reports the path (`local-plantuml` / `remote-plantuml` / `mmdc`). A bundle larger than the byte cap is refused outright â€” `truncated` is always `false`. The whole encoded HTML (larger than the raw SVG) is what the 5,000,000-byte cap measures; `svg_chars` measures the decoded SVG source after preamble strip, not the base64 length. Browser probe outside the repo: Chrome showed a hostile SVG as a 120Ã—40 image with no HTTP requests or active DOM, while the standalone-SVG control ran its script. The export limits are listed under [Export limits](#export-limits).

## Pagination and source windows

Pagination is explicit and opt-in â€” the server never pages or truncates on its own.

`diagrams_list` accepts optional `offset` (non-negative integer, default `0`) and `limit` (integer `1`â€“`500`). Omitting both returns every match. The response always includes `count` (items in this page), `total` (matches before paging), the effective `offset`/`limit`, and `has_more` (whether items after this page remain). An `offset` past the end returns an empty page with `has_more: false`, not an error. Example: first `diagrams_list({ "type_filter": "all", "limit": 10 })`, then `diagrams_list({ "type_filter": "all", "offset": 10, "limit": 10 })` while `has_more` is true.

`diagrams_get` accepts optional `offset` (zero-based character offset, default `0`) and `max_chars` (integer `1`â€“`100000`). Omitting both returns the full source. The response always includes `is_partial`, the effective `offset`, `total_chars`, `returned_chars`, and `has_more`; the text block always equals the returned `content`, so a window is never silently truncated. An `offset` past the end of the source returns an `isError` result instead of an empty string. Example: `diagrams_get({ "relative_path": "models/big.puml", "offset": 0, "max_chars": 2000 })`, then repeat with `offset: 2000`.

## Requirements

- Node.js 18+ for running the server (runtime `engines: >=18` â€” the compiled `dist/` output, `npm test`, and `npm start` work on Node 18)
- Node.js >=20.19 for the development toolchain (`npm ci`, `npm run lint`, `npm run format:check`, `npm run build`) â€” the ESLint 10 toolchain does not run on older Node versions
- (Optional, for `diagrams_render`) [`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli) for Mermaid rendering: `npm install -g @mermaid-js/mermaid-cli`
- (Optional, for `diagrams_render`) A local `plantuml` CLI for offline PlantUML rendering. Without it, rendering fails with an actionable error unless remote rendering is explicitly enabled with `ALLOW_REMOTE_PLANTUML=true`, in which case it falls back to the public `plantuml.com` server over HTTPS. `DISABLE_REMOTE_PLANTUML=true` always disables the fallback, even when the allow flag is set.

## Installation

You need **Node.js 18+** â€” that is the only requirement. No accounts, no
API keys, no separate services.

### 1. Get the package (pick one way)

#### Option A â€” no install (fastest way to try it)

```bash
npx diagrams-mcp-server --help
```

`npx` fetches the package on first use and caches it. Nothing is
installed permanently, so this is the simplest way to try the server. The
trade-off: the first run needs internet access, and MCP clients start the
server fresh on every session â€” for daily use, prefer Option B.

#### Option B â€” global install (recommended for daily use)

```bash
npm install -g diagrams-mcp-server
diagrams-mcp-server --help   # prints the help text and exits 0
```

This puts a `diagrams-mcp-server` command on your PATH so any MCP client
can launch it. To update later, just rerun the same command.

#### Option C â€” project dependency (pin a version per project)

```bash
cd /path/to/your/project
npm install diagrams-mcp-server
npx diagrams-mcp-server --help
```

Use this when different projects should use different server versions.

### 2. Connect it to your client

Installing the package alone is not enough: your MCP client also needs a
`diagrams` entry telling it how to launch the server. The one-command
setup writes that entry for you â€” no hand-editing JSON:

```bash
npx diagrams-mcp-server setup            # interactive: pick client, then scope
npx diagrams-mcp-server setup --client codex --yes   # non-interactive
npx diagrams-mcp-server setup --client cursor --scope project --yes   # pin this project
```

Setup asks for the client first, then the scope (each skippable with a flag):

- **Global (Recommended):** writes a clean entry with no `PROJECT_ROOT`
  â€” the server attaches to whatever directory the client launches it
  from. Best when you work across many projects.
- **Project-specific:** asks for the project root and bakes it in
  (`"env": { "PROJECT_ROOT": "..." }` for file-based clients,
  `--env PROJECT_ROOT=...` for `claude`/`codex mcp add`). Best when one
  config should always point at one project.

For file-based clients (Cursor, VS Code, Antigravity)
this merges the entry into the client's config file. For Claude Code and
Codex it runs their `mcp add` command; if that CLI is not installed,
setup prints the exact command to run yourself. For OpenCode it prints
the command to run. Restart file-based clients afterwards so they pick
it up.

Setup opens with a version banner and runs pre-flight checks
automatically: it warns when the `claude` or `codex` CLI is missing
(printing the manual command instead), validates a project-scoped path
(offering to create it), and ends with a summary of the client, scope,
touched config, and status.
Interactive prompts use arrow-key pickers (`â†‘â†“` + `Enter`, `Esc`
cancels) and `Yes`/`No` toggles; manual commands appear in boxed
cards, and status output is color-highlighted (plain text when piped
or when `NO_COLOR` is set). Every prompt is skipped when the matching
flag is passed.

### 3. Verify it works

Restart your client, then ask your agent: "List my diagrams." It should
call `diagrams_list` â€” an empty list on a fresh project means everything
is wired up correctly.

### From source (contributors)

```bash
git clone https://github.com/mohammad-emad-dev/diagrams-mcp-server.git
cd diagrams-mcp-server
npm ci
npm run build
npm test
```

`npm test` runs the full suite from `dist/` â€” unit, golden, and live-stdio
integration tests that spawn the real server â€” so always build first. Before
opening a PR, run all four gates: `npm run build`, `npm test`, `npm run lint`,
`npm run format:check` (the last two need Node >=20.19).

### Where the files live

- Global install (`npm install -g diagrams-mcp-server`): the package lands in
  the global `node_modules` (run `npm root -g` to find yours â€” e.g.
  `C:\Users\<you>\AppData\Roaming\npm\node_modules` on Windows,
  `/usr/local/lib/node_modules` on macOS/Linux) with launch shims on your
  PATH, so `diagrams-mcp-server` runs from anywhere.
- Project dependency (`npm install diagrams-mcp-server` inside a project):
  the same payload under `<project>/node_modules/diagrams-mcp-server/`,
  with the binary linked at `<project>/node_modules/.bin/diagrams-mcp-server`.
- `npx diagrams-mcp-server`: uses the global install if present, else the
  local one, else downloads and caches it â€” no manual file handling needed.

All three run the same entry point (`dist/index.js`), so MCP clients can use
whichever path fits: the global shim, the project's `.bin` binary, or
`node <path>/dist/index.js` directly.

### Lint and formatting

```bash
npm run lint          # ESLint over src/ and scripts/ (zero warnings allowed)
npm run format:check  # Prettier check over src/ and scripts/
```

Both run in CI (`.github/workflows/ci.yml`, Node 20.x/22.x matrix) before the build. They cover
source and test files under `src/` and build utilities under `scripts/` â€” `dist/`, `node_modules/`,
`graphify-out/`, and packed tarballs are excluded via `eslint.config.mjs`
and `.prettierignore`. These two commands require the development toolchain
(Node >=20.19); the server runtime itself still supports Node >=18. `.gitattributes`
pins all text files to LF, so Windows and Linux checkouts produce identical
line endings and the format check gives the same result on every platform.

### Local tarball install without publishing

To install and run this Technical Preview from a local package file, create a
tarball and install it in a separate consumer project:

```bash
npm pack   # runs the prepack build and writes diagrams-mcp-server-0.8.0.tgz
cd /path/to/your/project
npm init -y                       # if the consumer project has no package.json yet
npm install /path/to/diagrams-mcp-server-0.8.0.tgz
npx diagrams-mcp-server --help    # resolves the local install, exits 0
```

This installs only the published payload (`dist/` runtime files, `README.md`,
`LICENSE`) â€” no tests, fixtures, or local configs â€” and
changes nothing outside the consumer project (no global packages and no
registry publish). The package file is local, but npm may still download the
package dependencies from the registry during installation. Point any stdio MCP client at the installed binary
(`node_modules/.bin/diagrams-mcp-server`) the same way as `dist/index.js`
in [Client setup](#client-setup).

## Uninstallation

Uninstalling has two independent parts: disconnecting the server from
your client, and removing the package. Do either or both.

### 1. Disconnect it from your client

Delete the `diagrams` entry from your client's configuration and restart
the client:

| Client | What to remove |
|---|---|
| Cursor | the `"diagrams"` block in `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| VS Code | the `"diagrams"` block in `.vscode/mcp.json` |
| Antigravity | the `"diagrams"` block in `~/.gemini/config/mcp_config.json` (or `.agents/mcp_config.json`) |
| Claude Code | run `claude mcp remove diagrams` |
| Codex | the `[mcp_servers.diagrams]` section in `~/.codex/config.toml` |
| OpenCode | the `"diagrams"` block in `opencode.jsonc` |

### 2. Remove the package

Match how you installed it:

```bash
npm uninstall -g diagrams-mcp-server   # global install (Option B)
npm uninstall diagrams-mcp-server      # project dependency (Option C, run inside the project)
```

If you only ever used `npx` (Option A), there is nothing to uninstall â€”
optionally clear the download cache with `npx clear-npx-cache`.

### What stays behind

Uninstalling never touches your diagram files: the `diagrams/` folder in
your project is your own work and is left exactly as it is. Delete it
manually only if you want the diagrams gone too.

## Client setup

`diagrams-mcp-server` speaks plain stdio MCP, so it works with any MCP-compatible client. Setup instructions for each below.

All examples assume you built the server at `/absolute/path/to/diagrams-mcp-server` and want it attached to a project at `/absolute/path/to/your/project`. Replace both paths with your own. If you installed from the registry, use the global install path or your project's `node_modules/.bin/diagrams-mcp-server` instead of a build directory (see [Where the files live](#where-the-files-live)).

### Claude Code

```bash
claude mcp add diagrams -- node /absolute/path/to/diagrams-mcp-server/dist/index.js
```

Set `PROJECT_ROOT` in your shell environment, or run Claude Code from within your project directory (it defaults to the current working directory).

### Codex (Desktop & CLI)

```bash
codex mcp add diagrams -- node /absolute/path/to/diagrams-mcp-server/dist/index.js
```

Or add directly to `~/.codex/config.toml`:

```toml
[mcp_servers.diagrams]
command = "node"
args = ["/absolute/path/to/diagrams-mcp-server/dist/index.js"]
env = { PROJECT_ROOT = "/absolute/path/to/your/project" }
```

### Antigravity (IDE, 2.0 & CLI)

Antigravity IDE, Antigravity 2.0, and Antigravity CLI share one config file: `~/.gemini/config/mcp_config.json` (or `.agents/mcp_config.json` for project scope). Add:

```json
{
  "mcpServers": {
    "diagrams": {
      "command": "node",
      "args": ["/absolute/path/to/diagrams-mcp-server/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

You can also add it from the IDE: **Agent panel â†’ â‹¯ menu â†’ MCP Servers â†’ Manage MCP Servers â†’ View raw config**, then paste the same block.

### OpenCode (Desktop & CLI)

```bash
opencode mcp add
```

When prompted, choose **Local** as the server type and enter:

```
node /absolute/path/to/diagrams-mcp-server/dist/index.js
```

Or edit `opencode.jsonc` directly:

```jsonc
{
  "mcp": {
    "diagrams": {
      "type": "local",
      "command": ["node", "/absolute/path/to/diagrams-mcp-server/dist/index.js"],
      "environment": {
        "PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Cursor (Desktop & CLI)

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-scoped):

```json
{
  "mcpServers": {
    "diagrams": {
      "command": "node",
      "args": ["/absolute/path/to/diagrams-mcp-server/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### VS Code (with GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "diagrams": {
      "command": "node",
      "args": ["/absolute/path/to/diagrams-mcp-server/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

Or via the command palette: **MCP: Add Server â†’ Command (stdio)**, then enter the same command and args.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PROJECT_ROOT` | current working directory | Root of the codebase this server is attached to (used by `diagrams_check_consistency`) |
| `DIAGRAMS_DIR` | `diagrams` | Where diagram files live, relative to `PROJECT_ROOT` unless absolute |
| `PLANTUML_SERVER_URL` | `https://www.plantuml.com/plantuml` | Override the public PlantUML rendering fallback (e.g. to point at a self-hosted instance) |
| `ALLOW_REMOTE_PLANTUML` | unset (remote fallback disabled) | Set to exactly `true` to allow the remote PlantUML server fallback when no local `plantuml` CLI is installed. Any other value keeps remote rendering disabled. Mermaid is always local-only and unaffected |
| `DISABLE_REMOTE_PLANTUML` | unset | Set to exactly `true` to never use the remote PlantUML server, even when `ALLOW_REMOTE_PLANTUML=true` is set. PlantUML rendering then requires a local `plantuml` CLI. Mermaid is always local-only and unaffected |

### Consistency scan limits

Every `diagrams_check_consistency` run observes these caps:

| Limit | Value | How you see it |
|---|---|---|
| Files scanned | 5,000 source files | the result reports `truncated`, `scan_limit`, `files_scanned`, and `scan_warning` so a capped scan is never mistaken for a complete one â€” when `truncated` is true, unmatched results may be incomplete |
| Per-file size | 1,000,000 bytes | larger files (usually generated bundles) are skipped silently |
| Evidence per entity | 10 matched files | `matched_files` is capped; `matched_file_count` still reports the full count |
| Concurrent file reads | 32 | bounds open handles while the scan runs |

### Generation limits

Every `diagrams_generate` run observes these caps. `max_entities` (1â€“60, default 30) bounds the emitted declarations; the limits below are the hard ceilings:

| Limit | Value | How you see it |
|---|---|---|
| Emitted entities | 60 declarations | `entities_available` reports the total found and `entities_capped` is true when any were dropped; `entity_limit` reports the applied cap |
| Emitted relations | 60 edges | `relations_available` reports the total evidenced and `relations_capped` is true when any were dropped by the cap or by an entity the cap removed â€” a diagram never references a box it does not declare |
| Files scanned | 5,000 source files | the result reports `truncated`, `scan_limit`, `files_scanned`, and `scan_warning` so a capped scan is never mistaken for a complete one â€” when `truncated` is true, generated entities may be incomplete |
| Per-file size | 1,000,000 bytes | larger files (usually generated bundles) are skipped |
| Concurrent file reads | 32 | bounds open handles while the scan runs |

When the TypeScript compiler is not installed (published installs have no `typescript` dependency), the tool degrades openly instead of failing: entities still come from declaration patterns, `relations` is empty, and `dialect_note` says relations are unavailable.

### Sequence limits

Every `diagrams_generate_sequence` run observes these caps. `max_participants` (1â€“20, default 8) bounds the declared participants and `max_messages` (1â€“50, default 20) bounds the emitted messages; the limits below are the hard ceilings:

| Limit | Value | How you see it |
|---|---|---|
| Declared participants | 20 participants | `participants_available` reports the total found and `participants_capped` is true when any were dropped; `participant_limit` reports the applied cap |
| Emitted messages | 50 messages | `messages_available` reports the total found and `messages_capped` is true when any were dropped by the cap or by a participant the cap removed â€” a message is never sent to a box the diagram does not declare; `message_limit` reports the applied cap |
| Deferred call sites | Counted, never sequenced | `deferred_count` reports how many calls sit inside a callback, promise, or listener; they are excluded from `messages` because their runtime position is unknowable from source |
| Unresolved callees | Reported, never guessed | `unresolved_callees` lists callees no participant in the scope declares, instead of inventing a participant for them |
| Files scanned | 5,000 source files | the result reports `truncated`, `scan_limit`, `files_scanned`, and `scan_warning` so a capped scan is never mistaken for a complete one â€” when `truncated` is true, generated messages may be incomplete |
| Per-file size | 1,000,000 bytes | larger files (usually generated bundles) are skipped |
| Concurrent file reads | 32 | bounds open handles while the scan runs |

When the TypeScript compiler is not installed (published installs have no `typescript` dependency), the tool degrades the same open way instead of failing: declared operations and call edges still come from the heuristic extractors, so participants and messages are still emitted.

### Diff scope

`diagrams_diff` reports, and never silently drops a change â€” but it deliberately compares less than a differencing tool can:

| Compared | Not compared |
|---|---|
| Declared class/interface/enum/component names, aliases, namespaces, participants, and message calls | Member lists, attributes, and method signatures |
| Added, removed, and renamed names (renames paired by the shared name normalizer) | Layout, position, ordering, styling, and theme |
| Sequence participants and message calls, per dialect | Cross-file or cross-diagram references and resolved types |

The tool has no caps of its own: both sides are already bounded by the two sources being compared, so every added, removed, and renamed name is reported in full. It reads nothing outside the diagrams root, and input-shape errors (a side given both or neither of its path and content, or inline content in no recognized dialect) are reported before any file is opened.

### Template limits

Every `diagrams_template` call observes these caps. There is no `max_*` argument to raise or lower â€” a skeleton is fixed scaffolding, so the ceilings below are the only shape it comes in:

| Limit | Value | How you see it |
|---|---|---|
| Entities per skeleton | 20 names (`1`â€“`20`) | `entities_included` reports the count actually emitted, in the order given |
| Entity name length | 60 characters | each name is emitted bare as a class, participant, or C4 alias, so this is the length that has to stay a legal identifier |
| Title length | 200 characters | a longer title is rejected rather than truncated; whitespace-only is rejected rather than emitting an empty title line |
| Built-in template kinds | 3 (`class`, `sequence`, `c4_context`) | fixed in `skeletons.ts`; UNRELEASED `custom` loads `<PROJECT_ROOT>/.diagrams-templates/<id>.json` instead                 |

Every name must match `/^[A-Za-z_][A-Za-z0-9_]*$/` and no two may repeat â€” a duplicate would emit two declarations of the same box, so the second occurrence is rejected at its own index. A rejection comes back with `isError: true` and names the offending input; the emitted source always passes the same syntax gate `diagrams_create` applies, so a skeleton can be saved as-is.

UNRELEASED custom-template bounds (for upcoming 0.8.0): `custom_template` id 1â€“64 chars `/^[A-Za-z0-9_-]+$/`; file read 65,536 bytes (`MAX_CUSTOM_TEMPLATE_BYTES`); expansion 1,000,000 UTF-16 chars (`MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS`); strict JSON (only optional `puml`/`mermaid` objects with required `source`/`entity` strings); regular files only, symlinks rejected. Example (verified against `FileSchema` in `customTemplates.ts`):

```json
{
  "puml": {
    "source": "@startuml\ntitle {{title}}\n{{entities}}\n@enduml\n",
    "entity": "class {{name}}"
  },
  "mermaid": { "source": "classDiagram\n%% {{title}}\n{{entities}}\n", "entity": "class {{name}}" }
}
```

### Export limits

Every `diagrams_export` run observes this cap on the finished HTML document:

| Limit | Value | How you see it |
|---|---|---|
| Bundle size | 5,000,000 bytes | a larger bundle is refused with `isError: true` naming the diagram and the ceiling; `truncated` is always `false`, so no partial file is ever returned or saved |

UNRELEASED (for upcoming 0.8.0): the cap measures the whole HTML containing the base64 SVG image. `svg_chars` is the decoded SVG source length after XML-preamble strip, before base64 encoding.

The SVG inside the bundle is bounded by what the renderer produced, and the renderer's own limits still apply on the way there. `include_source` is a boolean, not a size argument: the source block is either embedded in full or omitted, because a cut-off source next to a complete diagram would mislead a reader.

## Example

```
diagrams/
â””â”€â”€ models/
    â””â”€â”€ user-class.puml
```

Ask your agent:

> "Is the user-class diagram still accurate compared to the code?"

The agent calls `diagrams_check_consistency`, which reports:

```
1 of 2 entities in 'models/user-class.puml' were NOT found in the codebase:
- Order: 'Order' appears in the diagram but no matching identifier was
  found in the scanned codebase. It may be renamed, removed, or not yet
  implemented.
```

## Project layout

```
src/
â”œâ”€â”€ index.ts                       # CLI dispatch (setup | --help | serve) + stdio wiring
â”œâ”€â”€ server.ts                      # createDiagramServer(ctx): McpServer + 12 tool registrations
â”œâ”€â”€ context.ts                     # Resolves PROJECT_ROOT / DIAGRAMS_DIR once at startup
â”œâ”€â”€ constants.ts                   # Shared constants (incl. UNRELEASED MAX_CUSTOM_TEMPLATE_* + MAX_EXPORT_HTML_BYTES)
â”œâ”€â”€ types.ts                       # Shared TypeScript types
â”œâ”€â”€ constants.test.ts / packaging.test.ts / setup.test.ts  # Colocated root tests
â”œâ”€â”€ setup/                         # Guided client-setup wizard (scopes, pre-flight checks)
â”‚   â”œâ”€â”€ index.ts                   # runSetup orchestrator
â”‚   â”œâ”€â”€ clients.ts                 # Client catalog, PATH checks, compatibility exports
â”‚   â”œâ”€â”€ arguments.ts               # Setup flags and scope parsing
â”‚   â”œâ”€â”€ configuration.ts           # Config paths, server entries, merging, persistence
â”‚   â”œâ”€â”€ projectRoot.ts             # Project-root prompt loop and scope policy
â”‚   â”œâ”€â”€ prompts.ts                 # Interactive pickers and confirmations
â”‚   â””â”€â”€ terminal.ts                # Banner, boxes, color
â”œâ”€â”€ services/
â”‚   â”œâ”€â”€ diagramStore.ts            # Safe filesystem CRUD (path-traversal protected)
â”‚   â”œâ”€â”€ store/diagramMetadata.ts    # File type detection and bounded title reading
â”‚   â”œâ”€â”€ diagramValidator.ts        # PlantUML/Mermaid syntax checks and dialect detection
â”‚   â”œâ”€â”€ nameNormalize.ts           # Shared lenient name normalizer (checker + diff)
â”‚   â”œâ”€â”€ renderer.ts                # Mermaid/PlantUML -> SVG/PNG rendering
â”‚   â”œâ”€â”€ renderer/
â”‚   â”‚   â”œâ”€â”€ command.ts             # CLI resolution, Windows arguments, bounded process execution
â”‚   â”‚   â”œâ”€â”€ error.ts               # Shared RenderError class
â”‚   â”‚   â”œâ”€â”€ local.ts               # Local Mermaid/PlantUML backends and temporary-file cleanup
â”‚   â”‚   â”œâ”€â”€ plantumlRemote.ts      # PlantUML URL encoding and bounded remote requests
â”‚   â”‚   â””â”€â”€ types.ts               # Shared rendering contracts and dependency seams
â”‚   â”œâ”€â”€ scopeResolve.ts            # Bounds read-only tool scopes to PROJECT_ROOT
â”‚   â”œâ”€â”€ *.test.ts                   # Colocated service tests: store, validator, renderer, scope, normalize, checker
â”‚   â”œâ”€â”€ consistencyChecker/        # Diagram <-> code drift detection
â”‚   â”‚   â”œâ”€â”€ index.ts               # checkConsistency orchestration (scan, match, report)
â”‚   â”‚   â”œâ”€â”€ fileAnalysis.ts        # Read and analyze bounded code files
â”‚   â”‚   â”œâ”€â”€ entityMatching.ts      # Match names and collect issues and evidence
â”‚   â”‚   â”œâ”€â”€ entities.ts            # Entity names from diagram source
â”‚   â”‚   â”œâ”€â”€ codeAnalysis.ts        # Per-language declaration patterns
â”‚   â”‚   â”œâ”€â”€ scanning.ts            # Filesystem walk with scan limits
â”‚   â”‚   â”œâ”€â”€ sequence/              # Call-graph edges, participant mapping, message ordering
â”‚   â”‚   â”‚   â”œâ”€â”€ callGraph.ts / operationIndex.ts / participantMapping.ts
â”‚   â”‚   â”‚   â”œâ”€â”€ sequenceEntities.ts / sequenceMatch.ts / sequenceOrder.ts
â”‚   â”‚   â”‚   â””â”€â”€ sequenceGoldens.test.ts / sequenceOrderGoldens.test.ts
â”‚   â”‚   â””â”€â”€ ts/                    # Optional TypeScript AST path (dynamic import only â€” never a static import, so published installs run without the compiler)
â”‚   â”‚       â”œâ”€â”€ tsParse.ts         # Compiler availability probe (+ tsParse.test.ts)
â”‚   â”‚       â”œâ”€â”€ tsSymbols.ts       # Declared symbols + heritage collection (+ tsSymbols.test.ts)
â”‚   â”‚       â”œâ”€â”€ tsIndex.ts / tsHeritage.ts  # Index and extends/implements edges (+ tsIndex.test.ts, tsGoldens.test.ts)
â”‚   â”‚       â””â”€â”€ tsCalls.ts         # UNRELEASED AST call edges for sequences via optional includeCalls (+ tsCalls.test.ts)
â”‚   â”œâ”€â”€ diff/                      # diagrams_diff comparison
â”‚   â”‚   â”œâ”€â”€ diffDiagram.ts         # Pure added/removed/renamed + sequence fields
â”‚   â”‚   â””â”€â”€ callOrder.ts           # UNRELEASED bounded recognized call-order comparison
â”‚   â”œâ”€â”€ export/                    # diagrams_export bundle builder (pure, no filesystem)
â”‚   â”‚   â”œâ”€â”€ htmlBundle.ts          # SVG-as-image HTML wrapper + CSP from SVG + source
â”‚   â”‚   â””â”€â”€ exportGoldens.test.ts  # Exact wrapper structure locked per variant
â”‚   â”œâ”€â”€ generate/                  # diagrams_generate entity collection and emitters
â”‚   â”‚   â”œâ”€â”€ collectEntities.ts     # Scan a scope into ordered entities + relations
â”‚   â”‚   â”œâ”€â”€ emitters.ts            # Pure PlantUML/Mermaid class-diagram emitters
â”‚   â”‚   â”œâ”€â”€ sequence.ts            # diagrams_generate_sequence orchestration (participants, messages, caps)
â”‚   â”‚   â”œâ”€â”€ sequenceEmitters.ts    # Pure PlantUML/Mermaid sequence emitters
â”‚   â”‚   â”œâ”€â”€ scopeFiles.ts          # Scope walking shared by both generators
â”‚   â”‚   â””â”€â”€ types.ts               # Shared generation options, results, relations, and messages
â”‚   â””â”€â”€ templates/                 # diagrams_template skeletons + UNRELEASED custom loader
â”‚       â”œâ”€â”€ skeletons.ts           # Six pure built-in emitters: kind x dialect
â”‚       â”œâ”€â”€ customTemplates.ts     # UNRELEASED .diagrams-templates/<id>.json loader (+ customTemplates.test.ts)
â”‚       â”œâ”€â”€ templateCatalog.ts     # UNRELEASED bounded candidate discovery (+ templateCatalog.test.ts)
â”‚       â””â”€â”€ templateGoldens.test.ts # Exact emitted source per (template, format)
â”œâ”€â”€ tools/                         # One MCP tool adapter per file (13 tools) + shared toolError; *.test.ts colocated per tool
â”‚   â”œâ”€â”€ diffInput.ts               # diagrams_diff validation and stored/inline side loading
â”‚   â””â”€â”€ diffSummary.ts             # diagrams_diff text summaries
â””â”€â”€ integration/
    â””â”€â”€ mcpServer.test.ts          # End-to-end server surface tests
```

See [docs/architecture.md](./docs/architecture.md) for the CLI â†’ server
composition â†’ tools â†’ services boundaries and how to extend them.
`examples/` is the reference fixture project (`examples/src/user.ts` plus two
diagrams under `examples/diagrams/models/`); `evaluations/` holds the
read-only Q&A (`eval.xml`) and the AST activation probe
(`prod-activation/probe.mjs`, `npm run probe:prod`).

Tests live next to the source they cover (`*.test.ts`), compile to `dist/`,
and run from there. `scripts/build.mjs` cleans `dist/` before compiling;
`scripts/test.mjs` discovers compiled `*.test.js` recursively, so new tests
need no package-script edits. Build before running `npm test`.

## Security notes

-   All file operations are restricted to the configured diagrams directory; attempts to read/write outside it (e.g. via `../..`) are rejected. Windows-style `\` separators work as path separators on every platform, so `..\..` traversal is rejected on Linux too.
- `diagrams_check_consistency`, `diagrams_generate`, and `diagrams_generate_sequence` only *read* your codebase â€” they never modify code or diagrams. Both generators resolve their `scope` against `PROJECT_ROOT` and refuse (without reading anything) any path that would land outside it; their output is source text you save yourself with `diagrams_create`.
- `diagrams_diff` is read-only too: stored sides are read through the same traversal-protected store as `diagrams_get`, inline sides never touch the filesystem at all, and input-shape errors are reported before any file is opened. Errors and logs never include diagram source, only the names being reported.
- `diagrams_template` built-ins touch no filesystem at all â€” no project root, no diagrams directory, no state between calls. UNRELEASED custom templates are read-only: one `<PROJECT_ROOT>/.diagrams-templates/<id>.json` regular-file read (symlinks rejected), nothing written; the supplied title and entity names are expanded into the selected template.
- `diagrams_export` reads one diagram through the same traversal-protected store as `diagrams_get` and returns the bundle as text â€” it writes nothing, so the store's extension allow-list never opens to `.html`. UNRELEASED: the artifact embeds the SVG as a base64 data image under `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`; scripts and external resources are disabled by SVG-image processing, not by claimed sanitization or removal of encoded markup. The only path it carries is the diagram's POSIX `relative_path`. Remote PlantUML rendering, when you opt into it, sends diagram source to the configured server; that is the renderer's existing path, unchanged.
- No credentials or external accounts are required for any tool. `diagrams_render` for PlantUML never leaves the machine unless remote rendering is explicitly enabled with `ALLOW_REMOTE_PLANTUML=true` â€” and never when `DISABLE_REMOTE_PLANTUML=true` is set, which takes precedence. Mermaid rendering never leaves the machine.
- Local renderer processes run with a timeout and bounded stdout/stderr capture (1,000,000 characters per stream, enforced while collecting). A renderer that exceeds the cap or its timeout budget is stopped: its output pipes are closed and the process is killed, and rendering fails with an actionable error that never includes captured output, paths, or environment values. On timeout, the error is delivered immediately rather than waiting for a descendant process that inherited the renderer's output pipes (for example through the Windows `cmd.exe` shim chain) to release them.

## Roadmap

Shipped in v0.7.0 (see [RELEASE_NOTES.md](./RELEASE_NOTES.md)):

- TypeScript AST path for consistency checking â€” stricter matching plus `extends`/`implements` edges when the compiler is available, open heuristic fallback when it is not
- Sequence diagrams both ways: `diagrams_generate_sequence` drafts them from call-graph edges, and the checker compares message ordering (callbacks deferred, never sequenced)
- Diagram diffing (`diagrams_diff`), starter skeletons (`diagrams_template`), and self-contained HTML export (`diagrams_export`)

Still open:

- Code-from-diagram scaffolding: generate a class skeleton from a diagram (the reverse of `diagrams_generate`)
- AST-backed precision for more languages, as demand dictates
- Export hardening follow-up: UNRELEASED image isolation replaces live-SVG export; the historical allowlist-sanitizer proposal in `docs/next-features.md` is not implemented (tracked there)

UNRELEASED development additions for 0.8.0 (for upcoming 0.8.0): AST-backed TS sequence calls (`tsCalls.ts` via `includeCalls`), project-local custom templates (`template="custom"`), and SVG-as-image export with wrapper CSP. See [Template limits](#template-limits), [Export limits](#export-limits), and `docs/next-features.md` current-status notes.

Contributions and issues welcome.

## License

MIT â€” see [LICENSE](./LICENSE).

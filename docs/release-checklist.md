# Release verification

Use this process for the 0.9.0 preview line and later releases that include
`scripts/probe-package.mjs`. The package remains a technical preview and the
numeric version is published under npm's default `latest` tag.

## Candidate preparation

Align the package version and both lockfile root versions with the MCP runtime
version and setup banner. Update both version fields in `server.json` too.
The registry integration tests verify lockfile and server metadata alignment.
The real stdio tests verify runtime and setup banner alignment.

Run the repository gates from a clean dependency install:

```bash
npm ci
npm audit
npm run lint
npm run format:check
npm run build
npm test
```

Preserve historical release notes and immutable tags. Update the README and
current architecture and roadmap for changed behavior. The README must contain
zero periods and zero commas. Its Mermaid source stays editable in the README.

## Packaged acceptance

The development test suite does not replace an installed package check.
Use an empty installation prefix outside the repository so development
dependencies cannot activate optional compiler paths accidentally.

These commands assume a POSIX shell and working `plantuml` and `mmdc` commands
on PATH. Use the matching temporary directory and environment syntax on Windows.
The server process must inherit those renderer commands. External renderers
have their own runtime requirements independent of the server engine range.

```bash
ARTIFACTS="$(mktemp -d)"
CONSUMER="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$ARTIFACTS"
npm install --prefix "$CONSUMER" "$ARTIFACTS/diagrams-mcp-server-0.9.0.tgz" --omit=dev --ignore-scripts
npm run probe:package -- "$CONSUMER"
```

Build before packing with scripts disabled. The probe reads the installed
package metadata and bin entry and uses the SDK resolved from that install.
It verifies all fifteen tools through a real stdio subprocess. Four image calls
exercise SVG and PNG output from both renderers. Additional calls check HTML
export and persistence and exclusive creation and custom templates and typed
association scaffolding. It checks unknown argument rejection and confirms
saved HTML does not enter diagram discovery.

The probe requires the optional TypeScript compiler to be absent. It validates
the package README punctuation and license and compiled test exclusion. Remote
PlantUML rendering is disabled. All fixture source and output live in a probe
owned temporary project that is removed after the client closes.

Local acceptance was run on Windows with Node 26 using Mermaid CLI 12 and
PlantUML 1.2026.9 through its Java 8 compatible artifact. Chrome supplied the
Mermaid browser. Both real backends returned SVG and PNG and all fifteen tools
passed from a production only tarball install.

## Publication boundary

Merge the verified release candidate after the Ubuntu and Windows Node 20 and
22 CI matrix passes. Create a new annotated version tag with the maintainer's
commit identity and push that tag. Never move a pre-existing version tag.

The publish workflow runs the repository gates on the selected tag. For a new
npm version it audits dependencies and prepares pinned renderer versions and verifies the PlantUML
artifact digest. It packs once and installs that tarball without development
dependencies and audits that install and runs the real renderer probe on Linux
with Node 22. The npm
publish step uploads that exact verified tarball rather than rebuilding it.

Existing npm versions skip fresh artifact acceptance and npm publication during
recovery. MCP registration is checked separately. See
[release recovery](release-recovery.md) for retry behavior and immutable tag rules.

Verify both registries after publication:

```bash
npm view diagrams-mcp-server@0.9.0 version dist.integrity
curl --fail --silent --show-error 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mohammad-emad-dev%2Fdiagrams-mcp-server/versions/0.9.0'
```

The npm version and artifact integrity must match the publication result.
The MCP response must name the expected server and exact version. A successful
npm upload alone does not establish MCP registration. Inspect the workflow and
registry responses before reporting release completion.

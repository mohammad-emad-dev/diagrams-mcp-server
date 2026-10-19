# Current roadmap

This is the milestone record for the 0.11.0 technical preview line.
The [next features document](next-features.md) preserves historical proposals
and phase checklists rather than an active backlog.

## Completed foundation

The structural cleanup separates CLI startup and client setup from MCP
composition and tool adapters. Services own storage and analysis and rendering.
Builds remove stale output and tests are discovered from compiled files.
All fifteen tools are implemented with explicit write boundaries.

The README provides client setup commands and linked reading paths and four
editable Mermaid diagrams. The [documentation index](README.md) distinguishes
current engineering guides from historical handoff records.

HTML exports isolate SVG in images rather than live markup. Explicit export
persistence and bounded TypeScript member and field and association scaffolds
are present. Local renderer reads and remote downloads enforce size limits.
Sequence senders are anchored to their call-site files.

## Selected extensions in 0.11.0

Each previously open development area has a bounded first increment rather
than an unrestricted parsing or runtime-analysis commitment.

| Area | Implemented increment | Deliberate boundary |
| --- | --- | --- |
| Sequence participant evidence | Selected declaration participant and bounded competing candidates per emitted callee | Stable first-match selection without receiver type resolution |
| Rename evidence | Opt-in exact diagram message-call counts for paired old and new names | No source-code scan or semantic identity inference |
| Scaffold syntax | Literal readonly arrays with the existing supported bases and optional null arm | No nested arrays or arbitrary unions or inheritance |
| Additional output language | JavaScript empty exported class shells through an explicit language option | No JavaScript member or type or relation modes |

The release also includes ambiguous-callee diagnostics and the fallback reader
fix for real recursive calls on a function declaration line. Deferred calls
remain excluded from the emitted sequence. Ubuntu and Windows CI cover Node
20 and 22 and 24 with pinned Node 24 action runtimes.

## Contributor entry points

The following issues isolate syntax work for contributors with acceptance
criteria and files and test instructions. Both good first issue and help wanted
labels are applied.

- [Go struct and interface declarations](https://github.com/mohammad-emad-dev/diagrams-mcp-server/issues/46)
- [Rust braced struct and enum declarations](https://github.com/mohammad-emad-dev/diagrams-mcp-server/issues/47)
- [Explicit rectangular Mermaid flowchart IDs](https://github.com/mohammad-emad-dev/diagrams-mcp-server/issues/48)
- [Literal readonly scaffold arrays](https://github.com/mohammad-emad-dev/diagrams-mcp-server/issues/49) is implemented in this release

Go and Rust still use the experimental analyzer tier. These contributor issues
do not promise full parsers or a tier promotion.

## Release acceptance

Follow the [release checklist](release-checklist.md) for source gates and clean
package acceptance and publication. The package probe uses a production-only
install without TypeScript and real local PlantUML and Mermaid renderers.
It also checks the new language and evidence modes over actual MCP stdio.
GitHub source availability does not establish npm or MCP registry publication.

## Future scope decisions

Runtime receiver resolution and source-code-backed semantic rename evidence
remain separate design work. Richer scaffold inheritance and member languages
also need their own contracts. They are outside this release milestone.
Selectable live SVG would require a reviewed sanitizer boundary. The current
image isolation design does not depend on that feature. Watch mode and
automatic writes are not selected work items.

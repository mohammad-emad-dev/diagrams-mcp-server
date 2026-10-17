# Current roadmap

This is the current milestone record for the 0.9.0 technical preview line.
The older [next features document](next-features.md) preserves its original
phase checklists and is not an active backlog.

## Completed development

The structural cleanup is complete. CLI startup and client setup are separate
from MCP composition and tool adapters. Services own storage and analysis and
rendering. Builds remove stale output and tests are discovered from compiled
files.

All fifteen tools are implemented. The original five feature proposals shipped
before this release line. Custom templates and template discovery are present.
HTML exports use SVG image isolation rather than live SVG markup.

The 0.9.0 additions provide explicit HTML persistence and TypeScript class
scaffolding with optional members and supported field types and labeled
association fields. Remote downloads now enforce timeout and decoded byte
limits through body completion. Local renderer image reads are bounded too.

The README provides engineering documentation and four Mermaid visuals.
The [release checklist](release-checklist.md) separates packaged acceptance from
publication. The package smoke probe exercises all fifteen tools over real
stdio from a production install without TypeScript and with actual local
renderers. Publication makes this development available to registry installs
only after the release workflow succeeds.

## Further development candidates

These are product extensions rather than missing cleanup or release checks.
Each needs a bounded design and acceptance criteria before implementation.

| Candidate | Current limit | Useful next result |
| --- | --- | --- |
| Sequence participant resolution | File level name ownership and unresolved callees | Stronger receiver and declaration evidence |
| Rename evidence | Heuristic name pairing | Call site evidence that supports or rejects a proposed rename |
| Scaffolding syntax | Plain class blocks and a strict field type subset | Selected richer type or inheritance forms with explicit limits |
| Additional output languages | TypeScript drafts only | A separately specified language emitter with its own validation |

An SVG allowlist sanitizer is not a prerequisite for the current HTML image
isolation design. Selectable live SVG would require a new reviewed boundary.
Watch mode and automatic writes are not selected work items.

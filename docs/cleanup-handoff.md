# Cleanup handoff

Structural cleanup is complete as of 2026-10-14. The project is ready to move
from cleanup to selecting features and improvements. This milestone does not
select or implement a new feature.

## Current structure

[Architecture](architecture.md) describes the CLI/server split, tool adapters,
service boundaries, shared contracts, setup modules, and build/test workflow.
Existing compatibility exports remain available. Tests stay beside their source;
build and test runners live in `scripts/`.

[Next features](next-features.md) is the historical design and acceptance record.
Its five proposed tools are already implemented in the current twelve-tool
checkout. Its V2 follow-ups remain unscheduled candidates for future work.

## Verification

Final local checks passed on Windows with Node v26.7.0:

- Lint, formatting, and a clean build.
- 442 tests: 433 passed, 9 skipped, 0 failed.
- Server and setup CLI help smoke checks.
- Package dry run: 66 shipped files, with compiled tests excluded.
- Git whitespace/error checks.

The configured Ubuntu/Windows CI matrix on Node 20 and 22 was not run in this
local session. Earlier refactor checks also compared outputs and emitted
JavaScript against pre-change snapshots; those checks supplement the test suite.

## Handoff notes

Changes remain uncommitted. Runtime behavior and public contracts were preserved
through the cleanup; no dependencies were added. Existing local configuration
and the pre-existing `.agents/` directory were retained.

Release preparation still needs to reconcile the existing package version
(`0.7.0`) with server/setup metadata (`0.6.0`). That metadata was deliberately
left unchanged during behavior-preserving cleanup.

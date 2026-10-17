# Cleanup handoff

This document records the cleanup baseline rather than the current tool count
or release verification. See the [current roadmap](roadmap.md) and
[release checklist](release-checklist.md) for the 0.9.0 line.

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

The cleanup baseline passed local checks on Windows with Node v26.7.0. After
the version metadata fix, all checks below also passed on Windows with
Node v20.20.2 and v22.23.3:

- Lint, formatting, and a clean build.
- 444 tests: 435 passed, 9 skipped, 0 failed.
- Server and setup CLI help smoke checks.
- Package dry run: 66 shipped files, with compiled tests excluded.
- Git whitespace/error checks.

The Ubuntu/Windows CI matrix on Node 20 and 22 is defined in
`.github/workflows/ci.yml`; its remote results are separate from this local
validation record. Local Linux validation was unavailable because the Docker
Linux engine did not start. Earlier refactor checks also compared outputs and
emitted JavaScript against pre-change snapshots; those checks supplement the
test suite.

## Handoff notes

The cleanup baseline is saved in commit `ed1c6c7`. Runtime behavior and public
contracts were preserved through that cleanup; no dependencies were added.
Existing local configuration and the pre-existing `.agents/` directory were
retained; `.agents/` was not included in the baseline commit.

A separate readiness fix reconciles package, MCP server, and setup banner
metadata to `0.7.0`. Public integration tests compare both advertised versions
with `package.json`; the setup check exits before configuration changes.

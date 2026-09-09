---
name: Bug report
about: Something in the server behaves differently than documented
title: "[bug] "
labels: bug
---

## What happened

A short description of the wrong behavior, and which tool it involves
(`diagrams_list`, `diagrams_get`, `diagrams_create`, `diagrams_update`,
`diagrams_delete`, `diagrams_render`, or `diagrams_check_consistency`).

## Steps to reproduce

Numbered steps starting from a clean setup:

1. `npm ci` and `npm run build`
2. ...
3. ...

## Expected behavior

What the README or the tool description says should happen.

## Actual behavior

What happened instead. Paste the MCP error text (`Error: ...`) if there is one.

## Environment

- `node --version`:
- OS:
- Install method (source checkout or local tarball):
- `PROJECT_ROOT` / `DIAGRAMS_DIR` settings (values only, no secrets):

## Logs

Paste the relevant log or error output. Strip secrets, tokens, environment
values, and full file contents before posting.

---
name: Language support
about: Request a new code analyzer or improve an existing one
title: "[lang] "
labels: language-support
---

## Language and version

The language, its version, and the file extensions involved (for example `.cs`).

## Minimal fixture

A small code sample the analyzer should handle, plus the diagram entities
that name things in it:

```text
(paste a few lines of code and the matching diagram snippet here)
```

## Expected entities

Which names should match, and which should stay unmatched (missing entity,
comment-only mention, string-only mention).

## What the analyzer should recognize

The declaration forms that matter (classes, functions, interfaces, and so on).

## Known limitations

Anything the reporter already knows will not work (comments, string
literals, generated files, framework magic, and the like).

## Tier

New languages start as `experimental`: a small fixture plus a test that the
analyzer does not crash or scan unrelated files. `reliable` additionally
needs representative fixtures, documented limitations, predictable matching,
and tests for every declaration form claimed. See CONTRIBUTING.md for the
full bar.

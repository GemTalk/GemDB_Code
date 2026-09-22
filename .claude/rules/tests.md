---
description: Which of the two test suites a test belongs in, and why each is shaped the way it is.
paths:
  - 'src/__tests__/**'
  - 'src/__integration__/**'
  - 'src/__mocks__/**'
  - 'vitest.config.mts'
  - 'vitest.integration.config.mts'
---

# Tests

Test names should use plain language, not code identifiers. Describe the scenario from a functional or user perspective — avoid mirroring internal field names, variable names, or implementation details.

- ✗ `when isNewMethod is true`
- ✓ `when the previous URI is a template`

Test names state what is always true, not what happens to be true in this one run. `'returns 3 when adding 1 + 2'` describes the example; `'adds two positive numbers'` describes the guarantee. If the example changes, the first name rots; the second stays valid.

- ✗ `returns 3 when adding 1 + 2`
- ✓ `adds two positive numbers`

**Test structure: three parts, separated by blank lines.**
Tests have up to three parts — setup (optional), exercise, and assert(s) — each separated by a blank line. Always use blank lines between present parts; they make the structure scannable at a glance. Never use section-label comments.

# The two test suites

`npm test` is mocked, host-free, and runs in milliseconds. It covers decision
logic and branches — anything with a choice worth defending, tested without a
real database or a real editor. Code that needs to isolate its branches from
IO or from VS Code should take its collaborators as an explicit argument
(a `*World`-style parameter) rather than reaching for them, so the unit test
can supply a fake.

`npm run test:integration` starts a real database in a temporary root path
and is a separate command because it costs seconds rather than milliseconds
and can leave processes behind if it fails badly. It borrows the installed
engine by symlink rather than downloading one, and points `gemdb.rootPath` at
a temp directory; since `engineEnvironment` sets `GEMSTONE_GLOBAL_DIR` to the
root path — where the engine keeps its lock files — a test stone and a real
one can share a name and stay invisible to each other. It skips itself when
no engine is installed, so a fresh checkout with no engine still gets a green
unit suite rather than a false failure.

New test: if it needs a real database process or exercises install/engine
plumbing, it's integration; otherwise it's a unit test, and prefer giving the
code under test an explicit collaborators argument over mocking modules.

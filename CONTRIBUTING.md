# Contributing to GemDB Code

## First-time setup

```sh
nvm use          # the version in .nvmrc, which is what CI uses
npm install
```

`.nvmrc` pins the Node that CI and this repo develop on; `engines.node` in
`package.json` is the older floor the extension still supports, because the
Node that actually runs the extension is the editor's, not this one.

That is everything the unit suite and the typechecks need. The rest — the
integration suite and the two build artifacts — needs a database engine on the
machine, which you get either by running the extension once (it downloads one)
or, with no editor in the loop, by:

```sh
scripts/install-engine.sh   # -> ~/GemDB/GemStone64Bit<pinned>-<platform>
```

It installs to the one path `bundle:grail`, `bundle:extent` and the integration
fixture all look for, reuses an archive it has already downloaded, and leaves an
engine that is already there alone.

## Build and test

```sh
npm run typecheck          # tsc --noEmit
npm run typecheck:strict   # extra checks the first-party code is held to
npm run lint
npm run format:check
npm test                   # unit tests, mocked, milliseconds
npm run test:integration   # a real database in a temp root path; seconds
npm run bundle             # esbuild -> out/extension.js
```

Before calling something done:

```sh
npm run lint && npm run format:check && npm run typecheck && npm run typecheck:strict
```

`npm test` is mocked and fast and covers decisions; `npm run test:integration`
starts a real database, so it is a separate command. It skips itself when no
engine is installed. See [CLAUDE.md](CLAUDE.md) for what belongs in which.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull
request, on pushes to `main`, and on demand. Two jobs:

| Job | Where | What it covers |
| --- | --- | --- |
| `checks` | Linux, ~2 min | lint, format, both typechecks, the unit suite, and that `vsce` can still package |
| `integration` | macOS on Apple Silicon, ~15 min | installs the pinned engine, raises shared memory, builds the Grail payload and the shipped extent, runs the integration suite, then packages a `.vsix` and checks what is inside it |

Require the `ci-complete` check in branch protection rather than the two job
names — it exists so the names above can change without reconfiguring the
branch.

The integration job builds the Grail payload from **Grail's default branch**, so
a change here that depends on unmerged Grail work will be red until that Grail
pull request lands. To prove it before then, run the workflow manually
(Actions → CI → Run workflow) and give the `grail-ref` input the Grail branch;
it becomes `GRAIL_REF` for `bundle-grail.sh`.

Neither job publishes anything. Releases stay a deliberate act from a
developer's Mac, for the reason in the release steps below.

## The two build artifacts

A release ships a database and a compiled Python runtime, not just the code to
build them. Both are gitignored and produced by scripts, and **both must be
rebuilt when cutting a release**:

```sh
npm run bundle:grail    # -> grail/        (needs a C toolchain)
npm run bundle:extent   # -> extent/       (needs an engine + shared memory)
```

`bundle:grail` clones [Grail](https://github.com/GemTalk/Grail), compiles its
CPython shim against the **pinned** engine version, and stages the result. The
shim links `$GEMSTONE/lib/gciualib.o`, so it is valid only for the platform
**and** engine version it was built against — a mismatch installs cleanly and
then fails at `import`.

Each run of `bundle:grail` adds its own `grail/prebuilt/<platform>/` and leaves
the others alone. **1.x ships `arm64.Darwin` only**, and the two places that
must agree with that are:

- `isSupportedPlatform()` in [`src/platform.ts`](src/platform.ts) — the single
  runtime gate, currently `darwin` + `arm64`.
- `--target darwin-arm64` in the `package` and `publish:*` scripts — this makes
  it a *platform-specific extension*, so the Marketplace serves it only to
  matching machines rather than letting anyone install something that cannot
  work.

Check before packaging:

```sh
ls grail/prebuilt/     # expect arm64.Darwin
```

**Adding a platform is two coordinated steps, in this order:** run
`bundle:grail` on that platform so its shim is staged, *then* widen
`isSupportedPlatform()` and add a target. Widening the gate without the shim
produces a build that installs fine and fails at the first `import` — the bug
that predicate exists to prevent. Multiple targets are published as separate
`.vsix` files from the same source tree (`vsce publish --target darwin-arm64`,
then `--target linux-x64`, and so on).

`bundle:extent` creates a scratch database, files Grail into it, and stages the
result as `extent/gemdb.dbf`. Unlike the shim, the extent is portable across
platforms — build it once per release. A `.vsix` built without it still works,
falling back to filing Grail in on first use.

## Publishing a release

GemDB Code is published to both the **VS Code Marketplace** and **Open VSX**,
under the same `gemtalksystems` publisher as Jasper.

1. `npm version <X.Y.Z> --no-git-tag-version` — bumps `package.json` and the two
   root fields in `package-lock.json` atomically. Don't hand-edit these or
   find-and-replace the version across the lockfile: the version string can
   collide with an unrelated dependency's own version elsewhere in the file and
   corrupt that entry. Then promote `[Unreleased]` in `CHANGELOG.md` to a dated
   `[X.Y.Z]` heading and update the link definitions at the bottom.
2. Rebuild both artifacts on an Apple Silicon Mac — `npm run bundle:grail` and
   `npm run bundle:extent` — then confirm `ls grail/prebuilt/` shows
   `arm64.Darwin`.
3. `npm run lint && npm run format:check && npm run typecheck && npm run typecheck:strict && npm test`
4. Commit the version + changelog changes (e.g. `Release X.Y.Z: <summary>`).
5. `git tag -a vX.Y.Z -m "Release X.Y.Z"` — annotated tag, on the release commit.
6. `npm run package` — produces `gemdb-darwin-arm64-X.Y.Z.vsix` in the repo
   root (the target is in the filename because it is a platform-specific
   build). Delete the previous version's `.vsix`; they are gitignored but stay
   on disk.
7. `scripts/check-vsix.sh` — asserts the packaged `.vsix` actually carries the
   payload table below: both bundles, the extent, the shim for this platform,
   koffi's binary and only this platform's, and the installer scripts. CI runs
   the same check on every pull request, so a missing `prebuilt/` directory or
   a stale artifact is caught before it reaches here.
8. **Install that `.vsix` and run it once** before publishing. The check above
   proves the payload is present, not that it works: the artifacts mean a
   broken release is a broken database rather than a broken button, and only
   running it exercises the shim against the engine.
9. `npm run publish` — runs `vsce publish` then `ovsx publish`. If `vsce publish`
   times out on the Azure DevOps Gallery API (it happens), re-run
   `npx @vscode/vsce publish` directly — don't re-run `npm run publish`, since
   the `ovsx` step will then double-publish and fail with "already exists."
10. `git push origin main && git push origin vX.Y.Z` — the tag does not
    piggyback on the branch push.

### Credentials

You must be logged in with Personal Access Tokens for both registries:

```sh
npx @vscode/vsce login gemtalksystems                # VS Code Marketplace
npx ovsx create-namespace gemtalksystems -p <token>  # Open VSX (one-time; already done)
```

`ovsx publish` reads `OVSX_PAT` from the environment (or a stored token). The
Marketplace token is an Azure DevOps PAT with **Marketplace → Manage** scope,
issued from the organization that owns the publisher.

### What ships in the `.vsix`

`.vscodeignore` decides. `scripts/check-vsix.sh` asserts the table below against
a packaged `.vsix`, and `npx vsce ls` shows the full list. The payload is
dominated by a few things that **must** be there:

| Path | Why |
| --- | --- |
| `out/extension.js` | the extension bundle |
| `out/gemdb-shell.js` | the GemDB Shell, staged to `<rootPath>/bin` at run time |
| `grail/` | the Python runtime and per-platform compiled shim |
| `extent/gemdb.dbf` | the preloaded database |
| `node_modules/koffi/` | the native FFI addon; it is a runtime `dependency`, not bundled, because it loads its own platform binary at run time |

Sources, tests, and tooling are excluded. `README.md`, `CHANGELOG.md`,
`LICENSE`, and `NOTICE` ship — the first two become the Marketplace's Overview
and Changelog tabs.

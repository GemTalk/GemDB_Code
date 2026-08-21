# Contributing to GemDB Code

## First-time setup

```sh
nvm use          # Node 22.15+ (see engines in package.json)
npm install
```

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
7. **Install that `.vsix` and run it once** before publishing. The artifacts
   above mean a broken release is a broken database, not a broken button, and
   nothing in CI catches a missing `prebuilt/` directory.
8. `npm run publish` — runs `vsce publish` then `ovsx publish`. If `vsce publish`
   times out on the Azure DevOps Gallery API (it happens), re-run
   `npx @vscode/vsce publish` directly — don't re-run `npm run publish`, since
   the `ovsx` step will then double-publish and fail with "already exists."
9. `git push origin main && git push origin vX.Y.Z` — the tag does not
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

`.vscodeignore` decides. Check with `npx vsce ls` before publishing. The
payload is dominated by three things that **must** be there:

| Path | Why |
| --- | --- |
| `out/extension.js` | the bundle |
| `grail/` | the Python runtime and per-platform compiled shim |
| `extent/gemdb.dbf` | the preloaded database |
| `node_modules/koffi/` | the native FFI addon; it is a runtime `dependency`, not bundled, because it loads its own platform binary at run time |

Sources, tests, and tooling are excluded. `README.md`, `CHANGELOG.md`,
`LICENSE`, and `NOTICE` ship — the first two become the Marketplace's Overview
and Changelog tabs.

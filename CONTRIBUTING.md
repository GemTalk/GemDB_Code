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
| `integration` | one leg per shipped target — `macos-15`, `ubuntu-latest`, `ubuntu-24.04-arm`; ~3 min each, in parallel | installs the pinned engine, raises shared memory, builds the Grail payload and the shipped extent, runs the integration suite, then packages that target's `.vsix` and checks what is inside it |

Every target is built and tested on a machine of its own architecture, because
the CPython shim can only be compiled where it runs. Each leg uploads its
`.vsix` as an artifact (`vsix-<target>`), which is where a release's Linux
packages come from — see the publishing steps.

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
the others alone, which is what lets one tree carry every target's shim. A
release ships three:

| Target | Shim directory | Built on |
| --- | --- | --- |
| `darwin-arm64` | `grail/prebuilt/arm64.Darwin/` | `macos-15` |
| `linux-x64` | `grail/prebuilt/x86_64.Linux/` | `ubuntu-latest` |
| `linux-arm64` | `grail/prebuilt/arm64.Linux/` | `ubuntu-24.04-arm` |

**You do not have to build these by hand.** CI builds each on a runner of that
architecture and uploads the resulting `.vsix` as an artifact, because a shim
can only be compiled where it runs — a Mac cannot produce the Linux ones. Build
locally only for the target you are sitting in front of.

Four places have to agree on that list, and
[`scripts/check-vsix.sh`](scripts/check-vsix.sh) fails loudly when they do not:

- `isSupportedPlatform()` in [`src/platform.ts`](src/platform.ts) — the runtime
  gate.
- the koffi `!` lines in [`.vscodeignore`](.vscodeignore) — one binary per
  supported platform, or the extension loads there and cannot find its FFI
  module.
- the `package:*` targets in `package.json` — a *platform-specific extension*,
  so the Marketplace serves each machine only the build that can work on it.
- the `case` in `check-vsix.sh` that says what each target must carry.

Check before packaging:

```sh
ls grail/prebuilt/     # expect the directories for the targets you are packaging
```

**Adding a platform is two coordinated steps, in this order:** build
`bundle:grail` on that platform so its shim is staged, *then* widen
`isSupportedPlatform()` and the three lists above. Widening the gate without the
shim produces a build that installs fine and fails at the first `import` — the
bug that predicate exists to prevent. Multiple targets are published as separate
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
2. `npm run lint && npm run format:check && npm run typecheck && npm run typecheck:strict && npm test`
3. Commit the version + changelog changes (e.g. `Release X.Y.Z: <summary>`).
4. `git tag -a vX.Y.Z -m "Release X.Y.Z"` — annotated tag, on the release commit.
5. `git push origin main` and let CI build the three packages. Each
   `integration` leg packages its own target, checks it, and uploads it as a
   `vsix-<target>` artifact. **No machine can build all three itself** — a
   shim only compiles on the platform it targets — so this is where the release
   artifacts come from, not from a local rebuild.
6. `npm run release:fetch` — downloads that run's three packages into `dist/`
   and re-runs `check-vsix.sh` on each. With no argument it insists on a
   successful run for **your HEAD commit** and refuses artifacts whose version
   disagrees with `package.json`; publishing an older run's packages under a new
   version number is the mistake it exists to catch. Pass a run id to override.
7. **Install `dist/gemdb-darwin-arm64-X.Y.Z.vsix` and run it once** before
   publishing. The automated check proves the payload is present, not that it
   works, and only running it exercises the shim against the engine. For the
   platforms you cannot run, CI's integration suite did exactly that — started a
   real database and imported Python through the shim it had just compiled —
   which is the closest thing to a first run a machine you do not own can give
   you.
8. `npm run publish` — `vsce` then `ovsx`, both publishing the **downloaded**
   packages (`--packagePath dist/*.vsix`), so what reaches the Marketplace is
   byte-for-byte what CI tested. Both use `--skip-duplicate`, so if the Azure
   DevOps Gallery API times out mid-way (it happens), simply re-run: the targets
   that already landed are skipped instead of failing the command.
9. `git push origin vX.Y.Z` — the tag does not piggyback on the branch push.

> **Tokens.** `vsce` reads `VSCE_PAT` and `ovsx` reads `OVSX_PAT`. Prefer
> supplying them for the one command that needs them rather than exporting them
> from a shell profile: `vsce`'s own `--help` prints the value of `VSCE_PAT` as
> the default for `--pat`, so an exported token ends up in help output, terminal
> scrollback, and anything capturing it.

### Credentials

You must be logged in with Personal Access Tokens for both registries:

```sh
npx @vscode/vsce login gemtalksystems                # VS Code Marketplace
npx ovsx create-namespace gemtalksystems -p <token>  # Open VSX (one-time; already done)
```

`ovsx publish` reads `OVSX_PAT` from the environment (or a stored token). The
Marketplace token is an Azure DevOps PAT with **Marketplace → Manage** scope,
issued from the organization that owns the publisher.

Keep both out of your shell profile. `vsce login` stores the Marketplace token
in the OS keychain, which is the safer place for it, and a token needed only for
`ovsx` can be supplied for that one command:

```sh
OVSX_PAT="$(security find-generic-password -s ovsx-pat -w)" npm run publish:ovsx
```

An exported `VSCE_PAT` leaks in a way that is easy to miss: `vsce`'s `--help`
renders it as the default value of `--pat`, so it appears in help output and
terminal scrollback, and from there in anything that captures them.

### What ships in the `.vsix`

`.vscodeignore` decides. `scripts/check-vsix.sh` asserts the table below against
a packaged `.vsix`, and `npx vsce ls` shows the full list. The payload is
dominated by a few things that **must** be there:

| Path | Why |
| --- | --- |
| `out/extension.js` | the extension bundle |
| `out/gemdb-shell.js` | the GemDB Shell, staged to `<rootPath>/bin` at run time |
| `grail/` | the Python runtime, plus a compiled shim per supported platform |
| `extent/gemdb.dbf` | the preloaded database — portable, so one file serves every target |
| `resources/setSharedMemory*.sh` | what the `sudo` prompt runs; Linux packages also need `setRemoveIPC.sh` |
| `node_modules/koffi/` | the native FFI addon; it is a runtime `dependency`, not bundled, because it loads its own platform binary at run time |

Every package carries all three shims and all three koffi binaries rather than
only its own. Together that is about 4 MB before compression, against the
alternative of pruning the tree per target — a move-and-restore dance around
build artifacts, for a fraction of the payload. `check-vsix.sh` asserts each
package holds *its own* shim and koffi binary, which is the part that matters:
`vsce package --target linux-x64` will happily package a tree that has never
built a Linux shim.

Sources, tests, and tooling are excluded. `README.md`, `CHANGELOG.md`,
`LICENSE`, and `NOTICE` ship — the first two become the Marketplace's Overview
and Changelog tabs.

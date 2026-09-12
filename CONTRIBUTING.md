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

Neither job publishes anything. Publishing is
[`.github/workflows/release.yml`](.github/workflows/release.yml), dispatched by
hand and held at a required-reviewer gate — and it builds nothing, because the
packages it publishes are the ones this workflow uploaded. See
[Publishing a release](#publishing-a-release).

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
bug that predicate exists to prevent. Each target is published as its own
`.vsix`, one `vsce publish --packagePath` per package, so the Marketplace can
serve each machine only the build that works on it.

`bundle:extent` creates a scratch database, files Grail into it, and stages the
result as `extent/gemdb.dbf`. Unlike the shim, the extent is portable across
platforms — build it once per release. A `.vsix` built without it still works,
falling back to filing Grail in on first use.

## Publishing a release

GemDB Code is published to both the **VS Code Marketplace** and **Open VSX**,
under the same `gemtalksystems` publisher as Jasper, as three platform-specific
packages.

A release is two steps: a **release pull request** you write, and the
**Release workflow** you dispatch. The split is on what needs judgement.
Promoting `[Unreleased]` to a dated section, and sweeping `main` for changes
that never wrote a changelog entry, are editorial calls. Everything after that
is mechanical, and the mechanical half is where the mistakes that cost a
version number live.

### 1. The release pull request

```sh
npm version <X.Y.Z> --no-git-tag-version
```

That bumps `package.json` and the two root fields in `package-lock.json`
atomically. Don't hand-edit these or find-and-replace the version across the
lockfile: the version string can collide with an unrelated dependency's own
version elsewhere in the file and corrupt that entry.

Then promote `[Unreleased]` in `CHANGELOG.md` to a dated `## [X.Y.Z] -
YYYY-MM-DD` heading, leave `[Unreleased]` empty, and update the link
definitions at the bottom. `npm run release:notes X.Y.Z` prints exactly the
text that will become the GitHub Release notes, which is the cheapest way to
see the section the way a reader will.

Open it as an ordinary pull request and let CI run. **The CI run on the merge
commit is where the release's packages come from**, so it has to be green for
the commit you are going to publish — not merely for the branch.

### 2. The Release workflow

Actions → **Release** → *Run workflow*, against `main`, with the version. Tick
**dry-run** the first time: it runs validate → collect → scan, creates nothing
and publishes nothing, and costs a couple of minutes.

```
validate ──▶ collect ──▶ scan ──▶ gate ──▶ release ──┬──▶ publish-vsce ──┐
                                                     │                   ├──▶ verify
                                                     └──▶ publish-ovsx ──┘
```

The order is the design, and it follows one rule: **publishing to a registry is
the only irreversible step**. Both registries are immutable per
`(publisher, name, version, targetPlatform)` — even deleting a version leaves
the identity reserved — so a botched publish burns `X.Y.Z` permanently and the
recovery is always `X.Y.Z+1`, never a retry. Everything cheap and repeatable
therefore happens first.

**`collect` does not build.** This is the one way the pipeline differs from
what you would write for an ordinary extension, and it is not a shortcut. No
runner can produce GemDB's three packages: the CPython shim only compiles on
the architecture it targets. And `bundle:grail` clones Grail's *default
branch*, so a rebuild at release time would assemble a payload from whatever
Grail is today rather than from what CI tested — a different artifact wearing
the same version number. So `collect` downloads the `vsix-<target>` artifacts
from the CI run for that exact commit and re-runs `check-vsix.sh` on each. It
is `scripts/fetch-vsix.sh` as a job, and it enforces the rule this repo has
followed by hand since 1.2.0.

**The reviewer approves artifacts, not a promise.** `gate` is a do-nothing job
whose entire content is the `release-approval` environment, and it sits *after*
the packages have been collected, checked and scanned. The credentialed
environments wrap only the two publish jobs, so approving a release does not
hand anything else a token.

**The GitHub Release is the source of the bytes.** `release` tags the commit,
attaches all three packages, and both publish jobs download *those files* and
publish them with `--packagePath`. What CI built, what the Release carries and
what each registry serves are the same objects.

**The two registries are independent**, and so are the three targets within
each. Separate jobs per registry, each holding only its own token; and
`scripts/publish-to-registry.sh` publishes one package at a time, so a failure
on `linux-arm64` neither hides the `darwin-arm64` result nor leaves
`linux-x64` unattempted. It also classifies the outcome: a package that is
already up — including the "already published, but currently isn't active"
spelling that `ovsx --skip-duplicate` mishandles — counts as success, so a
re-run after a partial failure finishes the release instead of failing on the
half that landed.

**`verify` reports and does not gate.** By the time it runs, the tag, the
Release and all six uploads exist. `scripts/await-published-version.sh` waits
for three targets on two registries to become queryable, which takes anywhere
from a couple of minutes to some tens of minutes. Nothing depends on it, so a
slow registry is a signal to go and look rather than a broken release.

### What the workflow refuses to do

`validate` checks nothing out — every check is an API read, and the files it
inspects are data, never executed. It requires: the repository is
`GemTalk/GemDB_Code`; the dispatch is from the default branch; `package.json`
is at the requested version; `CHANGELOG.md` has a dated `## [X.Y.Z] -
YYYY-MM-DD` section **and an empty `[Unreleased]`**; no `vX.Y.Z` tag exists;
the **newest** `ci-complete` on that exact commit concluded `success`; and a
CI run for that commit **still holds all three packages**.

That last one is the check most likely to stop you, and the fix is not in this
repository. CI keeps a release's packages for 90 days (7 for a branch or a
dispatch); past that, re-run CI on the release commit — Actions → CI → that
run → *Re-run all jobs* — and dispatch again once it is green.

`collect` then adds the check `validate` cannot make. With no checkout,
`validate` can only ask whether a dated heading exists; rendering the notes is
a stricter question, because `changelog-section.sh` also requires the section
to have a body. So `collect` runs the real script and throws the output away.
Without that, a dated but empty section passes validation, survives the scan,
is approved at the gate, gets tagged — and fails on the step *after* the tag,
which is the one failure in this pipeline that leaves cleanup behind.

The release deliberately does not re-run lint, the typechecks or either test
suite. CI already ran them on that commit, including the integration suite
against a real database on each of the three architectures, which is a stronger
gate than one run here could be.

### The secret scan

Open VSX runs a gitleaks-based scan **server-side, after accepting the
upload**, with no way to allow a false positive — and by then the version
number is spent. Jasper has been rejected that way twice, each time failing
only the Open VSX half after the Marketplace had already published. `scan`
unzips each package and scans **its contents**, with the rules and the reasoning
in [`.gitleaks.toml`](.gitleaks.toml).

Scanning the package rather than the working tree matters more here than
almost anywhere: `out/`, `grail/`, `mcp/` and `extent/` are all gitignored
build artifacts, so nearly everything GemDB ships is invisible to a scan of
git.

Two things in that config are worth a reviewer's eye. `extent/gemdb.dbf` is
allowlisted by path, because it carries key material that is the vendor's and
is in every GemStone extent — verified against the engine's own
`bin/extent0.dbf`. And `gemstone-password-literal` is a custom rule restating
what Open VSX runs and gitleaks' defaults do not; it is what caught the two
Grail development scripts this repo used to ship, which are now excluded from
the package rather than allowlisted.

### Before the first real run

**The workflow is not safe until step 2 exists.** GitHub creates a referenced
environment implicitly with no protection rules, so without required reviewers
the `gate` job approves itself.

1. Three **environments**, so none holds more privilege than its job needs:
   `release-approval` (**no secrets**), `release-vsce` (`VSCE_PAT` only),
   `release-ovsx` (`OVSX_PAT` only).
2. **Required reviewers** and **prevent self-review** on `release-approval`.
3. A **deployment branch policy** restricting all three to `main` — the
   backstop that does not depend on the workflow's own checks being right.
4. Each token as an **environment** secret, not a repository secret.

This is governance as much as configuration: **the repository stores no
third-party secrets today**, only the automatic `GITHUB_TOKEN`. These would be
the first, and each is one person's identity acting for the organization. Note
also that Azure DevOps **retires global PATs on 1 December 2026**, after which
Marketplace PAT publishing stops working and this needs `vsce publish --oidc`
(`id-token: write` plus a policy registered on the registry).

### If something goes wrong

- **Before `release`** — nothing has happened. Fix and dispatch again.
- **A publish job failed** — read `scripts/publish-to-registry.sh`'s verdict
  first. `already-published` and `awaiting-activation` are successes. A genuine
  failure means that target's identity may or may not be spent; check the
  registry's own page, and **do not republish the same version**. Use
  *Re-run failed jobs*, never *Re-run all jobs* — the latter fails on the
  artifact name by design, because a re-run must not be able to substitute
  different bytes for the ones that were approved.
- **`verify` timed out** — the release is done. A registry is either still
  activating a package or has rejected it, and the public API answers the same
  404 for both; go and look at the registry.

### The manual fallback

Still supported, and still the only route if GitHub Actions is unavailable. It
is the same sequence by hand:

```sh
npx @vscode/vsce verify-pat gemtalksystems   # check the token FIRST
npm run release:fetch                        # CI's packages -> dist/, each re-checked
# install dist/gemdb-darwin-arm64-X.Y.Z.vsix and run it once
npm run publish:vsce
npm run publish:ovsx
git tag -a vX.Y.Z -m "Release X.Y.Z" && git push origin vX.Y.Z
```

`verify-pat` first is not ceremony. Azure DevOps tokens expire after at most a
year and the failure is a bare `401` from the publish step — which on 1.1.0
arrived after the version was bumped, the changelog promoted, the commit made,
the tag cut and CI run, stopping the release dead and half-published, needing a
token only a human could issue. The pipeline runs the same check for the same
reason.

`release:fetch` with no argument insists on a successful run for **your HEAD
commit** and refuses artifacts whose version disagrees with `package.json`;
publishing an older run's packages under a new version number is the mistake it
exists to catch. Pass a run id to override.

**Install one and run it once.** The automated checks prove the payload is
present, not that it works, and only running it exercises the shim against the
engine. For the platforms you cannot run, CI's integration suite did exactly
that — started a real database and imported Python through the shim it had just
compiled.

### Credentials

The pipeline reads `VSCE_PAT` and `OVSX_PAT` from the two publish environments.
For the manual fallback you need them locally:

```sh
npx @vscode/vsce login gemtalksystems                # VS Code Marketplace
npx ovsx create-namespace gemtalksystems -p <token>  # Open VSX (one-time; already done)
```

The Marketplace token is an Azure DevOps PAT with **Marketplace → Manage**
scope, issued from the organization that owns the publisher. Reissuing one
(User settings → Personal access tokens in Azure DevOps) has two settings that
must be right, and getting either wrong produces the same uninformative `401`
as an expired token:

- **Scopes: Marketplace → Manage.** Acquire and Publish alone are not enough.
- **Organization: All accessible organizations.** A token scoped to a single
  organization is rejected, which is the surprising one — the publisher is a
  Marketplace entity rather than an organization-level resource.

Then `npx @vscode/vsce login gemtalksystems` to store it in the keychain, and
`verify-pat` to confirm before relying on it.

Keep both out of your shell profile. `vsce login` stores the Marketplace token
in the OS keychain, which is the safer place for it, and a token needed only
for `ovsx` can be supplied for that one command:

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

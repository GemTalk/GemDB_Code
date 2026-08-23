# Reaching Windows

GemDB 1.x runs on Apple Silicon macOS and on Linux, x86-64 and ARM. Windows is
the obvious gap, and the obstacle is not the extension — it is that **there is
no GemStone/S 64 server for Windows**. Any Windows story therefore puts the
database on Linux somewhere and decides where the seam falls.

This document records the options, what was measured rather than assumed, and
the recommended order of work. It also covers the Docker question, because the
same machinery that reaches Windows reaches Intel Macs and hosted servers.

Status: **design notes, nothing implemented.** Claims are marked as measured
where they were checked on 2026-08-22 against the 3.7.5 kits and this
repository, and as unverified where they still need a Windows machine.

## What is actually platform-specific

Very little, and knowing exactly which little is what makes this tractable.

| Component | Portable? |
| --- | --- |
| `out/*.js`, the extension and shell bundles | Yes — plain JS |
| `extent/gemdb.dbf` | Yes — extents are portable across platforms at a given engine version |
| Grail's Python sources | Yes |
| koffi | Prebuilt by upstream for 18 platforms, including `win32_x64` (measured) |
| **Grail's CPython shim** | **No** — compiled against one engine version on one platform |
| **The engine itself** | **No server build exists for Windows** (measured: the catalog 404s for `i386.Windows_NT` and `x86_64.Windows_NT` at 3.7.5) |

The shim matters less than it first appears: it loads **gem-side**, inside the
database process. Wherever the server runs, the shim is that platform's shim,
and Linux shims are what CI already builds and tests.

## The finding that reshapes the options: a Windows GCI client exists

GemTalk publishes a Windows **client** kit even though it publishes no Windows
server (measured, 3.7.5, 26.8 MB):

```
https://downloads.gemtalksystems.com/pub/GemStone64/3.7.5/GemStone64BitClient3.7.5-x86.Windows_NT.zip
  bin/libgcits-3.7.5-64.dll      <- the thread-safe GCI library GemDB loads
  bin/libgcirpc-3.7.5-64.dll
  bin/libssl-3.7.5-64.dll
  bin/topaz.exe                  <- RPC only; no linked gems without a server
  include/…
```

Three things line up with what GemDB already does:

- `session.ts` computes `libgcits-<version>-64.<ext>` — the same name modulo
  the extension (measured).
- The vendored GCI layer was evidently written against this DLL: it documents
  what is *absent* there — `GciTsNbLogin`/`GciTsNbLoginFinished` and the
  post-3.6.2 debug functions — and treats them as optional with a blocking
  login fallback (measured, `src/gci/gciLibrary.ts`).
- Every GCI function `session.ts` calls is outside that absent set (measured):
  `GciTsLogin`, `GciTsNbExecute`, `GciTsNbResult`, `GciTsNbPoll`, `GciTsBreak`,
  `GciTsClearStack`, `GciTsContinueWith`, `GciTsContinueWithAsync`, the
  fetch/new family, `GciTsCommit`, `GciTsReleaseObjs`, `GciTsLogout`,
  `GciTsCallInProgress`.

So on paper the whole evaluation stack — sessions, `pythonQueries`, the
notebook kernel, the GemDB Shell — can run **natively on Windows**, talking RPC
to a stone on Linux. "On paper" is load-bearing; see [Unverified](#unverified).

## The seam, and why it makes WSL vs Docker a late decision

Split the work by how often it happens:

- **Data plane — constant.** Every notebook cell, every keystroke in the shell,
  every streamed `print()` and `input()` round-trip. This is already remote:
  `gcits` is RPC-only (there is no linked mode — measured previously), and
  login goes through NetLDI. Pointing it at a stone in a VM or container is a
  login string, not an architecture.
- **Management plane — rare.** Install the engine, create the database, start
  and stop, `gslist`. This needs exactly one primitive: *run a command in the
  Linux*. That is `wsl.exe -e …` or `docker exec …`.

Design the management layer against that one primitive and WSL and Docker
become two thin backends of the same interface, so the default on Windows can
be chosen late, from measurements.

### What Jasper's WSL support cost, for calibration

Jasper routes **everything** through `wsl.exe`: filesystem reads, process
spawns, terminals, each with path translation. Measured: WSL awareness touches
20+ non-test files — `wslFs.ts`, `processManager.ts`, the tree providers,
backup/restore — roughly 9,000 lines of files that must know about it.

GemDB should be far cheaper, for a reason that is about product scope rather
than cleverness: most of Jasper's WSL surface exists to manage *many* stones,
versions, backups and processes from the Windows side. GemDB hides all of that
— one stone, fixed names, no version picker. Its management surface is a
handful of commands, and only those cross the seam.

## The options

### 1. WSL window (VS Code's own remote) — free, works today

Microsoft's WSL extension runs the **extension host inside WSL**. In a WSL
window, the Marketplace installs our published `linux-x64` build and everything
is simply itself: koffi loads its Linux binary, `install-engine.sh` fetches
`x86_64.Linux`, the shim is our tested Linux shim, terminals are Linux
terminals. There is no seam because there is no boundary.

Cost is the user's first run: `wsl --install`, the WSL extension, open a WSL
window. Real friction, but Microsoft's, already paid by anyone doing Python or
Docker work on Windows — versus a second process-management layer we own
forever.

### 2. Native Windows client + server on Linux — better UX, real work

Using the client kit above: notebooks and the shell run natively on Windows,
panels and terminals are native, the database lives in WSL (or a container, or
a remote host). Better than option 1 for a Windows-native user, and — given the
seam above — plausibly a few hundred lines rather than Jasper's thousands.

Known gap: `gemdb file.py` is built on a **linked** topaz gem (the process's
stdin *is* Python's stdin, and exit status travels via `GEMDB_STATUS_FILE`).
The Windows `topaz.exe` is RPC-only, so file mode needs rethinking there —
most likely routing files through the Node shell bundle instead of topaz.

### 3. Docker as the server backend — the one that also helps elsewhere

Not primarily a Windows answer; it is attractive because **we would control the
image**, and because two of GemDB's sharpest UX edges vanish inside a
container:

- shared memory becomes `--shm-size=1g` on the run command, and
- RemoveIPC is meaningless in a container.

Those are the two `sudo` prompts that CLAUDE.md's automation line spends the
most words defending. Removing both is a bigger first-run win than the download
it might also save.

It is also one mechanism covering Windows *and* Intel Macs (extension host
native, server `linux/x86_64`), and it is buildable and testable on an Apple
Silicon Mac today.

Costs and one concrete technical item:

- Docker Desktop licensing at larger companies; on Windows it requires WSL2
  underneath, so it is strictly *more* installed software than WSL alone.
- Extents need a volume to outlive containers.
- **NetLDI spawns gems on dynamic ports, and Docker forwards only ports
  published at `run` time.** So NetLDI must be started with a fixed port range
  and that range published. WSL2's localhost forwarding has no such problem.

### 4. Remote-SSH, Remote Tunnels, Codespaces — zero work, available now

All three run the extension host on Linux, so our existing `linux-x64` build
works unchanged. Remote-SSH to any Linux box is also the honest version of
"cloud-hosted GemStone" — a small VPS or a machine in the office, with no
accounts, billing, or data-residency questions for us to answer. A
`devcontainer.json` is what makes Codespaces work, and is the legitimate Docker
flavour of the same idea (extension *inside* the container).

A managed cloud GemStone is a genuine product direction but changes what GemDB
is, and GCI's chattiness — every `print()` and `input()` is a client round-trip
— would make a high-latency link noticeably worse than a local VM.

## The `gemdb` command through a backend

A VS Code terminal can be any command; Jasper already uses `shellPath:
'wsl.exe'`. So "Open GemDB Shell" becomes `wsl.exe -e <rootPath>/bin/gemdb` or
`docker exec -it <container> gemdb`. The two modes differ:

- **File mode works as-is.** Both `docker exec -i` and `wsl.exe -e` forward
  stdin and propagate exit codes, which is exactly what linked-gem stdin and
  the status-file exit code need. No rework, provided the *server side* is
  Linux (where topaz can run linked gems).
- **The REPL can go either way.** Inside the Linux it is our staged bundle
  unchanged — but it is a Node program, and while a Docker image we control
  simply includes Node, a stock WSL distro does not (the wrapper's recorded
  `process.execPath` would be the Windows Electron, which cannot run inside
  WSL, and the PATH fallback finds nothing). Natively on Windows it is a pure
  GCI client and should work with the DLL. Ship the inside-Linux flavour first;
  the native shell belongs with the native notebook client.

## Publishing an image

### The decision that matters is what goes *in* it

`NOTICE` currently states a deliberate posture:

> The GemStone/S 64 Bit database engine is downloaded from GemTalk Systems at
> install time under its own license terms, which are presented by the engine's
> own installation and are not granted by this extension.

Baking the engine into a published image inverts that: we become the
distributor, and a `docker pull` presents nobody with a license. GemTalk owns
GemStone, so this is a decision GemTalk can make — but it should be a decision,
with a NOTICE rewrite and probably an acceptance step, not a side effect of
writing a Dockerfile. (The line is already less absolute than it reads:
`extent/gemdb.dbf` derives from the engine's own `extent0.dbf` and ships in
every `.vsix` today.)

**A thin image keeps the posture and most of the prize.** Base OS, Node, our
scripts; `install-engine.sh` runs on first start into a volume, exactly as the
extension does today. The engine still comes from GemTalk under GemTalk's
terms, the image stays small and cheap to rebuild — and both `sudo` prompts
still disappear, because that came from the container, not from its contents.
What a fat image adds is only the 210 MB download and a few minutes of install.

Recommendation: **prototype thin**; treat fat as a separate product decision.

### Registry: GHCR

- **Pull limits decide it.** Docker Hub allows 100 anonymous pulls per 6 hours
  **per IPv4 address or IPv6 /64** (200 authenticated free; unlimited only on
  paid plans — measured 2026-08-22). For an extension that issues the pull
  itself, an office behind one NAT shares that budget and the failure lands on
  the user as a mysterious first run. GHCR publishes no comparable limit for
  public packages, and public storage and bandwidth are free.
- **Precedent and provenance.** Grail already publishes `ci-base` to GHCR. The
  image would be built and pushed by the same workflow that tests the
  extension, from the same commit, with public logs; visibility inherits from
  the repo.
- **Multi-arch fits our CI.** `ubuntu-latest` and `ubuntu-24.04-arm` build
  `linux/amd64` and `linux/arm64` natively and merge into one manifest list —
  no emulation.

Docker Hub's advantage is discoverability (`docker pull gemdb` resolves only
there), which matters little when the extension issues the pull. Mirroring
later is cheap.

**Price in the maintenance stream.** A user-facing image is not Grail's CI
image: base-layer CVEs accumulate whether or not the engine changes, users'
scanners will notice, and that implies scheduled rebuilds and a tag policy
separating extension version from engine version. Another point for thin.

## Recommendation

1. **Ship the WSL-window path first.** Full functionality, no new code, our
   published `linux-x64` build. Needs one smoke test on real hardware and
   README/Marketplace text. Note that because we publish no `win32-x64`
   package, a plain-Windows user is told the extension is unavailable and never
   sees in-product guidance — so the README text is the whole user-facing fix
   until step 3.
2. **Prototype the Docker server backend on macOS.** It derisks what is common
   to every later option — RPC to a non-local NetLDI, the gem port range
   through published ports, forwarders over a real network boundary, `docker
   exec` as the management primitive, the image build — and may graduate from
   scaffolding to a shipped mode. Decomposes into: a Dockerfile (engine via
   `install-engine.sh`, extent, Grail, Node, NetLDI on a fixed port range), a
   `session.ts` login string that accepts a host, and a smoke test from the
   Mac-native extension host: notebook cell, streamed print, `input()`,
   interrupt.
3. **Then consider the native Windows client build.** Best Windows experience,
   needs Windows hardware to validate, and can reuse the management seam built
   in step 2.

Optionally, a `win32-x64` **pointer build** — a tiny targeted package with no
engine bits whose only behaviour is a welcome view walking the user into WSL.
That is compatible with the "refuse where it cannot work" principle because it
redirects rather than pretending. Step 3 supersedes it.

## Unverified

Everything here needing hardware we do not have, in rough order of risk:

- **Windows, needs a machine.** That `libgcits-3.7.5-64.dll` loads under koffi
  with `libssl` beside it; that `GciTsContinueWithAsync` is exported there;
  that NetLDI's dynamically-assigned gem ports survive WSL2 localhost
  forwarding. The cheap decisive experiment: unzip the client kit, point a
  small koffi script at the DLL, log in to a stone in WSL2, run one
  `GciTsNbExecute`/`GciTsBreak` cycle.
- **WSL2 behaviour.** Shared-memory defaults (modern kernels default `shmmax`
  high enough that the prompt may never fire); the VM lifecycle, where `wsl
  --shutdown` or a Windows reboot is a power-failure stop rather than a clean
  one (tranlogs cover it; worth documenting); systemd and `RemoveIPC`, since
  recent WSL runs systemd by default.
- **Docker.** Whether the published gem port range works as expected, and
  whether extent-on-a-volume performs acceptably.

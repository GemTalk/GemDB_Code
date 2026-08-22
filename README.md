# GemDB

Write Python. Run it inside the database.

Install from either marketplace:

- **VS Code Marketplace:** https://marketplace.visualstudio.com/items?itemName=gemtalksystems.gemdb
- **Open VSX** (VSCodium, Gitpod, code-server, etc.): https://open-vsx.org/extension/gemtalksystems/gemdb

GemDB is a VS Code extension that installs a database which executes Python
natively — not Python that talks to a database over a connection, but Python
whose objects *are* the database's objects. Assign to a variable, commit, and
it is still there tomorrow.

```python
import gemstone

gemstone["routes"] = load_routes()
gemstone.system.commit()
```

## Getting started

Install the extension. There is no second step.

On first activation GemDB downloads the database engine (about 210 MB), unpacks
it, and creates one database under `~/GemDB` with Python support already in it.
You can cancel; it resumes from where it stopped, and it won't ask again.

While that downloads, it asks for your password once, to raise the machine's
shared-memory limit. That is the only prompt, and the only change GemDB makes
outside `~/GemDB`.

Then open the **GemDB Shell**, or a notebook with **GemDB** as the kernel. The
database is already running — GemDB starts it for you.

### What GemDB asks for, and what it doesn't

Everything in the automatic step lands inside `~/GemDB` and is undone by
deleting that directory, so none of it is worth interrupting you for. Two
things are not like that, and they are treated differently from each other:

- **Raising shared memory** needs `sudo` and changes the machine for all
  software, permanently — so it is asked for, out loud, while the engine
  downloads. That is where a permission prompt is least surprising and most
  likely to be answered: you have just installed something, you are watching it
  configure itself, and you are waiting anyway. GemDB opens a terminal so you
  see and answer the prompt yourself; it never handles your password. Decline
  and nothing breaks — the panel keeps showing what is needed, and GemDB asks
  again when it actually blocks running Python. It is reversible without a
  restart — `sudo ./scripts/unset-os-config.sh` takes the setting back off, and
  says whether anything else on the machine is still raising it.
- **Starting the database** creates processes that outlive the editor, so GemDB
  is careful with it in a different way. It starts the database for you, so your
  first notebook cell doesn't wait — but if you stop it yourself, it stays
  stopped until you start it again or run some Python. Whenever it is running
  the status bar says so, and clicking that stops it. GemDB will not silently
  restart something you turned off.

## The `gemdb` command

Setup also writes a shell command to `~/GemDB/bin/gemdb` that behaves like
CPython's command line, backed by the database:

```sh
export PATH="$HOME/GemDB/bin:$PATH"   # once, in your shell profile

gemdb hello.py          # like python3 hello.py
gemdb -m some.module    # like python3 -m
gemdb -c 'print(1+1)'   # like python3 -c
gemdb                   # the GemDB Shell
```

It needs no environment set up — the wrapper carries its own — and if the
database is not running it starts it, the same judgement the editor makes.
Exit codes work the way scripts expect: 0 on success, 1 on an uncaught
exception (with the error on stderr), 2 for a missing file, and `sys.exit(n)`
exits with `n`, exactly as CPython would.

`input()` works everywhere — a script reads stdin, the GemDB Shell reads its
own prompt line (Ctrl+C answers `KeyboardInterrupt`, Ctrl+D `EOFError`), and a
notebook cell opens an input box. And `print()` streams: output reaches the
terminal or the notebook cell while the code is still running, not in one
block when it finishes.

`gemdb` with no arguments opens the **GemDB Shell** — the very same prompt the
editor's "Open GemDB Shell" opens, because that button simply runs this command
in a terminal. History, line editing, a Ctrl+C that interrupts the running code
(and reports it as `KeyboardInterrupt`), errors that return you to `>>>`, and
`exit()` or Ctrl+D to leave: identical in both places, because it is one
program.

## What GemDB is not

GemDB is deliberately small. It manages exactly one database, with a fixed
name, on a fixed version, and gives you no way to change any of that. There is
no version picker, no database list, no login manager, no process view.

If you want those — if you are administering GemStone/S rather than writing
Python against it — use
[Jasper](https://marketplace.visualstudio.com/items?itemName=GemTalkSystems.gemstone-ide),
which exposes the full control surface. GemDB and Jasper can coexist; GemDB
keeps its files under `~/GemDB` and names its processes distinctly so the two
do not collide.

## Platform support

**This release runs on macOS with Apple Silicon (M1 and later) and on Linux,
x86-64 or ARM.** On a Mac, use the Apple Silicon build of VS Code; an Intel
build running under Rosetta is refused, because its extension host is an x86_64
process.

| Platform | Status |
| --- | --- |
| macOS, Apple Silicon | Supported |
| Linux, x86-64 | Supported |
| Linux, ARM64 | Supported |
| macOS, Intel | Not planned — see below |
| Windows | Further out — see below |

The limit is one specific thing, not a general lack of portability: GemDB ships
the Python runtime with a native library compiled against a specific database
engine version *on* the platform it targets. A build missing the right one would
install perfectly and then fail at your first `import`, so the extension is
published per-platform and simply is not offered where it cannot work. Every
supported platform above is built and tested on a machine of that architecture
on each change.

Intel Macs are the gap, and an honest one: the database engine is published for
them, and the code handles them, but nobody here has an Intel Mac to build and
test that library on. If you want one, say so in an
[issue](https://github.com/GemTalk/GemDB_Code/issues) — it is a build we do not
currently have a machine for, not a port.

Windows is the exception that is genuinely further out. The engine and GemDB's
native components both need a Unix environment, so reaching Windows means
routing everything through WSL, as [Jasper](https://github.com/GemTalk/Jasper)
does — a meaningful amount of machinery for an extension whose whole point is a
short first run. It is a planned step, not an oversight.

## Where things live

Everything GemDB creates is under one directory, `~/GemDB` by default
(`gemdb.rootPath`):

| Path | What it is |
| --- | --- |
| `GemStone64Bit<version>-<platform>/` | the database engine, as downloaded |
| `db/` | your database — the only irreplaceable part |
| `grail/` | the Python runtime library and native shim |
| `locks/`, `log/` | engine bookkeeping |

The default is `~/GemDB` rather than `~/Documents/GemDB` on purpose: `~/Documents`
is commonly synced to iCloud Drive, and letting a sync daemon copy a live
database extent out from under the engine will corrupt it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `gemdb.rootPath` | `~/GemDB` | where GemDB keeps everything |
| `gemdb.engineVersion` | *(empty)* | override the pinned engine version; for development against unreleased builds |
| `gemdb.reinstallPythonOnUpdate` | `true` | refresh Python support in your database when a GemDB update ships a newer one |

## Building it

```sh
npm install
npm run bundle:grail    # assemble the Python payload (needs a C toolchain)
npm run bundle:extent   # build the preloaded database (needs an engine + shared memory)
npm run bundle          # compile the extension
npm run package         # produce the .vsix
```

Two build artifacts make the shipped extension self-sufficient, and both are
gitignored rather than committed.

`bundle:grail` clones [Grail](https://github.com/GemTalk/Grail) — the Python
implementation that runs inside the database — compiles its CPython shim
against the pinned engine, and stages the result under `grail/`. The compiled
shim is specific to **both** the platform and the engine version, so a full
release runs that script once per supported platform against the same working
tree; each run adds its own `grail/prebuilt/<platform>/` and leaves the others
alone.

`bundle:extent` then creates a scratch database, files Python support into it,
and stages the result as `extent/gemdb.dbf`. Every user's database begins as a
copy of that file, so the file-in runs once here rather than on each user's
machine. Unlike the shim, the extent is portable across platforms — build it
once per release.

Because both are snapshots, "the latest Python support" means "what was latest
when the extension was packaged". Re-run both when cutting a release; a `.vsix`
built without `bundle:extent` still works, but falls back to filing Python
support in on first use.

## Licence

MIT — see [LICENSE](LICENSE). GemDB reuses code from Jasper and bundles Grail,
both MIT and both from GemTalk Systems; see [NOTICE](NOTICE) for details. The
database engine is downloaded at install time under its own licence terms.

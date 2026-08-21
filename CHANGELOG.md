# Changelog

All notable changes to the **GemDB Code** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`input()` works everywhere.** A script run with `gemdb file.py` (or `-c`,
  or `-m`) reads the process's real standard input, exactly like `python3`. In
  the GemDB Shell, `input()` reads its own prompt line with the same line
  editing as the `>>>` prompt — Ctrl+C answers `KeyboardInterrupt` at the
  call (your `try/except` sees it), Ctrl+D answers `EOFError`, and anything
  typed ahead of the question becomes the answer. In a notebook, `input()`
  opens an input box; Escape or the cell's interrupt button cancels the read
  as `KeyboardInterrupt`. Built on a per-session stdin hook added to the
  Python execution engine.
- **`print()` streams.** Output reaches the GemDB Shell and the notebook cell
  as the code prints it, instead of arriving in one block when the evaluation
  ends — a long-running loop now shows its progress, and Ctrl+C still
  interrupts it mid-flow. (Scripts run with `gemdb file.py` always streamed;
  their output is the process's own stdout.)
- **`sys.exit(n)` exits with `n`.** Previously any `sys.exit` exited 1. The
  full CPython contract applies: `sys.exit()` and `sys.exit(None)` exit 0
  silently, an integer exits with that status (truncated to 0–255, so `-1`
  is 255), and anything else prints to stderr and exits 1.

### Changed

- **`gemdb` with no arguments now opens the GemDB Shell** — the same Python
  prompt the editor opens, instead of handing off to the Python
  implementation's own topaz prompt. Ctrl+C interrupts the running code and
  reports `KeyboardInterrupt`, `exit()` and Ctrl+D leave cleanly, and an
  uncaught Python error returns you to `>>>` instead of stranding you at
  `topaz 1>`. If the database is not running, the shell starts it.
- **"Open GemDB Shell" now runs that same command in a regular terminal.** One
  REPL implementation everywhere, and every shell is its own process — a crash
  or a stuck call in one can no longer affect the editor. One visible
  consequence: stopping the database while a shell is open now reports the
  shell's live session and offers to disconnect it, rather than logging it out
  silently.

## [1.0.0] - 2026-08-20

First public release. GemDB Code installs a database that runs Python, and then
gets out of the way.

### Added

- **A database that runs Python, set up without being asked.** On first
  activation GemDB downloads the database engine (about 210 MB), unpacks it, and
  creates one database under `~/GemDB` with Python support already filed in. A
  cancelled download resumes rather than starting over. Everything in that step
  lands inside the root path and is undone by deleting it, which is why none of
  it interrupts you.
- **One prompt, for the one change that leaves the root path.** Raising the
  machine's shared-memory limit needs `sudo` and changes the machine for all
  software, so it is asked for out loud — while the engine downloads, when you
  are already waiting and watching. GemDB opens a terminal so you answer the
  password prompt yourself; it never handles your password. Declining breaks
  nothing: the panel keeps showing what is needed and GemDB asks again when it
  genuinely blocks running Python.
- **The GemDB Shell.** A Python prompt that runs *inside* the database, as a VS
  Code pseudoterminal rather than an external process. Ctrl+C interrupts the
  running Python and returns you to the prompt, `exit()` or Ctrl+D leaves, and
  errors come back as Python errors. Each shell is its own database session, so
  opening a second one gives you two concurrent sessions with separate
  uncommitted state that see each other exactly at `commit()`. Full line editing
  — history, Home/End, Ctrl+A/E/K/U, and Delete.
- **Notebooks.** A notebook controller running cells through a shared session,
  with `print()` output and results shaped the way the shell shows them.
- **A `gemdb` shell command**, written to `~/GemDB/bin/gemdb`, that behaves like
  CPython's command line against the database: `gemdb file.py`, `gemdb -m`,
  `gemdb -c`. It carries its own environment, starts the database if it is not
  running, and reports exit codes the way scripts expect — 0 on success, 1 on an
  uncaught exception, 2 for a missing file.
- **Run Python File in GemDB**, from the editor title bar of any `.py` file.
- **A status bar entry and a tree view** that say whether the database is
  running, what engine and Python versions are installed, and what is still
  missing. Clicking the status bar stops the database.
- **A preloaded database extent.** A release ships a database, not just the code
  to build one, so Python works the moment the files are on disk rather than
  after a multi-minute file-in on first use.

### Known limitations

- **macOS on Apple Silicon only.** This release is published as a
  platform-specific extension (`darwin-arm64`), so the Marketplace does not
  offer it elsewhere, and the extension refuses to activate if sideloaded. The
  reason is Grail's CPython shim: a native library compiled against a specific
  engine version *on* the platform it targets, and a build missing the right one
  would install cleanly and then fail at the first `import`. Intel Macs and
  Linux are a build away — the code already handles them — and Windows is
  further out, needing WSL. Use the Apple Silicon build of VS Code; an Intel
  build under Rosetta is correctly refused.
- **`gemdb` with no arguments is not the GemDB Shell.** It hands off to Grail's
  own topaz REPL, which handles Ctrl+C, Ctrl+D, and Python errors differently:
  each drops you at a `topaz 1>` prompt with a Smalltalk stack rather than
  returning you to `>>>`. Line editing there is topaz's readline. Use the GemDB
  Shell inside the editor for the polished experience.
- **`sys.exit(n)` exits 1 rather than `n`**, and **`input()` is not yet
  supported**. Both are upstream in Grail.

[Unreleased]: https://github.com/GemTalk/GemDB_Code/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/GemTalk/GemDB_Code/releases/tag/v1.0.0

# Changelog

All notable changes to the **GemDB Code** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.8.0] - 2026-10-18

The database engine moves to GemStone 4.0.0.a5, and the bundled Python runtime moves forward. Start
with a fresh database: delete `~/GemDB/db` before starting this release. The new engine cannot use a
database an earlier one wrote, and GemDB Code says so rather than starting it.

### Added

- **Open a persisted object in the Persisted Objects view, with nothing paused.** Each entry under
  `gemdb.root` opens like a Variables row, with its type badges and its special, class and function
  variables folded, and what is inside it opens in turn. A committed entry is read by GemDB's own
  session, so it opens any time, in a new window, after a restart; one added and not committed yet
  is read by its notebook's session, while that notebook is not running a cell. A slow `__repr__` is
  cut off at two seconds, as in Variables. A saved stack still opens in the debugger instead.
- **Ranges for a long list in the Persisted Objects view.** A list or dict longer than 500 items
  opens to ranges of 500 — `[0 … 499]`, `[500 … 999]`, … — each opening to its items and nested for
  a very long one, as the Variables show them; nothing is read until a range is opened. When
  `gemdb.root` holds more than 200 entries, it says how many and shows them as ranges of 200.
- **Go to Item… in the Persisted Objects view.** Right-click a list, set or dict, or one of its
  ranges, and type a position (a negative one counts from the end; `[42]`, as the ranges write it,
  works too) or a dict's key — `'SKU0042'`, or just `SKU0042`, or `42` — and the view opens the
  ranges down to that item and selects it. For a dict a key is tried first; a number that is no key
  but is a position goes there and says so, and a key that isn't there says so and how keys are
  written.
- **`%pending` in the Debug Console: what the next commit writes.** At a pause, `%pending` lists
  every persisted object the notebook's transaction has changed, each by its path under `gemdb.root`
  (`gemdb.root["orders"][2]`), its type and its value now, with a link. Ctrl+click the link (as
  every Debug Console link is followed) and Persisted Objects opens the rows down to that object,
  ranges too, and selects it. VS Code asks once before it lets GemDB open its own links. The search
  for paths follows narrow, deep paths before big containers, so an object many attributes down is
  found even beside a list of thousands; one it can't find is listed as not found, without a link.
  Persisted Objects marks each changed object **M**, in the colour of a modified file: its
  description says what changes (`changed: total 10 → 15`, or how many entries changed, were added
  and were removed), its hover sets each changed entry's committed value beside the one the next
  commit writes, and a changed attribute or item inside it reads `10 → 15`. Right-click a marked row
  for **Revert to Committed Value**: after asking, it puts that entry, or the whole object, back as
  committed in the notebook's session — discarding the change, committing nothing — and the mark
  goes, and `%pending` no longer lists it: an object that reads exactly as committed again
  (reverted, or set to what it already held) is counted on one line, not listed, though the commit
  still writes it back unchanged. A value is put back only as a plain literal or as the committed
  object itself; a set, or a value over 2,000 characters, says it can't be reverted. The marks go
  once the notebook commits or discards its changes. Objects are matched by their permanent number,
  so a list that grew still finds the right item. Objects created since the last commit are written
  as part of the objects that now hold them. Objects outside `gemdb.root` — Grail's own records (its
  lists of a class's attribute names, its module cache) and storage inside a Python object, such as
  a big dict's buckets — are counted on one line, not listed.
- **Pending changes in Persisted Objects, with nothing paused.** Every notebook with uncommitted
  changes now has a row in Persisted Objects, with Commit and Abort, whether or not anything was
  added from the debugger. Under it, **Pending changes** lists what its next commit changes, as
  `%pending` does in the Debug Console. Click one to go to it under `gemdb.root`, where it is marked
  **M** and can be reverted.

### Changed

- **The database engine is GemStone 4.0.0.a5.** A database an earlier engine wrote cannot be used by
  this one: GemStone starts on it and then refuses every login, so GemDB Code checks first and says
  which folder to delete. Setup downloads about 170 MB on macOS and 470 MB on Linux, up from 145 MB
  and 450 MB, and still needs about 11 GB (12 GB on Linux) of disk.
- **A newer Python runtime.** 71 commits across 31 pull requests since 1.7.0. Class bodies behave as
  CPython's do: a class body now runs a `raise`, `assert`, `match`, or an `import` or `del` inside
  an `if`, which were skipped before, and a class whose body fails is not defined. `numpy.random`
  loads, `import uvicorn` works, `hashlib` adds `sha224` and `sha384`, and an abandoned generator
  runs its `finally` block. Some code CPython refuses is now refused here too: invalid `__slots__`
  raise `TypeError`, and `x *= y` raises when neither side supports it instead of storing
  `NotImplemented`. A `@property` now wins over an instance attribute of the same name, a coroutine
  is no longer a `GeneratorType`, and patching `json.dumps`, `math.sqrt` or `os.getcwd` now reaches
  the code that calls them.
- **Usage data also goes to Scarf.** The same usage events GemDB already sends now go to
  [Scarf](https://about.scarf.sh) as well, with fewer of VS Code's own properties. Turning telemetry
  off in VS Code turns off both. Scarf is not sent VS Code's machine id, so nothing it receives
  identifies your installation. [USAGE_DATA.md](USAGE_DATA.md) says what Scarf receives and how long
  it keeps it. It now also describes the Scarf image at the end of the README, which loads when the
  README is viewed, including on the extension's page, and how to block it.

### Fixed

- **Typing past the `%` in the Debug Console keeps GemDB's suggestions.** Typing `%` listed the
  commands, but typing on, as in `%p`, filtered every one of them out, leaving only the console's
  history. VS Code reads where a suggestion starts as a 0-based position, and GemDB sent it 1-based.
  The names suggested after `%persist ` and `persisted.` had the same fault.
- **An untitled notebook is called by its name.** GemDB named a notebook by the last part of its
  address, so an untitled one read `untitled:Untitled-1.ipynb?jupyter-notebook` wherever its session
  is named, and a file name with a space read `my%20notes.ipynb`. They now read `Untitled-1.ipynb`
  and `my notes.ipynb`.
- **Persisted Objects reads again when the database starts or stops.** Opened while the database was
  stopped, it kept saying "Start GemDB to see persisted objects." after Start until it was closed
  and opened again; it now follows the status panel, which sees every start and stop.
- **Closing the terminal ends a `gemdb` run.** Closing the terminal tab of `gemdb app.py`, or of
  **Run Python File in GemDB**, left the program running out of sight, holding a database session
  and, for a web app, its port. It is now stopped as Ctrl+C would stop it: its `finally` blocks run
  and its session is given back.

## [1.7.0] - 2026-10-16

The engine is unchanged at GemStone 4.0.0.a4, and the bundled Python runtime moves forward. Start
with a fresh database: delete `~/GemDB/db` before starting this release. Installing the new Python
runtime into a database an earlier release wrote leaves much of what it committed no longer
behaving as its type, so GemDB Code now asks before doing it.

### Added

- **The Debug Console and Watch work at a `breakpoint()` or red dot.** Type Python into the Debug
  Console and it runs in the frame selected in the Call Stack: its locals, closed-over names, its
  module's globals (an imported module's own, not the notebook's) and the builtins, as the paused
  line itself would see them. A result opens like a Variables row; `print()` shows in the console;
  names you bind (`y = 5`, `import json`, a `def`) last until the run resumes. An error reads as a
  Jupyter traceback, frame by frame with the line that raised marked. A line runs as long as it
  takes, and after a few seconds a notification offers to stop it; a watch keeps a two-second limit.
  Code the console calls runs straight past `breakpoint()` and red dots. Not yet: `cls` in a
  classmethod's frame, and rebinding a local (`n = 99`) changes the console's copy, not the paused
  function.
- **Show in Debug Console and Evaluate with self… on a Variables row.** Right-click any row, however
  deep in the tree, and **Show in Debug Console** opens the console with that object in it: an
  object with its attributes listed beneath, each by name; a list, set or dict, or an object with
  more than 20 attributes, as one row that opens like the Variables row. Its name is left at the
  console's prompt, or `_` bound to it for a row whose name means nothing there, such as a list
  item. **Evaluate with self…** asks for an expression and shows what it gives with `self` bound to
  the row's object, in the frame selected in Call Stack.
- **Variables shows each value's type, and opens objects whole.** Every row starts with its type,
  and a container's with its size too, as PyCharm shows them: `{Point} Point(3, 4)`,
  `{list: 3} […]`, `{list: 150}` for one too big to show. **Copy Value** copies the value alone,
  without the type. An object with attributes, its own or its class's, now opens on everything
  `dir()` lists: its own attributes, its class's, its properties (read through their getters) and
  its `__slots__`, which before did not open at all. Its methods are folded under **function
  variables** and its dunders under **special variables**, as in VS Code's Python debugger, so a
  class no longer buries its own methods under `__module__`, `__dict__` and the rest. A getter that
  runs past the time limit reads `<getter took too long>`, and the getters after it are not run.
  Modules now land under **module variables**; before, they were listed with the data.
- **Set Value in Variables.** Right-click a row while paused and choose **Set Value** to change a
  local, a global, an attribute, a list item or a dict entry. The value is a Python expression, and
  on any row it can use the notebook's globals, or a `.py` file's (`Point(1, 2)`, `g + 1`). In
  Locals it can use the frame's locals too (`n + 1`), and a local wins over a global of the same
  name. A statement such as `n = 5` is refused rather than stored as None. A local is written into
  the paused frame, so the run continues with it. What Python refuses is refused with Python's
  reason, such as a property with no setter. A method's receiver (`self`, or whatever the def calls
  it), a tuple's items, group rows and a saved stack's values cannot be changed, and VS Code does
  not offer Set Value on them.
- **GemDB commands in the Debug Console.** A line starting with `%` is a GemDB command rather than
  Python: `%persist p` adds `p` to Persisted Objects (or `%persist expr as key`), shown there as
  added until the notebook commits; `%commit` commits the notebook; `%names` lists the names you
  have bound in the console at this pause; `%help` lists the commands. Typing `%` suggests them, and
  `%persist ` suggests your console names. The first pause in a window says so, once. `gemdb` is
  available in the console without an import, so a line copied from Persisted Objects
  (`gemdb.root["orders"]`) works in any program, and each persisted entry is there by its key
  (`orders`) at every pause, unless the paused code has a name of its own spelled so, and is
  labelled `orders is gemdb.root["orders"]` when typed; `persisted.orders` reaches it whatever
  `orders` means at the pause. Typing a name offers `persisted.orders` in autocomplete for each
  persisted entry it starts, and `persisted.` offers the keys.
- **The Debug Console on a saved stack.** A stack reopened with **Restore a Saved Stack…** now has a
  Debug Console, in each frame, on the saved objects: evaluate, call methods, bind names, change
  objects, `%names`, `%persist`, `%commit`, Show in Debug Console and Evaluate with self…. The stack
  opens in a database session of its own, so a change waits there uncommitted, as a notebook's does.
  When the stack opens, the console warns that `%commit` (or ✓ in Persisted Objects) would write a
  change into the saved stack, which then no longer holds the values it was saved with. Closing the
  stack with changes pending asks whether to commit them; otherwise they are discarded.

### Changed

- **GemDB asks before installing newer Python support into your database.** Installing it into a
  database that already has Python support makes what was committed with the old version stop
  working as its type: dates and times, decimals, tuples and sets, instances of your own classes,
  even a stored `None` no longer compare, calculate or pass `isinstance`. So when an update ships
  newer Python support, starting the database, running a cell or opening the GemDB Shell asks
  first, with that warning; it was installed unasked before. Keep the current version and GemDB
  does not ask again for that update, and the database starts on the Python support it has. The
  **Python** row in the GemDB panel, or **GemDB: Reinstall the Python Execution Engine**, installs
  it later, and that command now gives the same warning. Opening the editor and AI agents never
  ask. `gemdb.reinstallPythonOnUpdate` is no longer used.
- **A newer Python runtime.** 388 commits across 175 pull requests since 1.6.0. FastAPI serves sync
  endpoints as well as async ones, `import numpy` completes and its operators work, and enough is
  in place for boto3, SQLAlchemy and pytest's test collection. Names follow CPython's Unicode
  rules, so `µ` and `μ` are one name; `except*` works; tracebacks stop at the frame that caught the
  exception and report CPython's line numbers. A session's first `unicodedata` call takes
  milliseconds and leaves nothing to commit, where it took about a second and left the session
  needing a commit. Some code CPython refuses is now refused here too: a lambda given extra
  arguments, or an argument given both by position and by keyword, raises `TypeError`; an
  exception in a decorator propagates instead of leaving the function undecorated; and comparing a
  `date` with a `datetime` is `False` for `==` and raises for `<`. `vars(obj)` is now a live view
  of the object, so writing through it changes the object. `click` and `requests` are no longer
  importable unless you install them; Flask still works without them.
- **The new GemDB brand.** The Marketplace and Extensions view icon is GemDB's dark-mode favicon,
  the gem on a blue gradient, and the activity bar shows the gem, recoloured to fit your theme with
  its right face lighter as in the logo. The Marketplace page's banner is the brand's Core Purple.
- **Usage data now records which editor GemDB runs in** (VS Code, Cursor, …), so a fork's users are
  not mistaken for VS Code users on an old release. `USAGE_DATA.md` lists it.

### Fixed

- **A classmethod's or staticmethod's frame is named by its class.** The Call Stack read
  `Account class.open` for a paused `@classmethod` or `@staticmethod`; it now reads `Account.open`,
  as CPython names it.

- **Starting GemDB from two places at once starts it once.** A cell run while the database was
  starting on its own, cells in two notebooks, or a cell and **GemDB: Start** each ran the whole
  start: two stone starts, two installs of Python support, two MCP servers. Now whatever asks while
  a start is under way in the same window waits for that start and gets its result, unless the
  database was stopped while it started: then it waits for the stop and starts the database again.
- **GemDB asks about shared memory once, even when two things need it.** A cell run while the
  first-run question about shared memory was still open queued a second copy of it, and answering
  both could open two `sudo` terminals. Now the second waits for the first answer. Running **GemDB:
  Configure Shared Memory** while that setup is already running uses its terminal instead of opening
  another, and so does answering the question while the command's setup is running.
- **The MCP server is installed and started once when GemDB starts.** Opening a window on a running
  database while a cell started it could install the MCP server's classes twice and start two
  servers on one port. Now the second waits for the first.
- **Ctrl+C ends a `gemdb` run without an error.** Stopping `gemdb app.py` printed
  `[Sending soft break]`, a line number in GemDB's own script,
  `ERROR 3004 , a ExitClientError occurred` and `Logging out session 1.` around the
  `KeyboardInterrupt`, which read as a failure. It now prints only `KeyboardInterrupt`, as Python
  does. GemStone's own messages from a `gemdb` run are shown only when the program could not run to
  the end, such as a refused login, and a `.topazini` file is no longer read.

- **Starting GemDB while something else is starting it no longer reports a failure.** Pressing
  Start, running a notebook cell or opening the GemDB Shell while another window or terminal was
  bringing the database up could end in "Start session listener failed (exit code 1)", although the
  database and its session listener were both running. GemDB now checks for and starts the session
  listener under the same lock as the database, so one start waits for the other, and a listener
  started by an older GemDB in another editor counts as started.
- **GemDB waits for a database that is still starting before logging in to it.** After a crash the
  database takes a while to recover before it accepts logins, and GemDB treated it as running as
  soon as it appeared, so the first notebook cell, the GemDB Shell or a `gemdb` command could fail
  to log in. GemDB and the `gemdb` command now wait for the database to finish starting, for up to a
  minute, and then name the database's log if it has not.
- **The GemDB Shell checks the database before starting it, as the window does.** Opening the Shell
  with the database stopped started it without the checks the window makes first, so a database the
  installed engine cannot read started and then refused every login, and one on a network drive or a
  disk without room for it failed with the engine's own error. The Shell now refuses with the same
  explanation the window gives, and applies the space limits a database from an earlier GemDB is
  missing.
- **On Linux, Survives logout takes effect at once.** Clicking the row wrote `RemoveIPC=no` to
  logind's configuration and the row went away, but logind kept the setting it had loaded, so the
  next logout still removed the database's shared memory. GemDB now has logind reload its
  configuration and waits for the new setting to be in effect. The row reads logind's live setting,
  and says **not yet applied** if the file is written but not loaded, instead of disappearing.

## [1.6.0] - 2026-10-07

The engine is unchanged at GemStone 4.0.0.a4, but start with a fresh database: delete
`~/GemDB/db` before starting this release. Your sessions now log in as a new `gemdb` account, and
what an earlier release stored belongs to DataCurator, where this one does not look. The bundled
Python runtime moves forward.

### Added

- **Statmon files open in GemDB Stats, inside the editor.** Click a `.out.gz` or a `statmon….out`
  file, right-click any `.out` and choose **Open in GemDB Stats**, or run
  **GemDB: Open Statistics File…**, and the file opens in a tab of GemTalk's statmon viewer: browse
  processes, plot statistics, compare them on one chart. Clicking the file name opens another file
  in its place, through VS Code's own dialog, so under code-server it browses the server where the
  files are. Large files load in the background with a progress bar, and the tabs come back when
  the window reloads. It needs no database, so it works before GemDB is set up.
- **The database records its own statistics, for GemDB Stats.** While it runs, the database
  records what it and the machine are doing every 20 seconds: sessions, commits, the cache, garbage
  collection, CPU and memory. It writes to `db/stat` under the root path, a new file each day,
  using no database session and a few MB a day. Files are deleted after 14 days. The GemDB panel's
  **Statistics** row, or **GemDB: Open Today's Statistics**, opens the current file in GemDB
  Stats. `gemdb.statistics.collect`, `gemdb.statistics.intervalSeconds` and
  `gemdb.statistics.keepDays` change this from the database's next start. A database GemDB Code
  does not run is left alone.
- **The database reserves the free license's full 10 GB, with room to collect its garbage.** GemDB
  Code caps the database at the license's 10 GB (until now it stopped at 8 GB), reserves all of it
  on disk when the database first starts, and keeps 500 MB of it free, so the database protects
  itself before it fills. Reserving the space up front means the disk cannot fill underneath the
  database later. Setup checks for about 11 GB (12 GB on Linux) before it downloads anything, and
  every start checks too, saying how much is missing and offering another folder. Garbage is
  collected on a schedule (daily, `gemdb.maintenance.garbageCollectionIntervalHours`) once nothing
  has run for a few minutes, and whenever less than 2 GB is left. That second trigger matters
  because below the last 500 MB the database stops reclaiming garbage; if it gets there anyway,
  GemDB lifts that limit for the length of a collection. The GemDB panel's **Space** row shows how
  much is used and when garbage was last collected, and **GemDB: Collect Garbage Now** runs a
  collection immediately.
- **A warning when the database is full, with time to commit.** When the database runs out of the
  space it keeps free, GemDB says so at once and starts collecting garbage, and says so again two
  minutes later: at three, the database starts stopping sessions that hold back its space, and
  what they have not committed is lost. A notebook that is already open can still commit; a new
  notebook or GemDB Shell is refused, with a message saying why, until there is room. GemDB says
  when there is room again.
- **Idle sessions stop holding garbage back.** A notebook, GemDB Shell or GemDB session left idle
  for 10 minutes (`gemdb.maintenance.abortIdleSessionsAfterMinutes`) is refreshed by aborting its
  transaction, only when it has no uncommitted changes, so nothing is lost and its variables stay.
  A notebook with uncommitted changes is never aborted. If it holds a collection back, GemDB asks
  you to commit or abort it.
- **GemDB: Stop a Database Session…** lists every session on the database, the ones holding garbage
  collection back first, and stops the one you pick after asking. Anything it had not committed is
  lost.
- **GemDB: Copy Telemetry ID** puts the ID GemDB's usage data is keyed by on
  the clipboard, so you can ask for that data to be found or deleted.
  `USAGE_DATA.md` used to send you to Help: About for it, which does not show
  it. It works with telemetry turned off.
- **GemDB: Refresh Notebook View** lets the active notebook see what other sessions have committed,
  from the ↻ button in a GemDB notebook's toolbar or the Command Palette. It runs
  `gemdb.refresh()` in that notebook's own session, so nothing has to be typed into a cell, and
  with uncommitted changes it refuses and says what to do, as `gemdb.refresh()` does.

### Changed

- **A newer Python runtime.** 213 commits across 78 pull requests since 1.5.4, and Python now
  matches CPython 3.14.8. Syntax errors read as CPython's do and point at the same place, runaway
  recursion raises a `RecursionError` you can catch, and `random`, `statistics`, `string` and
  `str.format` are CPython's own, so a seeded `random` now gives CPython's sequence. A commit the
  database refuses raises `gemdb.SessionStateError`, naming the object it could not store, where it
  used to stop with a GemStone error. `gemdb.use_namespace()` gives an application its own
  modules, and `__transient__` marks attributes that are never committed. Two things behave
  differently: importing a file under a module name another file already deployed raises
  `ImportError`, which names `gemdb.modules.relocate()` and `gemdb.modules.forget()`; and setting
  a global of a built-in module, such as `gc.disable()`, lasts only for that session instead of
  being committed for every later one.
- **GemDB: Refresh is now called GemDB: Refresh Status**, which is what it does: it re-reads the
  GemDB panel. It never refreshed a notebook's view; **Refresh Notebook View** does that. Its
  command id is unchanged, so a key bound to it still works.
- **When the database has no free sessions, the message says who else is holding them.** With
  GemDB's MCP server running, it says the server holds a session and each connected AI agent holds
  another, and suggests disconnecting an agent as well as closing a notebook. For GemDB's own
  database it also says where the limit of 10 comes from: the Community Edition key GemDB installs.

- **Your work runs as a `gemdb` database account, not DataCurator.** Notebooks, the GemDB Shell,
  Python files and AI agents log in as `gemdb`, which can define classes and run Python but has no
  administrative privileges; GemDB creates it on the database's first start. GemDB's own
  maintenance still uses DataCurator, on sessions of its own. From Python,
  `gemdb.admin.garbage_collect()`, `gemdb.admin.backup()` and `gemdb.sessions.all()` now raise a
  security error; **Collect Garbage Now** and **Stop a Database Session…** cover the first and
  last.

### Fixed

- **Two windows, or a window and a `gemdb` command, no longer take the same lock at once.** Taking
  over a lock left behind by a crash is now one process at a time, so two windows that both found
  it stale cannot both go ahead and download into one file. A lock that has just been taken, with no
  owner written into it yet, is no longer mistaken for debris and removed, which could let a second
  stone start on the same database. Nothing removes a lock it does not own. A window that finds
  another process starting the database now waits for it, for up to a minute, instead of carrying
  on as if it were already running.
- **A setup interrupted while unpacking the engine or creating the database no longer leaves an
  install that looks finished.** Both are now built beside their final location and moved into
  place only once complete, so closing the window part way through means the next start redoes that
  step instead of failing later with a half-extracted engine or a truncated database. What an
  interrupted run leaves behind is removed the next time setup runs.
- **A database the `gemdb` command started gets Python support when GemDB Code next opens.** The
  `gemdb` command and the GemDB Shell start the database if it is not running, but only GemDB
  Code installs Python support into it. A database started that way before Python support was ever
  installed, for example a fresh setup whose shared memory was raised by hand and then used from a
  terminal, stayed without it until you pressed Start or ran a notebook cell, and `gemdb` failed
  with a GemStone error in the meantime. GemDB Code now installs it when it opens and finds the
  database running, as it already did when it found the database stopped. For the same reason, a
  running database whose Python support is older than the one GemDB Code ships now gets the update
  when GemDB Code opens, unless `gemdb.reinstallPythonOnUpdate` is off.
- **Ctrl+C stops a `gemdb` run.** Interrupting `gemdb app.py`, or a file run with **Run Python File
  in GemDB**, used to leave it at a `topaz 1>` prompt, still holding a database session. It now runs
  the script's `finally` blocks, prints `KeyboardInterrupt` and exits with status 130, as Python
  does.

## [1.5.4] - 2026-10-01

The engine is unchanged at GemStone 4.0.0.a4, so a database created by GemDB
1.5.3 carries over as it is. The bundled Python runtime moves forward.

### Added

- **Use a database someone else runs.** Set `gemdb.externalDatabase.gemstone` to an engine an
  administrator installed — on a hosted or shared machine — and GemDB Code connects to their stone
  instead of installing its own: it installs Python support into your account and runs the MCP
  server, and never downloads, creates, starts, stops or removes the database. The stone, NetLDI and
  account are settings, and the password is read from a file, so it never appears in
  `settings.json`. The Get Started walkthrough describes that setup instead of a download, and
  leaves out stopping the database (#79). Changing these settings while the editor is open logs
  every notebook out of the previous database and stops the MCP server running against it (#81). See
  [docs/external-database.md](docs/external-database.md).

- **`breakpoint()` in a notebook cell opens the debugger.** The cell pauses, VS Code's Run and Debug
  view shows the Python call stack — methods named with their class, frames from other cells and
  imported files in place — and the paused line is highlighted. Variables shows each frame's locals
  and the notebook's globals, and expands objects into their attributes, lists and sets into their
  items and dicts into their entries, a page at a time for big ones. Classes, functions and modules
  are folded into their own rows, as in VS Code's Python debugger, so the data stands out. A
  `__repr__` that takes more than a couple of seconds is cut short and its row says so, rather than
  freezing VS Code. Right-click a row and **Add to Persisted Objects…** puts that object under
  `gemdb.root` with a key it suggests (`employee_barbara`, from the object's type and name). The
  notebook's next commit writes it, so a half-finished cell is never committed behind your back.
  **Continue** resumes the cell; **Stop** ends it, and the cells queued after it (as does the cell's
  interrupt button) do not start. There is nothing to launch or configure. Stepping is not
  supported yet, and the debugger says so when asked.

- **Red dots in `.py` files.** Click in the gutter beside a line, and a run that reaches it pauses
  there with the debugger open, the same as `breakpoint()`. That holds in Debug Python File and in a
  notebook cell that calls into the file. Dots in a module the run imports work, and a dot added
  while paused stops the run later on. Dots with a condition, hit count or log message, and dots in
  notebook cells, are not supported yet, and the debugger marks them so.

- **Debug Python File in GemDB**, beside Run Python File in a `.py` file's run menu, runs the file
  so that `breakpoint()` opens the debugger on it, the way it does on a notebook cell: its frames,
  locals and globals, and adding objects or the stack to Persisted Objects. Output goes to a GemDB
  Debug terminal, whose session lasts until the terminal closes, so the run's changes can still be
  committed or aborted after it ends. In a folder VS Code does not trust, it asks you to trust it
  first.

- **Add a paused stack to Persisted Objects, and open it again later.** **Add Stack to Persisted
  Objects…**, on the Call Stack's top row or any frame's menu, saves each frame's place and source,
  its locals and the notebook's globals as one entry under `gemdb.root`. Once committed, **Restore a
  Saved Stack…** (a button in Run and Debug, and in the GemDB panel) lists the saved stacks, or
  opens the only one, in Run and Debug again; Persisted Objects can open it from its row too — after
  a restart, and with the notebook or file gone. Each frame shows the copy of its source saved with
  the stack, marked "(saved <time>)" in its tab and Call Stack row. It is a snapshot: the run itself is not resumed.
- **A Persisted Objects view** under GemDB, and in Run and Debug while a cell is paused, lists what
  `gemdb.root` has committed, with a check mark, and under each notebook the objects added from the
  debugger that it has not committed yet. Its title bar always has **Commit** and **Abort**, for the
  paused notebook (or the active one), and each added object's row has them too. They act on that
  notebook's whole session and work while it is paused at `breakpoint()`. Adding opens the view on
  the new row, and resting the pointer on an object shows its type, its value and its first
  attributes or items. **Remove from Persisted Objects** takes back an addition not yet committed,
  or deletes a committed entry and commits just that removal. Its **?** button explains, for someone
  new, that persisting is adding under `gemdb.root` and then committing.

### Changed

- **A newer Python runtime.** 47 commits across 21 pull requests since 1.5.3.
  An application served from more than one database session conflicts less:
  a module-level `functools.lru_cache` keeps its cache per session, as
  CPython's is per process, and setting a class attribute such as
  `Flask.secret_key` at run time stays in the session that set it. A Flask
  view that raises now answers 500, where it used to end the process. `re.sub`
  with a function works on a compiled pattern stored in the database, a dotted
  import of a package that cannot be found now fails at the import, and
  `statistics` arithmetic and `Fraction` hashing now match CPython.

- **The usage event for a skipped setup says what is already on disk.** When GemDB skips
  its automatic first-run setup, the event now says whether a database, an
  engine and Python support are already on disk — yes or no, and for the
  engine whether it is the one this version installs — never a path or a
  version. It also now tells a setup that completed after being cancelled
  apart from one that was only cancelled. [docs/telemetry.md](docs/telemetry.md)
  lists the properties.

### Fixed

- **Stopping the MCP server no longer risks ending someone else's session.** GemDB stopped the
  server by the session number it was given at start. If the server had already gone some other
  way, such as a crash or a force-stopped database, the next login could be handed that number, and
  the next **Stop GemDB** would have ended that session, most likely a notebook's. GemDB now also
  records the server's session serial, which the database never reuses. It stops the session only
  if it is still the server's own, and otherwise stops the server process directly.
- **Setup no longer fails when it is asked for twice.** Pressing **Set Up GemDB**, or running a
  cell, while the first-run setup was still downloading started a second download into the same
  file, and both failed — one with "The download ended early (452662077 of 449106447 bytes)" (#68).
  A second request now waits for the setup already under way, in this window or another, and the
  sidebar says setup is running instead of offering the button again.
- **Setup says what it will cost on this machine.** The sidebar and the log give this computer's
  figures rather than both platforms', and the space on disk is per platform too: about 145 MB to
  download and 700 MB on disk on macOS, and about 450 MB and 1.4 GB on Linux.
- **A home directory on NFS no longer costs a whole setup.** The database engine will not open its
  files on an NFS mount, and on many shared Linux machines `~/GemDB` is one. GemDB Code downloaded
  the engine and created the database there anyway, then failed to start it (#69). Setup now checks
  first: if the root path is on NFS, it downloads nothing and offers **Choose a Local Folder…**,
  which sets `gemdb.rootPath` and sets GemDB Code up there. A database already set up on NFS gets
  the same offer when it fails to start. The sidebar, the walkthrough and the setting's description
  now say where GemDB Code keeps its files and how to change it, and the description no longer
  assumes a Mac.
- **The MCP server comes back when the database is already running.** Opening a window started
  it only along with the database, so a router that a reboot or a restarted stone took away stayed
  down until the first line of Python — and Claude Code, which connects to the address directly,
  found nothing listening.

- **VS Code installed as a Snap now says why it cannot run GemDB.** On Linux,
  the Snap build of VS Code (what Ubuntu's App Center installs) runs on older
  system libraries than the database engine needs. The database still set up
  and started, but every notebook cell and the GemDB Shell failed with a
  linker error such as ``version `GLIBCXX_3.4.29' not found``. GemDB now says
  that the Snap is the cause and to install VS Code from code.visualstudio.com
  instead. The database it has already set up carries over. The GemDB Shell
  shows the message and closes, instead of offering a prompt where every line
  repeats it.

- **Pasting several lines into the GemDB Shell runs all of them.** Only the
  first line of a paste ran; the rest were silently dropped. Each line now
  runs in turn, a pasted block runs as one statement, and a line that calls
  `input()` takes its answer from the next line of the paste, as in CPython.
- **`breakpoint()` in a file run with `gemdb` or Run Python File in GemDB no longer leaves you at a
  `topaz 1>` prompt.** It prints where it was and the script carries on. The GemDB Shell does the
  same, where it used to fail with `a Halt occurred (error 2709)`. A direct `pdb.set_trace()` in a
  file still stops at `topaz 1>`.
- **Running a cell while another in the same notebook is running now waits its turn**, rather than
  failing with "This session is busy running something else". An interrupt ends every run already
  requested, including one still waiting for the database to start, and a cell that cannot run at
  all (its session closed under it) stops the cells queued after it instead of running them in a
  fresh session.

## [1.5.3] - 2026-09-28

The engine moves to GemStone 4.0.0.a4, so an existing database has to be
recreated — read the first entry below before updating. The bundled Python
runtime moves forward with it.

### Changed

- **GemDB now runs GemStone 4.0.0.a4, and an existing database cannot come with
  it.** A database created by GemDB 1.5.2 or earlier was written by 4.0.0.a3 or
  older, and there is still no in-place upgrade between alphas, and not yet a
  way to export your data. When the new engine first starts, GemDB stops and
  names the directory to delete, so the database can be recreated. **Deleting
  it deletes everything stored in it.** To choose when an update like this
  arrives, clear **Auto Update** on GemDB Code's page in the Extensions view.

- **A newer Python runtime.** 72 commits across 30 pull requests since 1.5.2,
  nearly all of them bringing Python closer to CPython. `typing` and `urllib`
  are CPython's own modules again, and `ssl` is CPython's `ssl.py` over
  OpenSSL. `NamedTuple` and `TypedDict` behave as CPython's do, and
  `xml.etree`, `xml.sax` and `xml.dom.pulldom` have been fixed against
  CPython's own tests. `unittest.main()` now exits non-zero when a test fails,
  `any()` and `all()` test truth the same way `if` does, and a `@staticmethod`
  or `@classmethod` can now override an ordinary method from a base class.

### Fixed

- **An uncaught exception in a `gemdb` script prints a traceback.** Running
  `gemdb file.py` reported an uncaught exception as its message alone, without
  the exception's type or where it was raised, so `1 / 0` inside a function
  printed only "division by zero". It now prints the traceback CPython would,
  after the script's `finally` blocks have run, as CPython does. That includes
  a `RecursionError`, which used to overflow the stack while being reported.

- **A failed Python install shows in the GemDB panel.** After Python support
  failed to install, the panel looked like a fresh install, and once the
  notification was dismissed nothing showed the failure. The **Python** row
  now says the install failed, with the error in its tooltip, and clicking it
  tries again. **Running** says the database is running but Python support
  failed to install. The warning clears when an install succeeds, and when an
  update brings a different build of Python support.

- **The GemDB output no longer reports a naming failure on every notebook
  login.** GemDB names each database session so it can be identified from
  outside, and every login logged that naming it had failed when it hadn't.

## [1.5.2] - 2026-09-27

The engine moves to GemStone 4.0.0.a3, so an existing database has to be
recreated — read the first entry below before updating. The bundled Python
runtime and MCP server move forward with it.

### Changed

- **GemDB now runs GemStone 4.0.0.a3, and an existing database cannot come with
  it.** A database created by GemDB 1.5.1 or earlier was written by 4.0.0.a2,
  and there is still no in-place upgrade between alphas. When the new engine
  first starts, GemDB will stop and name the directory to delete, so the
  database can be recreated. **Anything stored in it is lost, so copy out
  whatever you still need before updating.**

- **A newer Python runtime.** 127 commits across 43 pull requests since 1.5.1,
  most of them bringing Python closer to CPython. `pickle`, `abc`,
  `collections.abc` and `ipaddress` are now CPython's own modules rather than
  partial rewrites, and `pickletools`, `dbm` and `xml.dom` are new. PEP 695
  generics work: in `class Box[T]:`, `T` used to be unbound in the class body.
  `os` gains `open`, `read`, `write`, `lseek`, `fstat` and the rest of its
  file-descriptor functions. A coroutine that is never awaited now warns, and
  a suspended generator can be garbage-collected.
  Dictionaries and comparisons fixed along the way: deleting a key through an
  equal object no longer corrupts the dictionary's order, keys compare full
  hashes before asking for equality, `functools.lru_cache` compares keys with
  Python equality, and `!=` handles `NotImplemented` correctly. Classes made by
  `type()` or `Enum('Color', 'RED GREEN')` now get a `__module__`.

- **The MCP server's Python tools are more precise.** `find_python_senders`
  now gives every call and every reference in a method compiled straight to
  the intermediate representation its own hit, with its Python line. It used
  to report one unplaced `line ?` per method. `eval_python` runs as
  `__main__`, as `python -c` does, so `__name__` is defined. The instructions
  the server gives an agent are shorter, and they steer it away from looping
  over every stored object in a large database and toward that application's
  own collections and indexes.

- **Connecting Claude Code to GemDB's MCP server is one click.** Picking
  Claude Code in **GemDB: Connect an AI Agent to GemDB** now runs Claude
  Code's own `claude mcp add` for the open folder, instead of copying a
  command to paste. The copied command didn't work for most people who
  pasted it: the Claude Code extension doesn't put `claude` on your PATH, and
  GemDB finds the copy it ships. It applies to that project only, since every
  Claude Code session spends a database session. Running it again offers to
  replace the entry, which is how it picks up a port change. GemDB shows what
  it ran and how to undo it. With no folder open, an untrusted folder, or no
  Claude Code to be found, it copies the command as before.

- **Installing the Brain Freeze demo is one click, and it shows you where to
  start.** The command is now **GemDB: Install Brain Freeze Demo**, and it is
  a step in the Get Started walkthrough. It no longer asks where to put the
  demo: it clones into `~/GemDB/brain-freeze`, beside your database, then
  opens that folder and shows the demo's readme. An empty window is reused;
  a window that already has a folder open is left alone, and the demo opens in
  a new one. Running it again opens the copy you have rather than replacing
  it. A copy cloned elsewhere by an earlier version is left where it is.

- **GemDB keeps working in a folder you haven't trusted yet.** VS Code opens a
  new folder in Restricted Mode, and GemDB used to switch off entirely there:
  no status bar, no commands. It now stays on. Running Python from that folder
  still waits for trust, and VS Code asks the first time you run a cell or
  open a GemDB Shell. To stop being asked about folders GemDB installs, trust
  `~/GemDB` once in **Workspaces: Manage Workspace Trust**.

- **GemDB's settings are per-machine, and a folder's settings can no longer
  change them.** Every `gemdb.*` setting configures this machine's database
  or MCP server, so each now lives in your user settings only. A value in a
  folder's `.vscode/settings.json` is ignored (VS Code marks it in the file),
  which keeps a cloned repository from choosing where GemDB keeps — and on
  uninstall deletes — its files. Settings Sync no longer copies them between
  machines. If you had set one per folder, move it to your user settings.

### Fixed

- **A script run with `gemdb file.py` can start with
  `with gemdb.transaction():`.** Starting the script used to leave uncommitted
  changes in the session before its first line ran, so a transaction block
  there refused to start and blamed changes you hadn't made. The workaround,
  calling `gemdb.commit()` or `gemdb.abort()` first, is no longer needed.
  Separately, calling a function in a module stored in the database no longer
  counts as a change, so two sessions calling the same function for the first
  time no longer conflict when they commit.

- **The MCP server starts on a Mac whose network name doesn't resolve.** Its
  agent sessions reached the database by your computer's network name. A Mac
  connected straight to a cable modem often takes that name from its internet
  provider, and nothing can look it up, so every agent session failed to log
  in and the server never started. It now reaches the database through
  `localhost`, as the rest of GemDB always has.

- **`logging` accepts `exc_info`.** Frameworks such as Flask pass it when they
  log an exception. `logging` used to raise a `TypeError` about `exc_info`
  instead, so the exception being reported was never recorded, and an error in
  a Flask view surfaced as that `TypeError`.

## [1.5.1] - 2026-09-23

The bundled Python runtime and MCP server move forward. The engine is
unchanged, so an existing database carries over as it is.

### Added

- **`gemdb.schema`, for the few schema changes that touch stored data.**
  Editing a class is still all almost any change needs: adding an attribute,
  no longer assigning one, or moving one between a parent and a child touches
  no stored instance. The operations that do rewrite instances are now in one
  module you import by name:

  ```python
  import gemdb.schema

  gemdb.schema.layout(Account)              # what the class stores, by position
  gemdb.schema.report()                     # every class with unused attributes
  gemdb.schema.drop(Account, "balance")     # delete an attribute's values
  gemdb.schema.rename(Account, "phone", "phones")
  gemdb.schema.compact(Account)             # reclaim the space a drop left
  ```

  `rebase`, `drop_class` and `rename_class` cover a class that changed its
  bases, was deleted, or was renamed. Everything except `layout` scans the
  repository and commits its own work. Each one therefore refuses while your
  session has uncommitted changes, rather than discarding them.

### Changed

- **A newer Python runtime.** 282 commits across about 110 pull requests since
  1.5.0. Most of them bring standard-library behaviour closer to CPython's:
  `OSError` subclasses carry the right `errno`, and `pathlib` gains
  `Path.walk`, `is_mount` and `as_uri`. `os.path.realpath` now resolves
  symlinks, and `shutil.rmtree` no longer follows them. Codecs, `eval` and
  `exec` scoping, private-name mangling and `int.to_bytes`/`from_bytes` all
  behave as CPython does.

  Python now also compiles straight to GemStone's intermediate representation
  by default, rather than by way of generated Smalltalk source. Your code
  should behave exactly as it did. If it does not, that is a bug worth
  reporting.

- **The MCP server's Python search sees more.** `find_python_senders` now
  finds calls in nested and function-local classes, and in methods compiled
  straight to the intermediate representation. It also names the method each
  hit is in, so `get_method_source` can open it. What a module writes to
  `stderr` during `eval_python` now comes back in the result instead of being
  dropped.

- **The MCP server no longer refuses to modify GemStone's own classes.** The
  refusal lived inside the server, so `execute_code` could always get past it.
  The stone enforces the real boundary, and with `gemdb.mcp.readOnly` on,
  agents log in as a user the stone does not let modify kernel classes. Leave
  it off, and an agent can change kernel classes as easily as your own.

- **A new icon.** The Marketplace and Extensions view icon is redrawn from the
  GemDB mark's vector source, and the activity-bar icon is traced from the same
  source, so the two now match. The activity bar used to show a scaled-down
  copy of the full-colour PNG. It is now a single-colour mask that VS Code
  recolours to fit your theme, like the other icons beside it.

### Fixed

- **Installing the Python runtime no longer runs a full garbage collection
  every time.** A check meant to run one only when the repository was close to
  full misread GemDB's database, which has no configured size limit, as always
  full. A collection needs every connected session to agree to it. So with
  another window or a GemDB Shell connected, the install could stall and then
  fail with "Request for gcLock timed out".

- **"builtin" is spelled "built-in"** in the extension's description.

- **`scripts/unset-os-config.sh` gives a cleanup command that works.** Its
  closing hint suggested `rm -rf ~/GemDB` for replaying first-run setup. That
  fails part-way, because the engine unpacks some files read-only. The hint now
  adds write permission first: `chmod -R u+w ~/GemDB && rm -rf ~/GemDB`.

## [1.5.0] - 2026-09-16

### Added

- **One command clones the Brain Freeze demo.** **GemDB: Clone the Brain Freeze
  Demo** asks where to put it and clones
  [brain-freeze](https://github.com/GemTalk/brain-freeze), a Flask application
  whose data, classes and views all live in the database. It needs `git` on
  your PATH, writes only inside the folder you pick, and starts no database of
  its own — reading the code does not need one. If the folder already has a
  `brain-freeze` in it, GemDB offers to open that rather than cloning over
  your copy.

- **A usage-data notice, because GemDB now reports one event when it starts.**
  The event carries non-identifying, extension-level information — the platform,
  the extension version, whether an operation succeeded and how long it took —
  and never the contents of your work. GemDB honours VS Code's
  `telemetry.telemetryLevel`, so turning telemetry off in the editor turns this
  off too. [USAGE_DATA.md](USAGE_DATA.md) says exactly what is sent, what is
  not, and who the data controller is.

- **An MCP server, so an AI agent can use your database.** GemDB now bundles
  [GemTalk's native GemStone MCP server](https://github.com/GemTalk/mcp_server)
  and files it into your database, which means an agent can list what is
  stored, run Python against it, and commit — against the same database your
  notebooks use, with no separate setup.

  It starts and stops with the database, so there is no second thing to
  remember, and it binds `127.0.0.1` only. In VS Code there is nothing to
  configure at all: the server registers itself with the editor, and an agent's
  first tool call starts the database the way a notebook's first cell does. For
  an agent elsewhere, **GemDB: Connect an AI Agent to GemDB** copies the exact
  command or JSON that client needs — GemDB does not edit those files itself,
  for the same reason it does not edit your shell profile.

  Each connected client gets its own database session, so two agents never see
  each other's uncommitted work. That has a cost, and it is why **this is off
  until you turn it on** (`gemdb.mcp.enabled`, or say yes when the connect
  command asks): a client that disconnects without saying so keeps its session
  for up to 30 minutes, reconnecting counts as a new client, and enough
  repeated reconnections can use up every session your database allows and
  leave you unable to log in until they are released. Stopping GemDB frees them
  at once. Bounding that properly belongs in the MCP server, which is the only
  component that knows how many sessions it has opened; the default comes back
  on once it does.

  The new **AI agent access** row in the GemDB panel says whether it is on and
  what is connected. `gemdb.mcp.port` moves it off 50390, and
  `gemdb.mcp.readOnly` logs every agent in as a database user that cannot
  commit — it still reads everything and can still run code, but nothing it
  does is saved.

### Changed

- **GemDB now runs GemStone 4.0.0.a2, and an existing database cannot come with
  it.** The engine moved from 3.7.5 to the 4.0 alpha line, and there is no
  in-place upgrade — GemStone 4.0 ships no `upgradeImage`. A database created by
  an earlier release of GemDB has to be recreated, and **anything stored in it is
  lost, so copy out whatever you still need first.**

  The engine will not tell you this itself. The extent format is unchanged, so a
  4.0 stone starts on an older database and `gslist` reports it healthy — the
  status bar goes green — and then every login fails with "The Gem and dbf
  versions are incompatible", which breaks your first notebook cell, the GemDB
  Shell and any connected agent at once while naming neither the cause nor the
  cure. So GemDB checks the database against the engine before it starts
  anything, refuses, and names the directory to delete.

  This applies to the alphas among themselves: a database written by
  4.0.0.Alpha1 is orphaned by 4.0.0.a2, which replaced it in the download
  catalog on 2026-09-16 — Alpha1 can no longer be downloaded at all.

### Fixed

- **Three of Grail's own development scripts no longer ship inside the
  extension.** `topazini`, `new_worktree.sh` and `create_claude_users.gs` each
  carried a login for a database that exists only on a Grail developer's
  machine, and nothing in GemDB ever read them. The password is GemStone's
  published default, so nothing you have is any less safe than it was — but a
  credentials file has no business in a published package, and a release now
  refuses to publish one.

- **A failed engine download says what failed.** The download retries more
  patiently, and a DNS failure is now reported as one rather than as a generic
  network error — which is the difference between knowing you are offline and
  wondering whether the engine has moved.

- **Python's `\d` matches non-ASCII decimal digits again, so `Decimal` can
  parse them.** `Decimal('１')` answered NaN, along with every other digit
  outside ASCII: the shim underneath was asking the C library a question it
  never answers, and the regex engine's `\d` inherited the wrong answer.

## [1.4.0] - 2026-09-03

The bundled Python runtime takes a large step forward. Nothing in the extension
itself changed.

### Changed

- **A substantially better Python.** GemDB ships the Python implementation
  rather than relying on one you install, so a release is how you receive it —
  and this is the first since 1.3.0 to carry a large one: 317 commits across
  136 pull requests. The headlines:
  - **Tracebacks that point at the code.** Multi-line statement spans, frame
    locals, and correct file and line across modules, lambdas and closures.
  - **A wider text story.** UTF-7, UTF-32, the transform codecs,
    punycode/IDNA, and `html.unescape`.
  - **Correct scoping where Python is subtle.** The walrus operator in
    comprehensions, lambdas and displays; comprehensions and decorators in
    class bodies.
  - **More of the standard library behaving as CPython does.** Broader
    `typing` and generic-class coverage, per-class `__slots__` strictness
    (a subclass declaring no `__slots__` gets an instance dict again), gaps
    closed in `struct`, and `ssl.OPENSSL_VERSION` reporting the OpenSSL the
    database actually loaded.

  Because the runtime is built from Grail's default branch when a release is
  packaged, which commit shipped was previously only recoverable from the
  payload. From this release the Python implementation is tagged to match:
  **Grail `v1.4.0`** is the commit this release was built from.

## [1.3.0] - 2026-08-27

`gemdb` is on your PATH in VS Code's terminals, the samples start with
`import gemdb`, and running a script no longer garbles non-ASCII text or talks
about topaz.

### Added

- **`gemdb` is on the PATH of terminals you open in VS Code.** The command is
  generated into `~/GemDB/bin`, which is on nobody's PATH, so `which gemdb`
  answered "not found" and the README's answer was a line you had to add to
  your own shell profile. GemDB now contributes that directory to the
  terminals this editor launches — and takes it back when the extension is
  disabled or uninstalled. Your shell profile is still yours; add it there
  too if you want `gemdb` in terminals outside VS Code.

### Changed

- **The sample code now starts with `import gemdb`.** A new notebook's first
  cell, the walkthrough and the README all opened with `import gemstone` —
  Grail's own lower-level surface, inherited from Jasper. The first thing a
  developer meets is now `gemdb`: `gemdb.root` for the data that outlives the
  session, `gemdb.commit()` for the moment it becomes everyone's.

### Fixed

- **Non-ASCII text now survives `gemdb file.py` in both directions.**
  `print()` from a script wrote its characters as UTF-16 code units — a NUL
  between every ASCII letter, and anything above U+00FF truncated to one byte
  — so a `•` in an ASCII-art rabbit turned the whole drawing into binary.
  `input()` had the mirror-image fault: a line typed at the terminal arrived
  one character per _byte_, so `wörld` came back six characters long and
  mojibake. Only this mode was affected; the GemDB Shell and notebooks were
  always right, because they exchange characters over the client connection
  rather than bytes through a file. Needs the matching Grail change
  (GemTalk/Grail, console writes encode for a byte sink).
- **`gemdb file.py` no longer prints topaz's own commentary.** Running a
  script from a real terminal ended with four lines about topaz ignoring an
  EXIT command, followed by `Logging out session 1.`. The driver ended with
  an `exit` that topaz documents as ignored for the way GemDB runs it — it
  already exits when the script completes — and ignoring it is silent on a
  pipe but spoken aloud on a terminal, which is why it never showed in CI.
  Exit codes are unaffected: they never travelled through that line.
- **The GemDB Shell no longer prints the database client's own chatter.**
  Opening a shell wrote a line like
  `gcits login: session 0x… lgc 0x… rpc gem processId 4726` onto your terminal
  between the banner and the first prompt, with a matching one on exit — the
  client library narrating itself. Every session GemDB opens now asks it not
  to.
- **Updating GemDB now updates the `gemdb` command and the shell it runs.**
  The staged copies under `~/GemDB/bin` were rewritten only when the Python
  payload changed, so a release that changed only extension code left the
  previous ones in place — a fix to the GemDB Shell reached the editor while
  the terminal it opens kept running the old build. They are now refreshed
  whenever they differ from what the installed version carries, and left alone
  when they do not. Opening a GemDB Shell or running a file now guarantees the
  command is there and current first, rather than handing VS Code a path and
  letting it report "The terminal process failed to launch".

## [1.2.0] - 2026-08-27

A notebook is a unit of work again: each one gets its own database session, and
the sessions GemDB holds are now visible — named where the whole machine can see
them, and listed in the panel.

### Added

- **Sessions now say who they belong to.** Every session GemDB opens names
  itself in the database's shared cache — `GemDB nb analysis` for a notebook,
  `GemDB Shell 41234` for a GemDB Shell, `GemDB Code` for the extension's own,
  and `GemDB run backfill` for a script started with `gemdb backfill.py`. The
  names are visible to anything attached to the same database, so a second VS
  Code window, topaz, or an administrator's tool can tell which of the ten
  sessions belongs to what, instead of seeing a row of anonymous gems. Nothing
  is committed to do this and the entry disappears with the process, so a
  window that crashes leaves nothing behind.
- **The GemDB panel shows the sessions this window is holding.** A **Sessions**
  row appears whenever anything is connected, listing each notebook, shell and
  the extension's own — with the database's session number and how long each
  has been idle, idlest first. Sessions are scarce and were previously
  invisible, which is the combination that makes hitting the limit baffling;
  now the one worth closing is the one named at the bottom of the tooltip.

### Changed

- **Each notebook now runs in its own database session.** Two notebooks no
  longer share variables _or_ a transaction. This is what every other notebook
  tool does — VS Code's Jupyter extension starts a kernel per notebook — but
  here it fixes something sharper than convention: a `commit()` in one notebook
  used to commit another's half-finished changes, and
  `with gemdb.transaction():` refused to start whenever _any_ open notebook had
  left the shared session dirty, naming pending changes you could not see from
  where you were standing. Interrupting a cell now stops only that notebook's
  work, and closing a notebook gives its session back.

### Fixed

- **`gemdb file.py` keeps working with the Python runtime this release ships.**
  GemDB asked each session to enable a module-binding flag that the Python
  implementation has since retired — warm binding is now its only path. Paired
  with the runtime in this release, every file run would have stopped at that
  line (taking the whole `gemdb` command with it) and every login would have
  logged a failure. Both requests are gone; what the release ships already
  behaves the way the flag asked for. Users of 1.1.0 were never affected, since
  its runtime still had the flag — but the extension and its Python runtime are
  a matched pair, and this is the half that had to move.
- **First-run setup no longer fails right after creating the database.** On a
  machine where GemDB had never been installed, setup stopped with
  `ENOENT: no such file or directory, open '<root>/grail/.gemdb-grail-stamp'`
  and Python support was never staged. It recorded Python as installed before
  creating the directory that record lives in — harmless on any machine that
  had run an earlier version, which is why it reached a release. Upgrades were
  affected too, more quietly: the same misordering made GemDB believe the
  Python payload was already current, so a new version's payload was never
  written to disk and the `gemdb` command kept its old contents.
- **Renaming a notebook no longer costs it its session or its variables.**
  A notebook is identified by its file URI, so renaming the file used to leave
  the old session logged in with nobody to claim it — one of ten, gone until
  the window closed — while the notebook itself started over with an empty
  namespace, which looked like its variables had vanished. A rename now carries
  the session, the variables and the session's published name across.
- **A notebook no longer keeps a view of a database that has been replaced.**
  Reinstalling Python support, uninstalling, and changing the root path or
  engine version now log out every session rather than only the extension's
  own.

### Documentation

- **A five-minute demo of persistence and sessions.**
  [`docs/demo/rabbit-in-the-hat/`](docs/demo/rabbit-in-the-hat/), with
  runnable scripts beside it: put an object in the database in one
  process, exit, and take it back out in another. Every command and output in
  it was measured rather than written from memory, which is how the `runPath`
  gap below was found.
- **How GemDB could reach Windows.**
  [`docs/reaching-windows.md`](docs/reaching-windows.md) works through the three
  routes — a WSL window, a native client against a remote server, and Docker as
  a backend — with what was measured and what still needs a Windows machine.
  Read it before starting any of them. (Design notes live in `docs/` and are
  not part of the shipped extension.)

### Known limitations

- **A script's first statement cannot be `gemdb.transaction()`.** `gemdb
file.py` starts with a session that already has pending changes — the Python
  runtime's own `runPath` makes them, not your code — so a transaction block
  opened on line 1 blames you for them. Call `commit()` or `abort()` first. The
  fix belongs in the Python runtime; the GemDB Shell and notebooks are
  unaffected.
- **Sessions are a limited resource, and notebooks now spend one each.** The
  Community Edition keyfile allows ten at once, the database's own gems take
  some of those, and every GemDB Shell takes another — so perhaps six or seven
  notebooks can be open at a time. A login refused for that reason now says so
  in those terms: what this window is holding, how long each has been idle, and
  which one closing would free. Sessions held by _other_ VS Code windows are
  not listed, because nothing yet publishes them where another window can read
  them.

## [1.1.0] - 2026-08-21

Linux joins macOS, and the Python you can write gets meaningfully bigger:
`input()`, streaming `print()`, real exit codes, and one GemDB Shell everywhere.

### Added

- **Linux, on x86-64 and ARM.** GemDB now ships three platform-specific
  packages — `darwin-arm64`, `linux-x64`, `linux-arm64` — and the Marketplace
  offers each machine only the one that can run there. Just one thing was ever
  platform-specific (the Python runtime's compiled shim); everything else
  already handled Linux. Each package is now built _and_ tested on a runner of
  its own architecture, against a real database, which is what makes the
  support honest rather than assumed.
- **`import gemdb` works in a fresh database.** The `gemdb` module is deployed
  into the shipped extent, so it is there the moment the files are on disk
  rather than being cold-imported by each session.
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

### Fixed

- **`gemdb.transaction()` now reports only your own changes.** Capturing
  `print()` used to reassign a Smalltalk global, which left every evaluation's
  session with uncommitted writes of its own — so in a notebook,
  `with gemdb.transaction():` could never have worked. Output capture is now
  session-local and leaves nothing behind.

### Known limitations

- **Windows and Intel macOS are not supported.** Windows needs WSL and is
  further out. Intel macOS is a build away rather than a port — the code
  handles it, but a shim can only be compiled on the platform it targets, and
  Apple Silicon hardware and CI runners cannot produce one nobody has run.

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
- **The GemDB Shell.** A Python prompt that runs _inside_ the database, as a VS
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
  engine version _on_ the platform it targets, and a build missing the right one
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

[Unreleased]: https://github.com/GemTalk/GemDB_Code/compare/v1.8.0...HEAD
[1.8.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.5.4...v1.6.0
[1.5.4]: https://github.com/GemTalk/GemDB_Code/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/GemTalk/GemDB_Code/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/GemTalk/GemDB_Code/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/GemTalk/GemDB_Code/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/GemTalk/GemDB_Code/releases/tag/v1.0.0

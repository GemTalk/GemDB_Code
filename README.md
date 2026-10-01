# GemDB Code

GemDB Code installs GemDB, an object database, and lets you work with it using Python in VS Code.
Unlike a SQL database, there are no tables to design and no SQL to write: your Python objects are
stored as they are, and every commit is an ACID (atomic, consistent, isolated, durable) transaction.
Create objects, commit transactions, and explore your data without leaving your editor. The guided
walkthrough takes you from install to your first commit.

GemDB Code is in beta and is not intended for production use.

GemDB Code runs one GemDB database under `~/GemDB`, with no server to install and no credentials to
manage. After the setup finishes, you can start testing out the GemDB Shell or a GemDB Notebook, or
move on and explore [the Brain Freeze demo](#the-brain-freeze-demo).

GemDB Code runs on macOS with Apple Silicon and on Linux (x86-64 or ARM64) and needs VS Code 1.101
or later. For a complete list, see [Requirements](#requirements).

## Start here

1. **Install GemDB Code.** In the Extensions view, search for `GemDB Code` and click **Install**.
   The first time you install an extension from GemTalk Systems, VS Code prompts you to trust the
   publisher. Choose **Trust Publisher & Install**. Setup then starts on its own.

2. **Let initial setup finish.** Progress appears in notifications at the bottom right of VS Code.
   If you miss one, click the bell icon in the status bar. If the operating system needs a setting
   changed, follow the prompts. For more information, see
   [Setup and permissions](#setup-and-permissions).

3. **Open the GemDB Code sidebar.** For more information, see
   [The GemDB Code sidebar](#the-gemdb-code-sidebar).

4. **Follow the walkthrough.** VS Code opens **Get Started with GemDB Code** the first time you
   install GemDB Code. It takes you through setup, the GemDB Shell, a notebook, exploring a real
   application, and stopping the database. To open it again, see
   [The guided walkthrough](#the-guided-walkthrough).

5. **Try the Brain Freeze demo.** You are ready to explore a working application. When VS Code
   prompts you to trust the folder, choose to trust it, so Python can run there. For more
   information, see [Trusting `~/GemDB`](#trusting-gemdb). To get started, click
   [The Brain Freeze demo](#the-brain-freeze-demo).

## Features to check out

### Python REPL: the GemDB Shell

The GemDB Shell is a Python shell (a REPL, or read-eval-print loop) that runs inside the database.
For more information, see [Python in the database](#python-in-the-database).

### Jupyter notebooks

GemDB Code comes with a ready-made GemDB Notebook, with an example that shows GemDB in action. The
Python kernel is built into the extension, so you do not need the Jupyter extension or a local
Python install.

Click **New GemDB Notebook** (the notebook icon) at the top of the GemDB Code sidebar to open a
notebook with a starter cell, ready to run. If VS Code prompts you to pick a kernel, choose **GemDB
(Python in the database)**.

```python
# Python here runs inside your GemDB database.
# Everything reachable from gemdb.root is still there tomorrow.
import gemdb

gemdb.root["greeting"] = "Hello from GemDB!"
gemdb.commit()

gemdb.root["greeting"]
```

Running the cell shows `'Hello from GemDB!'`. For more information, see [Notebooks](#notebooks).

### MCP server for AI agents

GemDB Code includes an MCP (Model Context Protocol) server, so AI agents such as Claude Code or
Cursor can explore your data, run Python in your database, and commit changes. For more information,
see [Connecting an AI agent](#connecting-an-ai-agent).

---

## Reference

The rest of this page covers the details behind each feature.

- [Requirements](#requirements)
- [Platform support](#platform-support)
- [Setup and permissions](#setup-and-permissions)
- [The guided walkthrough](#the-guided-walkthrough)
- [The GemDB Code sidebar](#the-gemdb-code-sidebar)
- [Starting and stopping the database](#starting-and-stopping-the-database)
- [Sessions](#sessions)
- [Python in the database](#python-in-the-database)
- [The `gemdb` command](#the-gemdb-command)
- [Notebooks](#notebooks)
- [Connecting an AI agent](#connecting-an-ai-agent)
- [The Brain Freeze demo](#the-brain-freeze-demo)
- [Where things live](#where-things-live)
- [GemDB Code updates and associated data](#gemdb-code-updates-and-associated-data)
- [Settings](#settings)
- [Commands](#commands)
- [Using GemDB Code vs. GemStone/S](#using-gemdb-code-vs-gemstones)
- [Uninstalling](#uninstalling)
- [Privacy](#privacy)
- [License](#license)

### Requirements

GemDB Code is available from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gemtalksystems.gemdb) and,
for VSCodium and other compatible editors, from
[Open VSX](https://open-vsx.org/extension/gemtalksystems/gemdb).

**You need:**

- VS Code 1.101 or later. On a Mac, use the Apple Silicon build. On Linux, install VS Code from
  [code.visualstudio.com](https://code.visualstudio.com/download) (the `.deb` or `.rpm` package),
  not as a Snap, which is what Ubuntu's App Center installs. A Snap runs VS Code on an older copy of
  the system libraries than the database engine needs, so notebooks and the GemDB Shell cannot
  connect.
- A supported platform (see [Platform support](#platform-support)). On Linux, a glibc-based
  distribution; musl-based distributions such as Alpine are not supported.
- Permission to use `sudo` once if the operating system's shared-memory limit is below 1 GB. This is
  common on macOS and rare on Linux. The database does not start until the limit is raised. On
  Linux, `sudo` is also needed for the optional `RemoveIPC=no` setting (see
  [Changes that need your permission](#changes-that-need-your-permission)).
- Internet access to `dl.gemdb.com` for the one-time engine download.
- About 2 GB of free disk space under `~/GemDB` during setup, plus room for your data, on a local
  disk. If your home directory is on NFS, as it is on many shared Linux machines, see
  [Where things live](#where-things-live).
- At least 500 MB of free memory, and more as your data and the number of open notebooks grow.
- On Linux, `unzip`. Most distributions include it; if yours does not, install it with your package
  manager (for example, `sudo apt install unzip`).

**Needed only for some features:**

- `git`, for **Install Brain Freeze Demo**.
- An MCP client that supports the Streamable HTTP transport, and a free port on `127.0.0.1` (`50390`
  by default), for connecting an AI agent.

**You do not need:**

- A local Python installation. All Python runs inside the database, on the Python implementation
  that ships with the extension. GemDB Code never uses a Python installed on your machine.
- The Jupyter or Python extensions, or `ipykernel`. GemDB Notebooks use VS Code's built-in notebook
  support, so leave the built-in **Jupyter Notebook support** extension enabled. VS Code may offer
  to install Microsoft's Python extension when you open a notebook or Python file; GemDB Code does
  not need it.
- Node.js. The `gemdb` command runs on VS Code's own runtime.
- `pip` or a virtual environment. There is no package installation step; your own `.py` files can be
  imported once their directory is on `sys.path`.

### Platform support

| Platform             | Status        |
| -------------------- | ------------- |
| macOS, Apple Silicon | Supported     |
| Linux, x86-64        | Supported     |
| Linux, ARM64         | Supported     |
| macOS, Intel         | Not supported |
| Windows              | Not supported |

GemDB Code ships its Python runtime with a native library built for each platform's database engine,
so the extension is published per platform, and every supported platform is built and tested on its
own architecture. On an unsupported platform, the Marketplace still lists GemDB Code but marks it as
not available for that platform, and you cannot install it.

### Setup and permissions

#### How setup runs

In a local VS Code window, setup starts on its own the first time the extension activates on a
machine. GemDB Code downloads the database engine (about 145 MB on macOS, about 450 MB on Linux) and
creates one database under `~/GemDB`. In a remote window (SSH, WSL, dev containers), or after you
cancel setup, click **Set Up GemDB** in the GemDB Code sidebar, or run **GemDB: Set Up GemDB** from
the Command Palette.

You can cancel the download. Canceling keeps what has already been downloaded, and **Set Up GemDB**
picks up from there.

The first time the database starts, usually right after setup, GemDB Code installs Python support
into it. This takes a few minutes and shows its progress in a notification. If the database cannot
start yet, this happens the first time you open a shell or run a notebook cell instead.

#### Changes that need your permission

GemDB Code automates what is inert and reversible: files under `~/GemDB`, starting the database
(shown in the GemDB Code sidebar and the status bar, and stopped with one click), and adding `gemdb`
to VS Code's terminals (removed when you disable the extension). For anything persistent or
machine-wide, it prompts you and waits for your permission:

- **Raising shared memory** needs `sudo` and changes the machine for all software. GemDB Code checks
  whether the operating system's shared-memory limit is at least 1 GB when setup starts, while the
  engine downloads, and again each time the database starts. If the shared-memory setting is
  insufficient, GemDB Code prompts you for permission to raise the limit. This is often needed on
  macOS; most Linux systems already allow enough. When you choose **Configure**, GemDB Code opens a
  terminal where you type your password yourself. After the script runs, GemDB Code checks again. If
  shared memory is still below 1 GB, it shows an error and the database does not start. If you
  choose **Cancel**, the database cannot start, and the **Shared memory** row in the GemDB Code
  sidebar shows that the database cannot start until it has more shared memory. To address this
  requirement, start the database again, click that row, or run **GemDB: Configure Shared Memory**
  from the Command Palette.
- **On Linux, keeping the database running after you log out** needs systemd's `RemoveIPC=no`, which
  also needs `sudo`. This change is recommended but not required: the database starts without it. If
  the shared-memory dialog appears, it lists this change as recommended, and GemDB Code runs it in
  its own terminal. Otherwise, click the **Survives logout** row in the GemDB Code sidebar, or run
  **GemDB: Keep the Database Running After Logout** from the Command Palette. The change takes
  effect after you restart your computer.

#### Your shell profile and AI clients

GemDB Code never edits your shell profile. For the line to add to it, see
[The `gemdb` command](#the-gemdb-command).

AI client configuration is different: GemDB Code sets it up for you where it can, so each client
connects to the right MCP server. In VS Code, it registers the server automatically. For Claude
Code, it runs Claude Code's own `claude mcp add` command for the open folder and shows you how to
undo it. For Claude Desktop and Cursor, it copies a JSON snippet with the server's address for you
to merge into that client's configuration file. See
[Connecting an AI agent](#connecting-an-ai-agent).

#### Trusting `~/GemDB`

GemDB Code installs the Brain Freeze demo and its other folders under `~/GemDB`, and VS Code opens
any folder you have not trusted in Restricted Mode. So by default, GemDB Code's folders open in
Restricted Mode. There, you can use the GemDB Code sidebar and start or stop the database, but you
cannot run Python: notebook cells, **Run Python File in GemDB** and the GemDB Shell all wait until
you trust the folder, and connecting Claude Code needs a trusted folder too.

To work with GemDB Code, trust `~/GemDB` once: run **Workspaces: Manage Workspace Trust** from the
Command Palette and add `~/GemDB` to your trusted folders. VS Code also trusts its subfolders, so
the Brain Freeze demo and anything else GemDB Code installs there are covered, and no other folder
is affected. If you have not done this yet, VS Code prompts you the first time you run Python in one
of these folders. Choose **Trust Folder & Continue** to trust that folder.

### The guided walkthrough

The walkthrough, **Get Started with GemDB Code**, takes you through setup, the GemDB Shell, a
notebook, exploring a real application, and stopping the database. VS Code opens it automatically
only the first time you install GemDB Code. To open it again:

1. Open the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), type `Open Walkthrough`, and
   choose **Welcome: Open Walkthrough...**.
2. From the list, choose **Get Started with GemDB Code**. It is labeled **GemDB Code**, and you can
   type `GemDB` to narrow the list.

### The GemDB Code sidebar

Click the **GemDB Code** icon in the activity bar to open the sidebar. Its rows show whether the
database is **Running** or **Stopped**, the database engine version, the database, Python support,
AI agent access, and shared memory. On Linux, a **Survives logout** row appears when `RemoveIPC=no`
is not set. Click it to set it. Once a notebook in this window has started a session by running a
cell, a **Sessions** row also appears; if you do not see it, click **Refresh** (↻). See
[Sessions](#sessions).

The buttons along the top of the sidebar are:

- **Start GemDB** (▷) or **Stop GemDB** (■), depending on whether the database is running
- **Open GemDB Shell** (`>_`) and **New GemDB Notebook** (the notebook icon)
- **Refresh**
- **⋯**, a menu with everything else, including **Connect an AI Agent to GemDB** and **Uninstall
  GemDB**

The commands are also in the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), where each
name starts with **GemDB:**. Type `GemDB` there to list them. This page gives each command's sidebar
label, and uses the **GemDB:** form for commands that are only in the Command Palette.

While the database is running, the status bar at the bottom of the window also shows **GemDB**, and
clicking it stops the database.

### Starting and stopping the database

The database keeps running in the background after you close VS Code, so your data stays available
to scripts, terminals and agents. When the extension activates, GemDB Code starts the database if it
is set up and you have not stopped it yourself, so your first notebook cell does not have to wait.
Running Python also starts the database if it is not running.

If you stop the database yourself, with the **Stop GemDB** button in the GemDB Code sidebar or the
status bar, it stays stopped until something needs it again: you start it, you run Python in VS Code
or with the `gemdb` command, or an agent inside VS Code uses the MCP server. A database that stopped
for any other reason, such as a reboot, starts again the next time the extension activates.

When you stop the database, GemDB Code closes the sessions this window holds (its notebooks) and
stops the MCP server. Anything those sessions have not committed is lost, so commit before you stop.
If another session is still logged in, such as a GemDB Shell or a notebook in another window, GemDB
Code prompts you for approval before disconnecting it.

### Sessions

A _session_ is one logged-in connection to the database, with its own uncommitted changes. The
database that GemDB Code installs allows 10 sessions at once, and the database's own background
processes use some of them. Each GemDB Shell, each notebook that has run a cell, each running
`gemdb` script and each connected AI agent uses one session. GemDB Code itself holds one, and so
does the MCP server while it runs.

If you run out of sessions, GemDB Code shows an error that names the session in this window that has
been idle longest. Close a notebook or a GemDB Shell to free one. Once a notebook in this window has
run a cell, click **Refresh** (↻) at the top of the GemDB Code sidebar to see a **Sessions** row. It
shows how many sessions this window holds, and hovering over it lists each notebook and how long it
has been idle.

### Python in the database

Your code does not talk to the database over a connection: its objects _are_ the database's objects.
Put dicts, lists, or instances of your own classes under `gemdb.root` and commit. They are stored as
they are, and they persist across sessions and restarts. There is no object-relational mapper (ORM),
mapping layer or serialization step between your code and the database. Every commit is an ACID
transaction, and each shell, notebook and agent works in its own consistent view of the data.

Python runs inside the database on Grail, GemTalk Systems' implementation of Python for GemDB.

For example, a short session in the GemDB Shell looks like this:

```pycon
GemDB Shell — Python inside the database. This terminal is its own session.
Ctrl+C interrupts · exit() or Ctrl+D leaves
>>> import gemdb
>>> gemdb.root["customers"] = [{"name": "Ada", "orders": [1042, 1043]}]
>>> gemdb.commit()
>>> gemdb.root["customers"][0]["name"]
'Ada'
```

Close the shell, open a new one, and `gemdb.root["customers"]` is still there. The same code works
in a GemDB Notebook cell, or in a file you run with `gemdb <your-file>.py` in a VS Code terminal.
Plain `python3` cannot import `gemdb`, because the module lives inside the database.

| Call                   | What it does                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `gemdb.root`           | The persistent root, a dict                                                                                     |
| `gemdb.commit()`       | Makes this session's changes permanent; raises `ConflictError` if another session got there first               |
| `gemdb.abort()`        | Discards this session's uncommitted changes                                                                     |
| `gemdb.refresh()`      | Takes a fresh view to see other sessions' commits; raises `PendingChangesError` if you have uncommitted changes |
| `gemdb.needs_commit()` | Whether this session has changes that a commit would write                                                      |
| `gemdb.transaction()`  | A `with` block that commits when it finishes and aborts on an exception                                         |

```python
import gemdb

with gemdb.transaction():
    gemdb.root["visits"] = gemdb.root.get("visits", 0) + 1
```

`gemdb.transaction()` raises an error instead of starting if the session already has uncommitted
changes. Commit or abort them first.

Each session sees other sessions' commits after its own `refresh()`, `abort()` or `commit()`.

### The `gemdb` command

Setup writes a shell command to `~/GemDB/bin/gemdb` that behaves like CPython's command line, backed
by the database:

```sh
gemdb hello.py          # like python3 hello.py
gemdb -c 'print(1+1)'   # like python3 -c
gemdb -m some.module    # runs a module
gemdb                   # the GemDB Shell
```

Terminals you open in VS Code already have `gemdb` on their PATH. GemDB Code removes it again if you
disable the extension. To use `gemdb` in terminals outside VS Code, add this line to your shell
profile (adjust the path if you changed `gemdb.rootPath`):

```sh
export PATH="$HOME/GemDB/bin:$PATH"
```

The command needs no environment setup, and it starts the database if the database is not running.
Exit codes work the way scripts expect: 0 on success, 1 on an uncaught exception (with the error
message on stderr), 2 for a missing file, and `sys.exit()` behaves as in CPython.

One thing differs from `python3`: the script's directory is not included in `sys.path`, so the
script cannot import a file next to it until it updates `sys.path` to include its directory.

`input()` works in scripts, the GemDB Shell and notebooks. A script reads stdin, and the GemDB Shell
reads its own prompt line, where Ctrl+C raises `KeyboardInterrupt` and Ctrl+D raises `EOFError`.
`print()` streams, so output appears while the code is still running.

With no arguments, `gemdb` opens the **GemDB Shell**, the same program that the **Open GemDB Shell**
button opens in a terminal. Each shell is a separate session. Use `exit()` or Ctrl+D to leave.

To run the Python file in the active editor, use the Run button's menu (▷ with an arrow) at the top
right of the editor, or **GemDB: Run Python File in GemDB** in the Command Palette.

### Notebooks

GemDB Notebooks are ordinary `.ipynb` files. To run one, select the kernel **GemDB (Python in the
database)**.

- Variables are shared between the cells of a notebook. Running **GemDB: Clear Notebook Variables**
  from the Command Palette clears them without restarting the database. Uncommitted changes stay in
  the notebook's session; run `gemdb.abort()` to discard those too.
- `print()` output streams into the cell while the cell runs. `input()` opens an input box, and
  pressing Escape raises `KeyboardInterrupt`.
- `breakpoint()` pauses the cell and opens VS Code's debugger on it, with no setup: the Call Stack
  shows the Python frames, the paused line is highlighted, and Variables shows each frame's locals
  and the notebook's globals, expandable into attributes, items and entries, with classes and
  functions folded into their own rows. **Continue** resumes the cell where it paused; **Stop**
  ends it, along with any cells queued after it. Stepping and red-dot breakpoints are not supported
  yet. Right-click a Variables row and choose **Add to Persisted Objects…** to keep that object: it
  goes in `gemdb.root` under the key you give (one is suggested) and is written at the notebook's
  next commit. The **Persisted Objects** view, under GemDB and in Run and Debug, lists what `gemdb.root`
  holds; its title bar always has **Commit** and **Abort** for the notebook you are working in.
  In the GemDB Shell and in **Run Python File in GemDB**, `breakpoint()` prints where it was and
  the code carries on.
- Each notebook has its own session and its own transaction, so a commit in one notebook never
  commits another notebook's half-finished changes. Closing a notebook ends its session and discards
  anything it has not committed.
- A new notebook is untitled until you save it, and saving it for the first time starts a fresh
  session. Commit before you save, or save before you start work.
- Renaming a notebook from VS Code's Explorer keeps its session and variables. Renaming it outside
  VS Code, or using Save As, starts a new session.

### Connecting an AI agent

GemDB Code includes an MCP server, which lets an AI agent such as Claude Code work in your database
on your behalf. Because your data is made of Python objects, the agent works with it by running
Python in the database: for example, to answer a question about your data or to add an attribute to
a class. It can also list what is stored, search for classes and methods, define classes and
methods, and commit changes. The server accepts connections only from programs on your own computer
(`127.0.0.1`), so nothing on your network can reach your database through it.

The MCP server is off by default. Turning it on does not start anything by itself: it sets GemDB
Code to run the server whenever the database is running. The server starts when the database starts,
and stops when the database stops.

To connect Claude Code:

1. Open the folder you want Claude Code to work in, such as the
   [Brain Freeze demo](#the-brain-freeze-demo).
2. From the GemDB Code sidebar's **⋯** menu, choose **Connect an AI Agent to GemDB**. The first
   time, a dialog prompts you to turn the MCP server on. Choose **Turn It On**. GemDB Code starts
   the database, and with it the server, if they are not already running.
3. From the list of clients, choose **Claude Code**. GemDB Code runs Claude Code's `claude mcp add`
   command for that folder, and then shows you both the command it ran and the command that undoes
   it.
4. Start a new Claude Code conversation in that folder: run `claude` again in a terminal, or start a
   new conversation in the Claude Code panel. Claude Code reads its list of servers only when a
   conversation starts, so a conversation that was already open does not see GemDB.

About the Claude Code connection:

- **It applies to that folder only.** Claude Code conversations in other folders do not connect to
  GemDB. This is intentional: each connected conversation uses one of the database's limited
  sessions (see [Sessions](#sessions)).
- **The database must be running.** If you stop the database, restart it from the sidebar before you
  use Claude Code.
- **If you change the server's port** (`gemdb.mcp.port`), run **Connect an AI Agent to GemDB** again
  in that folder. GemDB Code prompts you before it replaces the old entry.
- **If GemDB Code cannot run the command,** because no folder is open or the `claude` command cannot
  be found, it copies the command for you to run from a terminal prompt in that folder. If the
  folder is not trusted, it shows a warning instead: choose **Manage Workspace Trust** to trust the
  folder, then connect again, or choose **Copy the Command** to run it yourself.

  ```sh
  claude mcp add --transport http gemdb http://127.0.0.1:50390/mcp
  ```

Connecting other AI clients:

- **Agents inside VS Code**, such as GitHub Copilot in agent mode, need no setup to connect to the
  MCP server. Once the server is on, it appears in VS Code's MCP server list. If the database is
  stopped when one of these agents tries to use it, GemDB Code starts it.
- **Claude Desktop and Cursor**: choose that client in step 3 instead. GemDB Code copies a JSON
  snippet for you to merge into that client's configuration file. Like Claude Code, these clients
  need the database to be running.
- **Any other MCP client** that supports the Streamable HTTP transport: choose **Something else** to
  copy the server's URL.

Keep the following in mind:

- **Each connected client gets its own session**, so agents never see each other's uncommitted work.
  Agents take sessions from the same limited pool as your notebooks and shells (see
  [Sessions](#sessions)), and the server itself holds one more.
- **A client that disconnects badly keeps its session for up to 30 minutes**, and reconnecting
  counts as a new client. An agent that repeatedly crashes and retries can use up every session and
  leave you unable to log in until those sessions are released. Stopping the database, or choosing
  **Restart the MCP Server** from the sidebar's **⋯** menu, releases them immediately. This is why
  the server is off by default.
- **A connected agent can change and commit data, and define code**, because running Python in your
  database is most of the point. Clicking the **Agent write access** row in the sidebar, or running
  **GemDB: Toggle Read-Only Access for AI Agents**, logs agents in as a database user that cannot
  commit. They can still read everything and run code, but nothing they do is saved. Switching it
  restarts the MCP server, which disconnects connected agents, and the first time you turn it on,
  GemDB Code adds an `McpReadOnly` user to your database.

### The Brain Freeze demo

To explore a working application, choose **Install Brain Freeze Demo** from the **⋯** menu in the
GemDB Code sidebar. It clones [brain-freeze](https://github.com/GemTalk/brain-freeze), a Flask app
whose data, classes and views all live in the database, into `~/GemDB/brain-freeze`, opens it, and
shows its README. Running it again opens the copy you have rather than replacing it. The command
needs `git`.

### Where things live

Everything GemDB Code creates is under one directory, `~/GemDB` by default (`gemdb.rootPath`):

| Path                                 | What it is                                        |
| ------------------------------------ | ------------------------------------------------- |
| `db/`                                | Your database, the only irreplaceable part        |
| `GemStone64Bit<version>-<platform>/` | The database engine                               |
| `grail/`                             | The Python runtime library and native shim        |
| `mcp/`                               | The MCP server, and the scripts to run it by hand |
| `bin/`                               | The `gemdb` command                               |
| `brain-freeze/`                      | The Brain Freeze demo, if you installed it        |
| `locks/`, `log/`, `mcp-router.json`  | Bookkeeping for the engine and the MCP server     |

The directory has to be on a local disk. The database engine refuses to open its files on an NFS
mount, so on a machine whose home directories are NFS mounts, `~/GemDB` cannot hold the database.
GemDB Code checks before setup downloads anything: if the directory is on NFS, it stops and offers
**Choose a Local Folder…**, which sets `gemdb.rootPath` to a `GemDB` folder inside the one you pick
and sets GemDB Code up there. To choose a location yourself, set `gemdb.rootPath` in your User
settings before you set up.

Avoid a folder that a sync service such as iCloud Drive, OneDrive or Dropbox copies, too. That is why
the default is `~/GemDB` rather than `~/Documents/GemDB`: `~/Documents` is commonly synced, and
letting a sync daemon copy a live database out from under the engine corrupts it.

### GemDB Code updates and associated data

Each GemDB Code release is tied to a database engine version. If a new release also moves to a newer
engine version, the database created by the earlier engine version cannot be opened by the newer
one. When this happens, GemDB Code shows a message before it starts the database, naming the
directory to remove. Removing that directory deletes everything stored in the database.

For this reason, you should not expect to keep access to your data after an update that changes the
engine version. VS Code updates extensions automatically, so such an update can arrive without you
choosing it. To decide when GemDB Code updates, clear **Auto Update** on its page in the Extensions
view.

Changing the engine version yourself with the `gemdb.engineVersion` setting has the same effect.

<!-- Restore once there is a supported export path:
To keep your data, copy out anything you need before you update GemDB Code.
-->

### Settings

The default GemDB Code settings are designed to work on most systems, so most users do not need to
change them. These include settings for locating where GemDB Code stores files, controlling how
Python support is updated, and setting up the MCP server for AI agents.

If you want to review them, open VS Code's Settings (Ctrl+, on Linux, or Cmd+, on macOS) and search
for `gemdb`, or go to **Extensions** > **GemDB Code** in the list on the left. If you need to
customize your setup, change them in your **User** settings. They apply to the one GemDB database on
this computer, so a value set in a workspace or folder is ignored, and Settings Sync does not copy
them to other computers. The following table lists all of the settings and the defaults.

| Setting                                  | Default         | What it does                                                                       |
| ---------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `gemdb.rootPath`                         | `~/GemDB`       | Where GemDB Code keeps everything; must be on a local disk                         |
| `gemdb.engineVersion`                    | _(empty)_       | Advanced: override the pinned engine version                                       |
| `gemdb.reinstallPythonOnUpdate`          | `true`          | Refresh Python support in your database when a GemDB Code update ships a newer one |
| `gemdb.mcp.enabled`                      | `false`         | Run the MCP server, so AI agents can reach your database                           |
| `gemdb.mcp.port`                         | `50390`         | The port it listens on, always on `127.0.0.1`                                      |
| `gemdb.mcp.readOnly`                     | `false`         | Log agents in as a database user that cannot commit                                |
| `gemdb.externalDatabase.gemstone`        | _(empty)_       | Advanced: use a database someone else runs, whose engine is here                   |
| `gemdb.externalDatabase.globalDirectory` | `/opt/gemstone` | That database's lock directory (`GEMSTONE_GLOBAL_DIR`)                             |
| `gemdb.externalDatabase.stone`           | `gs64stone`     | Its stone                                                                          |
| `gemdb.externalDatabase.netldi`          | `gs64ldi`       | Its NetLDI                                                                         |
| `gemdb.externalDatabase.user`            | `DataCurator`   | The account GemDB Code logs in as                                                  |
| `gemdb.externalDatabase.passwordFile`    | _(empty)_       | A file holding that account's password                                             |

Before you change the following settings, note these important details:

- **`gemdb.rootPath`**: GemDB Code does not move anything when you change it. Your existing database
  stays in the old directory, and the new one starts empty, so stop the database first, then run
  **Set Up GemDB** in the sidebar to set up the new location. Changing it also closes every
  notebook's session.
- **`gemdb.engineVersion`**: a database created by a different engine version cannot be opened. See
  [GemDB Code updates and associated data](#gemdb-code-updates-and-associated-data) before you
  change it.
- **`gemdb.mcp.enabled`**: if you turn it on here rather than with **Connect an AI Agent to GemDB**,
  the server starts the next time the database starts or you run Python.
- **`gemdb.mcp.port`**: after changing it, choose **Restart the MCP Server** from the sidebar's
  **⋯** menu, and update the URL in any external client you connected.
- **`gemdb.mcp.readOnly`**: changing it restarts the MCP server, which disconnects connected agents.
- **`gemdb.externalDatabase.*`**: for a machine where an administrator runs the database — a hosted
  or shared server. GemDB Code then installs Python support into your account and connects, and
  never downloads, creates, starts, stops or removes the database. See
  [Using a database someone else runs](docs/external-database.md) for what the administrator sets
  up.

### Commands

GemDB Code includes commands to run useful functions in VS Code. The GemDB Code sidebar presents
most of these, either as a button along its top or in its **⋯** menu. To run a command, either use
the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS) or run it from the sidebar. In the
Command Palette, type `GemDB` to list the commands. **GemDB: Run Python File in GemDB** appears only
when a Python file is open, and **GemDB: Keep the Database Running After Logout** appears only on
Linux. The table below reviews the functions available as commands or in the sidebar.

| Command Palette                                   | Sidebar                                                                                   | What it does                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **GemDB: Start GemDB**                            | ▷ button, or click the **Stopped** row                                                    | Starts the database                                                                                                           |
| **GemDB: Stop GemDB**                             | ■ button                                                                                  | Stops the database (clicking **GemDB** in the status bar does the same)                                                       |
| **GemDB: Open GemDB Shell**                       | `>_` button, or click the **Running** row                                                 | Opens a Python shell inside the database                                                                                      |
| **GemDB: New GemDB Notebook**                     | Notebook icon button                                                                      | Opens a notebook with a starter cell                                                                                          |
| **GemDB: Refresh**                                | ↻ button                                                                                  | Re-reads the state shown in the sidebar                                                                                       |
| **GemDB: Connect an AI Agent to GemDB**           | **⋯** menu, or click the **AI agent access** row                                          | Turns on the MCP server and connects Claude Code, or gives you another client's configuration                                 |
| **GemDB: Show Log**                               | **⋯** menu                                                                                | Opens GemDB Code's log                                                                                                        |
| **GemDB: Reinstall the Python Execution Engine**  | **⋯** menu, or click the **Python** row when an update is available or the install failed | Reinstalls Python support into your database                                                                                  |
| **GemDB: Restart the MCP Server**                 | **⋯** menu, while the database is running                                                 | Restarts the MCP server and releases agent sessions                                                                           |
| **GemDB: Install Brain Freeze Demo**              | **⋯** menu                                                                                | Clones the demo application into `~/GemDB/brain-freeze` and opens it                                                          |
| **GemDB: Uninstall GemDB**                        | **⋯** menu                                                                                | Removes the engine, Python support and MCP server, and optionally your database                                               |
| **GemDB: Set Up GemDB**                           | **Set Up GemDB** button, before setup has finished                                        | Runs or resumes setup                                                                                                         |
| **GemDB: Configure Shared Memory**                | Click the **Shared memory** row when it needs configuring                                 | Raises the shared-memory limit (prompts you for your password in a terminal)                                                  |
| **GemDB: Keep the Database Running After Logout** | Click the **Survives logout** row, shown on Linux when `RemoveIPC=no` is not set          | Sets `RemoveIPC=no` so the database keeps running after you log out (prompts you for your password in a terminal); Linux only |
| **GemDB: Toggle Read-Only Access for AI Agents**  | Click the **Agent write access** row, shown when the MCP server is on                     | Switches whether agents can commit, and restarts the MCP server                                                               |
| **GemDB: Run Python File in GemDB**               | None; use the Run button's menu at the top right of a Python file                         | Runs the current `.py` file in a terminal; listed only when a Python file is open                                             |
| **GemDB: Clear Notebook Variables**               | None                                                                                      | Clears the active notebook's variables                                                                                        |

### Using GemDB Code vs. GemStone/S

GemDB Code is deliberately small. It manages the database instance that comes with it for
demonstration purposes.

If you want to manage a GemStone/S server running your GemStone/S database, use
[Jasper: A GemStone Smalltalk IDE](https://marketplace.visualstudio.com/items?itemName=GemTalkSystems.gemstone-ide).
This full-featured extension exposes the full control surface, including a version picker, a
database list, a login manager, and a process view. GemDB Code and Jasper can be installed side by
side. GemDB Code keeps its files under `~/GemDB` and names its processes distinctly, so the
databases remain separately maintained and controlled.

### Uninstalling

Removing the extension from VS Code does not remove the database or anything under `~/GemDB`, and
the database keeps running after VS Code closes. Uninstall in this order:

1. **Open the GemDB Code sidebar.** Click the **GemDB Code** icon in the activity bar, on the far
   left of VS Code.
2. **Stop the database.** If the top row of the sidebar says **Running**, click **Stop GemDB** (■)
   at the top of the sidebar. Wait until the row says **Stopped**. GemDB Code will not remove its
   files while the database is running.
3. **Remove the database engine and Python support.** In the sidebar's **⋯** menu, choose
   **Uninstall GemDB**. The **Remove GemDB?** dialog shows where your database is and offers:
   - **Keep my database** removes the engine, Python support and the MCP server. Choose this option
     to leave your data in `~/GemDB/db`.
   - **Remove everything, including my data** also deletes the database. If you choose this option,
     it cannot be undone.
   - **Cancel** closes the dialog.
4. **Uninstall the extension.** Open the Extensions view, select **GemDB Code**, and click
   **Uninstall**. Then restart VS Code to finish removing it, as with any extension. After the
   restart, the **GemDB Code** icon is gone from the activity bar and `gemdb` is no longer on the
   PATH of VS Code's terminals.
5. **Delete `~/GemDB`** to remove what is left: the `gemdb` command, logs and bookkeeping files, the
   Brain Freeze demo and any commits you made in it, and your database if you kept it. The engine's
   files are read-only, so make them writable first: run `chmod -R u+w ~/GemDB`, then
   `rm -rf ~/GemDB`.

If you connected an AI agent outside VS Code, remove GemDB Code's entry from that client's
configuration too. For Claude Code, run `claude mcp remove gemdb --scope local` in the folder where
you connected it.

GemDB Code leaves the operating-system changes you approved during setup in place, because other
software may rely on them. To reverse them, delete GemDB Code's files, and then restart your
computer.

- On Linux:

  ```sh
  sudo rm -f /etc/sysctl.d/60-gemdb.conf /etc/systemd/logind.conf.d/gemdb.conf
  ```

- On macOS:

  ```sh
  sudo launchctl bootout system /Library/LaunchDaemons/com.gemdb.shared-memory.plist 2>/dev/null
  sudo rm -f /Library/LaunchDaemons/com.gemdb.shared-memory.plist
  ```

After the restart, shared memory (and on Linux, `RemoveIPC`) returns to the system default. Delete
only these files. Files with `gemstone` or `gemtalksystems` in their names belong to Jasper, and
while they are present, Jasper's settings stay in effect.

### Privacy

GemDB Code sends usage events that carry no content from your work. The events include a
pseudonymous VS Code machine ID and a coarse location, and VS Code's `telemetry.telemetryLevel`
setting controls them. See [USAGE_DATA.md](USAGE_DATA.md) for exactly what is and is not collected.

### License

MIT. See [LICENSE](LICENSE). GemDB Code reuses code from Jasper and bundles Grail and GemTalk's MCP
server, all from GemTalk Systems, plus the koffi library. See [NOTICE](NOTICE) for details. GemDB
Code downloads the database engine during setup, and the engine has its own license terms.

To build GemDB Code from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

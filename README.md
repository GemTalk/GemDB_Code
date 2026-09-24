# GemDB Code

Write Python. Run it inside a GemDB database.

GemDB Code installs GemDB, an object database, on your machine and lets you work with it from VS
Code. Unlike a SQL database, there are no tables to design and no SQL to write: your Python objects
are stored as they are, and every commit is an ACID (atomic, consistent, isolated, durable)
transaction. Create objects, commit transactions, and explore your data without leaving your editor.
The guided walkthrough takes you from install to your first commit.

GemDB Code runs on macOS with Apple Silicon and on Linux (x86-64 or ARM64) and needs VS Code 1.101
or later. For a complete list, see [Requirements](#requirements).

## Start here

1. **Open the GemDB Code sidebar.** Click the **GemDB Code** icon in the activity bar, the column of
   icons on the far left of VS Code. The sidebar shows whether setup has finished and whether the
   database is running, and its buttons open everything described below. See
   [The GemDB Code sidebar](#the-gemdb-code-sidebar).
2. **Let setup finish.** The first time GemDB Code runs, it downloads the database engine, creates
   your database under `~/GemDB` and starts it. Progress appears in notifications at the bottom
   right of VS Code. If the operating system needs a setting changed, a dialog prompts you for
   permission to make the change. On most macOS systems, the prompt is to raise shared memory. On
   Linux, while shared memory is usually already large enough, the dialog usually prompts you to set
   `RemoveIPC=no`, which keeps the database running after you log out. Choose **Configure**, then
   enter your password in the terminal that opens. Until you do, the database will not start. When
   setup finishes, a notification offers **Open GemDB Shell** and **New Notebook**. See
   [Setup and permissions](#setup-and-permissions).
3. **Follow the walkthrough.** VS Code opens **Get Started with GemDB Code** the first time you
   install GemDB Code. It takes you through setup, the GemDB Shell, a notebook, and stopping the
   database. To open it again:
   1. Open the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), type `Open Walkthrough`, and
      choose **Welcome: Open Walkthrough...**.
   2. From the list, choose **Get Started with GemDB Code**. It is labeled **GemDB Code** and you
      can type `GemDB` to narrow the list.
4. **Make your first commit.** Click **New GemDB Notebook** at the top of the sidebar and run the
   starter cell. If VS Code prompts you to pick a kernel, choose **GemDB (Python in the database)**.

   ```python
   # Python here runs inside your GemDB database.
   # Everything reachable from gemdb.root is still there tomorrow.
   import gemdb

   gemdb.root["greeting"] = "Hello from GemDB!"
   gemdb.commit()

   gemdb.root["greeting"]
   ```

   The cell shows `'Hello from GemDB!'`. Now try it yourself: close the notebook, open a new one,
   and run `import gemdb` and `gemdb.root["greeting"]` to read the value back. Then store something
   of your own the same way, such as a dict or a list, and commit it.

## What GemDB Code includes

### Built-in GemDB

GemDB Code installs and runs one GemDB database for you, under `~/GemDB`. There is no database
server to install, no connection string to configure, and no credentials to manage. The database
keeps running after you close VS Code, so it is available whenever you need it. See
[Starting and stopping the database](#starting-and-stopping-the-database).

### Python REPL: the GemDB Shell

The GemDB Shell is a Python shell (a REPL, or read-eval-print loop) that runs inside the database.
To open one, click **Open GemDB Shell** at the top of the GemDB Code sidebar. It has history, line
editing, a Ctrl+C that interrupts running code, and `input()` and `print()` that behave the way you
expect. For an example session and the Python API, see
[Python in the database](#python-in-the-database).

### Jupyter notebooks

Click **New GemDB Notebook** at the top of the GemDB Code sidebar to open a notebook with a starter
cell, ready to run. The kernel is built into the extension, so you do not need the Jupyter extension
or a local Python install. See [Notebooks](#notebooks).

### MCP server for AI agents

GemDB Code includes an MCP (Model Context Protocol) server, so AI agents such as Claude Code or
Cursor can explore your data, run Python in your database, and commit changes. It is off by default.
To turn it on, choose **Connect an AI Agent to GemDB** from the sidebar's **⋯** menu, but read
[Connecting an AI agent](#connecting-an-ai-agent) first.

---

## Reference

The rest of this page covers the details behind each feature.

- [Requirements](#requirements)
- [Platform support](#platform-support)
- [The GemDB Code sidebar](#the-gemdb-code-sidebar)
- [Setup and permissions](#setup-and-permissions)
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

- VS Code 1.101 or later. On a Mac, use the Apple Silicon build.
- A supported platform (see [Platform support](#platform-support)). On Linux, a glibc-based
  distribution; musl-based distributions such as Alpine are not supported.
- Permission to use `sudo` once if the operating system needs a setting changed: on macOS to raise
  shared memory to at least 1 GB, and on Linux usually to set `RemoveIPC=no`. The database will not
  start until this is done.
- Internet access to `dl.gemdb.com` for the one-time engine download.
- About 1.5 GB of free disk space under `~/GemDB` during setup, plus room for your data.
- On Linux, `unzip`. Most distributions include it; if yours does not, install it with your package
  manager (for example, `sudo apt install unzip`).

**Needed only for some features:**

- `git`, for **Clone the Brain Freeze Demo**.
- An MCP client that supports the Streamable HTTP transport, and a free port on `127.0.0.1` (`50390`
  by default), for connecting an AI agent.

**You do not need:**

- A local Python installation. All Python runs inside the database, on the Python implementation
  that ships with the extension. GemDB Code never uses a Python installed on your machine.
- The Jupyter or Python extensions, or `ipykernel`. GemDB Notebooks use VS Code's built-in notebook
  support, so leave the built-in **Jupyter Notebook support** extension enabled.
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

### The GemDB Code sidebar

Click the **GemDB Code** icon in the activity bar to open the sidebar. Its rows show whether the
database is **Running** or **Stopped**, the database engine version, the database, Python support,
AI agent access, and shared memory. Once a notebook in this window has started a session by running
a cell, a **Sessions** row also appears; if you do not see it, click **Refresh** (↻). See
[Sessions](#sessions).

The buttons along the top of the sidebar are:

- **Start GemDB** (▷) or **Stop GemDB** (■), depending on whether the database is running
- **Open GemDB Shell** and **New GemDB Notebook**
- **Refresh**
- **⋯**, a menu with everything else, including **Connect an AI Agent to GemDB** and **Uninstall
  GemDB**

Every command is also in the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), where its name
starts with **GemDB:**. Type `GemDB` there to list them all. This page gives each command's sidebar
label, and uses the **GemDB:** form for commands that are only in the Command Palette.

While the database is running, the status bar at the bottom of the window also shows **GemDB**, and
clicking it stops the database.

### Setup and permissions

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

GemDB Code automates what is inert and reversible: files under `~/GemDB`, starting the database
(shown in the GemDB Code sidebar and the status bar, and stopped with one click), and adding `gemdb`
to VS Code's terminals (removed when you disable the extension). For anything persistent or
machine-wide, it prompts you and waits for your permission:

- **Raising shared memory** needs `sudo` and changes the machine for all software. GemDB Code checks
  whether the operating system allows at least 1 GB of shared memory when setup starts, while the
  engine downloads, and again each time the database starts. If the shared memory setting is
  insufficient, GemDB Code prompts you for permission to raise the limit. This is often needed on
  macOS; most Linux systems already allow enough. When you choose **Configure**, GemDB Code opens a
  terminal where you type your password yourself. If you decline, the database cannot start, and the
  **Shared memory** row in the GemDB Code sidebar shows that it cannot start until it has more
  shared memory. To address this requirement, start the database again, click that row, or run
  **GemDB: Configure Shared Memory** from the Command Palette.
- **On Linux, keeping the database alive after you log out** needs systemd's `RemoveIPC=no`, which
  also needs `sudo`. The same dialog includes it, and GemDB Code runs it in its own terminal. Most
  Linux systems already allow enough shared memory, so this is often the only change the dialog
  lists on Linux. If you decline it, the database does not start.
- **Cloning the Brain Freeze demo** writes outside `~/GemDB`, so it happens only when you run the
  command and choose a folder. The demo is cloned into a `brain-freeze` folder inside the folder you
  choose, and the command needs `git`.

GemDB Code never edits your shell profile or any AI client's configuration files. For AI clients it
copies the command or snippet for you to paste. For your shell profile, see
[The `gemdb` command](#the-gemdb-command) for the line to add.

### Starting and stopping the database

The database runs as background processes that keep running after you close VS Code, so your data
stays available to scripts, terminals and agents. When the extension activates, GemDB Code starts
the database if it is set up and you have not stopped it yourself, so your first notebook cell does
not have to wait. Running Python also starts the database if it is not running.

If you stop the database yourself, with the **Stop GemDB** button in the GemDB Code sidebar or the
status bar, it stays stopped until something needs it again: you start it, you run Python in VS Code
or with the `gemdb` command, or a connected AI agent makes a tool call. A database that stopped for
any other reason, such as a reboot, starts again the next time the extension activates.

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
changes. A script run with the `gemdb` command starts with uncommitted changes, so in a script, call
`gemdb.commit()` or `gemdb.abort()` before the first `with gemdb.transaction():` block.

Each shell, notebook and agent works in its own session, with a consistent view of the database. A
session sees another session's commits after its own `refresh()`, `abort()` or `commit()`.

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

Some things differ from `python3`:

- The script's own directory is not on `sys.path`, so a script cannot import a file next to it until
  it adds its directory to `sys.path` itself.
- An uncaught exception prints its message, not a full traceback.
- A script starts with uncommitted changes (see [Python in the database](#python-in-the-database)).

`input()` works in scripts, the GemDB Shell and notebooks. A script reads stdin, and the GemDB Shell
reads its own prompt line, where Ctrl+C raises `KeyboardInterrupt` and Ctrl+D raises `EOFError`.
`print()` streams, so output appears while the code is still running.

With no arguments, `gemdb` opens the **GemDB Shell**, the same program that the **Open GemDB Shell**
button opens in a terminal. Each shell is a separate session. Use `exit()` or Ctrl+D to leave.

To run the Python file in the active editor, use the Run button at the top right of the editor, or
**GemDB: Run Python File in GemDB** in the Command Palette.

### Notebooks

GemDB Notebooks are ordinary `.ipynb` files. To run one, select the kernel **GemDB (Python in the
database)**.

- Variables are shared between the cells of a notebook. Running **GemDB: Clear Notebook Variables**
  from the Command Palette clears them without restarting the database. Uncommitted changes stay in
  the notebook's session; run `gemdb.abort()` to discard those too.
- `print()` output streams into the cell while the cell runs. `input()` opens an input box, and
  pressing Escape raises `KeyboardInterrupt`.
- Each notebook has its own session and its own transaction, so a commit in one notebook never
  commits another notebook's half-finished changes. Closing a notebook ends its session and discards
  anything it has not committed.
- A new notebook is untitled until you save it, and saving it for the first time starts a fresh
  session. Commit before you save, or save before you start work.
- Renaming a notebook from VS Code's Explorer keeps its session and variables. Renaming it outside
  VS Code, or using Save As, starts a new session.

### Connecting an AI agent

GemDB Code's MCP server lets an AI agent query and change your database directly. The agent can list
what is stored, browse and search classes and methods, run Python, define classes and methods, and
commit. The server starts and stops with the database and listens only on `127.0.0.1`.

**The server is off until you turn it on.** Choose **Connect an AI Agent to GemDB** from the GemDB
Code sidebar's **⋯** menu, then choose **Turn It On**. The server then registers itself with VS
Code, so it appears in this editor's MCP server list with no configuration. In VS Code, the first
time an agent uses the server, GemDB Code starts the database if it is not running. Clients outside
VS Code need the database to be running already.

For an agent outside VS Code, the same command lets you choose the client, and GemDB Code copies the
exact command or JSON that client needs. For Claude Code, for example:

```sh
claude mcp add --transport http gemdb http://127.0.0.1:50390/mcp
```

Claude Desktop and Cursor get a JSON snippet to merge into their configuration. Any client that
supports MCP's Streamable HTTP transport can use the URL directly.

Before you turn it on, note the following:

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

If you would rather read a working application than start from a blank prompt, choose **Clone the
Brain Freeze Demo** from the **⋯** menu in the GemDB Code sidebar. It clones
[brain-freeze](https://github.com/GemTalk/brain-freeze), a Flask app whose data, classes and views
all live in the database. The command needs `git`.

### Where things live

Everything GemDB Code creates is under one directory, `~/GemDB` by default (`gemdb.rootPath`):

| Path                                 | What it is                                        |
| ------------------------------------ | ------------------------------------------------- |
| `db/`                                | Your database, the only irreplaceable part        |
| `GemStone64Bit<version>-<platform>/` | The database engine                               |
| `grail/`                             | The Python runtime library and native shim        |
| `mcp/`                               | The MCP server, and the scripts to run it by hand |
| `bin/`                               | The `gemdb` command                               |
| `locks/`, `log/`, `mcp-router.json`  | Bookkeeping for the engine and the MCP server     |

The default is `~/GemDB` rather than `~/Documents/GemDB` on purpose. `~/Documents` is commonly
synced to iCloud Drive, and letting a sync daemon copy a live database out from under the engine
corrupts it.

### GemDB Code updates and associated data

Each GemDB Code release is tied to one database engine version. Some updates move to a new engine
version, and a database created by the earlier engine cannot be opened by the new one. There is no
in-place upgrade. When this happens, GemDB Code shows a message before it starts the database,
naming the directory to remove. Removing that directory deletes everything stored in the database.

To keep your data, copy out anything you need before you update GemDB Code. VS Code updates
extensions automatically by default. To choose when GemDB Code updates, clear **Auto Update** on its
page in the Extensions view.

The same guidance applies if you change the engine version yourself with the `gemdb.engineVersion`
setting.

> **REVIEWER QUESTION:** How do users copy their data? Can we add a useful detail to this section?

### Settings

The default GemDB Code settings are designed to work on most systems, so most users do not need to
change the default settings. These include settings for locating where GemDB Code stores files,
controlling how Python support is updated, and setting up the MCP server for AI agents.

If you want to review them, open VS Code's Settings (Ctrl+, on Linux, or Cmd+, on macOS) and search
for `gemdb`, or go to **Extensions** > **GemDB Code** in the list on the left. If you need to
customize your setup, update the settings in your **User** settings rather than a workspace's so
they apply to the GemDB database on your machine, not to a project. The following table lists all of
the settings and the defaults.

| Setting                         | Default   | What it does                                                                       |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `gemdb.rootPath`                | `~/GemDB` | Where GemDB Code keeps everything                                                  |
| `gemdb.engineVersion`           | _(empty)_ | Advanced: override the pinned engine version                                       |
| `gemdb.reinstallPythonOnUpdate` | `true`    | Refresh Python support in your database when a GemDB Code update ships a newer one |
| `gemdb.mcp.enabled`             | `false`   | Run the MCP server, so AI agents can reach your database                           |
| `gemdb.mcp.port`                | `50390`   | The port it listens on, always on `127.0.0.1`                                      |
| `gemdb.mcp.readOnly`            | `false`   | Log agents in as a database user that cannot commit                                |

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

### Commands

GemDB Code includes commands to run useful functions in VS Code. The GemDB Code sidebar presents
most of these, either as a button along its top or in its **⋯** menu. To run a command, either use
the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS) or run it from the sidebar. In the
Command Palette, type `GemDB` to list all commands. The table below reviews the functions available
as commands or in the sidebar.

| Command Palette                                  | Sidebar                                                               | What it does                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **GemDB: Start GemDB**                           | ▷ button, or click the **Stopped** row                                | Starts the database                                                               |
| **GemDB: Stop GemDB**                            | ■ button                                                              | Stops the database (clicking **GemDB** in the status bar does the same)           |
| **GemDB: Open GemDB Shell**                      | Terminal button, or click the **Running** row                         | Opens a Python shell inside the database                                          |
| **GemDB: New GemDB Notebook**                    | Notebook button                                                       | Opens a notebook with a starter cell                                              |
| **GemDB: Refresh**                               | ↻ button                                                              | Re-reads the state shown in the sidebar                                           |
| **GemDB: Connect an AI Agent to GemDB**          | **⋯** menu, or click the **AI agent access** row                      | Turns on the MCP server and gives you a client's configuration                    |
| **GemDB: Show Log**                              | **⋯** menu                                                            | Opens GemDB Code's log                                                            |
| **GemDB: Reinstall the Python Execution Engine** | **⋯** menu, or click the **Python** row when an update is available   | Reinstalls Python support into your database                                      |
| **GemDB: Restart the MCP Server**                | **⋯** menu, while the database is running                             | Restarts the MCP server and releases agent sessions                               |
| **GemDB: Clone the Brain Freeze Demo**           | **⋯** menu                                                            | Clones the demo application into a folder you choose                              |
| **GemDB: Uninstall GemDB**                       | **⋯** menu                                                            | Removes the engine, Python support and MCP server, and optionally your database   |
| **GemDB: Set Up GemDB**                          | **Set Up GemDB** button, before setup has finished                    | Runs or resumes setup                                                             |
| **GemDB: Configure Shared Memory**               | Click the **Shared memory** row when it needs configuring             | Raises the shared-memory limit (prompts you for your password in a terminal)      |
| **GemDB: Toggle Read-Only Access for AI Agents** | Click the **Agent write access** row, shown when the MCP server is on | Switches whether agents can commit, and restarts the MCP server                   |
| **GemDB: Run Python File in GemDB**              | None; use the Run button at the top right of a Python file            | Runs the current `.py` file in a terminal; listed only when a Python file is open |
| **GemDB: Clear Notebook Variables**              | None                                                                  | Clears the active notebook's variables                                            |

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
5. **Delete `~/GemDB`** to remove what is left: the `gemdb` command, logs and bookkeeping files, and
   your database if you kept it.

If you connected an AI agent outside VS Code, remove GemDB Code's entry from that client's
configuration too. For Claude Code, run `claude mcp remove gemdb`.

GemDB Code leaves the operating-system changes it asked you for in place, because other software may
rely on them. To reverse them on Linux, delete `/etc/sysctl.d/60-gemdb.conf` (shared memory) and
`/etc/systemd/logind.conf.d/gemdb.conf` (`RemoveIPC`) with `sudo`. The shared-memory limit returns
to the system default at the next restart.

### Privacy

GemDB Code sends usage events that carry no content from your work. The events include a
pseudonymous VS Code machine ID and a coarse location, and VS Code's `telemetry.telemetryLevel`
setting controls them. See [USAGE_DATA.md](USAGE_DATA.md) for exactly what is and is not collected.

### License

MIT. See [LICENSE](LICENSE). GemDB Code reuses code from Jasper and bundles Grail and GemTalk's MCP
server, all from GemTalk Systems, plus the koffi library. See [NOTICE](NOTICE) for details. GemDB
Code downloads the database engine during setup, and the engine has its own license terms.

To build GemDB Code from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

# GemDB Code

Write Python. Run it inside a GemDB database.

GemDB is an object database that runs Python natively. GemDB Code is the VS Code extension that
installs GemDB, runs it, and gives you a shell, notebooks and an AI-agent connection for working in
your database, all without leaving the editor.

Your code doesn't talk to the database over a connection: its objects _are_ the database's objects.
Put dicts, lists, or instances of your own classes under `gemdb.root` and commit. They are stored as
they are, and they persist across sessions and restarts. There is no object-relational mapper (ORM),
mapping layer or serialization step between your code and the database. Every commit is an ACID
transaction, and each shell, notebook and agent works in its own consistent view of the data.

GemDB Code runs on macOS with Apple Silicon and on Linux (x86-64 or ARM64) and needs VS Code 1.101
or later. For a complete list, see [Requirements](#requirements).

## Start here: the walkthrough

When you install GemDB Code, VS Code opens its walkthrough, **Get Started with GemDB Code**, and
setup starts at the same time:

- **What happens automatically:** GemDB Code downloads the database engine and creates your
  database. Progress appears in a notification at the bottom right of VS Code. The process also
  reviews your shared memory.
- **When you might see a prompt for input:** If it determines the operating system needs to increase
  your system's shared memory, a dialog asks your permission (often this is true on macOS). Choose
  **Configure**, then enter your password in the terminal prompt. The database can't start until
  shared memory is large enough.

When setup finishes, a notification offers **Open GemDB Shell** and **New Notebook**. The
walkthrough's steps cover the same ground: setup, your first Python in the GemDB Shell, your first
notebook, and stopping the database. The sections below give an overview of each feature, and
connecting an AI agent is covered in [its own section](#connecting-an-ai-agent).

VS Code opens the walkthrough automatically only the first time you install GemDB Code. To open it
again, run **Welcome: Open Walkthrough** from the Command Palette and choose **Get Started with
GemDB Code**.

If you'd rather read a working application than start from a blank prompt, choose **Clone the Brain
Freeze Demo** from the **⋯** menu in the GemDB Code sidebar. It clones
[brain-freeze](https://github.com/GemTalk/brain-freeze), a Flask app whose data, classes and views
all live in the database.

## What's in the box

### Built-in GemDB

The first time the extension activates in VS Code, it downloads the database engine and creates your
database under `~/GemDB`. There is no database server to install, no connection string to configure,
and no credentials to manage.

The database keeps its working data in shared memory. Once the operating system allows enough shared
memory, the database starts and stays available whenever you need it.

To manage the database, click the **GemDB Code** icon in the activity bar, the column of icons on
the far left of VS Code. This opens the **GemDB Code** sidebar. Its rows show whether the database
is **Running** or **Stopped**, the database engine version, the database, Python support, AI agent
access, and shared memory. The buttons along the top of the sidebar are:

- **Start GemDB** (▷) or **Stop GemDB** (■), depending on whether the database is running
- **Open GemDB Shell** and **New GemDB Notebook**
- **Refresh**
- **⋯**, a menu with everything else, including **Connect an AI Agent to GemDB** and **Uninstall
  GemDB**

Every command is also in the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), where its name
starts with **GemDB:**. Type `GemDB` there to list them all. This page gives each command's sidebar
label, and uses the **GemDB:** form for commands that are only in the Command Palette.

While the database is running, the status bar at the bottom of the window also shows **GemDB**, and
clicking it stops the database. (A _session_, mentioned throughout this page, is one logged-in
connection to the database with its own uncommitted changes.)

### Python REPL: the GemDB Shell

The GemDB Shell is a Python shell (a REPL, or read-eval-print loop) that runs inside the database.
To open one, click **Open GemDB Shell** at the top of the GemDB Code sidebar. It has history, line
editing, a Ctrl+C that interrupts running code, and `input()` and `print()` that behave the way you
expect. For an example session and the Python API, see
[Python in the database](#python-in-the-database).

### Jupyter notebooks

Click **New GemDB Notebook** at the top of the GemDB Code sidebar to open a notebook with a starter
cell, ready to run. If VS Code asks you to pick a kernel, choose **GemDB (Python in the database)**.
The kernel is built into the extension, so you don't need the Jupyter extension or a local Python
install. Each notebook has its own variables and its own transaction, so a commit in one notebook
never commits another notebook's half-finished changes.

### MCP server for AI agents

GemDB Code includes an MCP (Model Context Protocol) server. MCP is the standard way AI assistants
connect to outside tools, so an agent such as Claude Code or Cursor can explore your classes and
data, run Python against your database, and commit changes. To turn it on, choose **Connect an AI
Agent to GemDB** from the sidebar's **⋯** menu. The server then appears in VS Code's own MCP server
list, and for other clients GemDB Code copies the exact command or configuration to paste. The
server is off by default. See [Connecting an AI agent](#connecting-an-ai-agent) before turning it
on.

---

## Reference

The rest of this page covers the details behind each feature.

- [Requirements](#requirements)
- [Platform support](#platform-support)
- [Setup and permissions](#setup-and-permissions)
- [Starting and stopping the database](#starting-and-stopping-the-database)
- [Python in the database](#python-in-the-database)
- [The gemdb command](#the-gemdb-command)
- [Notebooks](#notebooks)
- [Connecting an AI agent](#connecting-an-ai-agent)
- [Sessions](#sessions)
- [Where things live](#where-things-live)
- [GemDB Code updates and associated data](#gemdb-code-updates-and-associated-data)
- [Settings](#settings)
- [Commands](#commands)
- [Using GemDB Code vs. GemStone](#using-gemdb-code-vs-gemstone)
- [Uninstalling](#uninstalling)
- [Privacy](#privacy)
- [Licence](#licence)

### Requirements

GemDB Code is available from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gemtalksystems.gemdb) and,
for VSCodium and other compatible editors, from
[Open VSX](https://open-vsx.org/extension/gemtalksystems/gemdb).

**You need:**

- VS Code 1.101 or later. On a Mac, use the Apple Silicon build.
- A supported platform (see [Platform support](#platform-support)). On Linux, a glibc-based
  distribution; musl-based distributions such as Alpine aren't supported.
- On macOS, and on any Linux system that allows less than 1 GB of shared memory, permission to use
  `sudo` once to raise the limit. The database can't start until this is done.
- Internet access to `dl.gemdb.com` for the one-time engine download.
- About 1.5 GB of free disk space under `~/GemDB` during setup, plus room for your data.
- On Linux, `unzip`. Most distributions include it; if yours doesn't, install it with your package
  manager (for example, `sudo apt install unzip`).

**Needed only for some features:**

- `git`, for **Clone the Brain Freeze Demo**.
- An MCP client that supports the Streamable HTTP transport, and a free port on `127.0.0.1` (`50390`
  by default), for connecting an AI agent.

**You don't need:**

- A local Python installation. All Python runs inside the database, on the Python implementation
  that ships with the extension. GemDB Code never uses a Python installed on your machine.
- The Jupyter or Python extensions, or `ipykernel`. GemDB notebooks use VS Code's built-in notebook
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
not available for that platform, and you can't install it.

### Setup and permissions

In a local VS Code window, setup starts on its own the first time the extension activates on a
machine. GemDB Code downloads the database engine (about 145 MB on macOS, about 450 MB on Linux) and
creates one database under `~/GemDB`. In a remote window (SSH, WSL, dev containers), or after you
cancel setup, click **Set Up GemDB** in the GemDB Code sidebar, or run **GemDB: Set Up GemDB** from
the Command Palette.

You can cancel the download. Cancelling keeps what has already been downloaded, and **Set Up GemDB**
picks up from there.

The first time the database starts, usually right after setup, GemDB Code installs Python support
into it. This takes a few minutes and shows its progress in a notification. If the database can't
start yet, this happens the first time you open a shell or run a notebook cell instead.

GemDB Code automates what is inert and reversible: files under `~/GemDB`, starting the database
(shown in the GemDB Code sidebar and the status bar, and stopped with one click), and adding `gemdb`
to VS Code's terminals (removed when you disable the extension). It asks first about anything
persistent or machine-wide:

- **Raising shared memory** needs `sudo` and changes the machine for all software, so GemDB Code
  always asks. The question appears while the engine downloads. When you choose **Configure**, GemDB
  Code opens a terminal where you type your password yourself. If you decline, the database can't
  start until shared memory is raised. The **Shared memory** row in the GemDB Code sidebar keeps
  showing what's needed, and GemDB Code asks again the next time you start the database or run
  Python. To be asked again at any time, click the **Shared memory** row in the sidebar when it says
  it needs configuring, or run **GemDB: Configure Shared Memory** from the Command Palette.
- **On Linux, keeping the database alive after you log out** needs systemd's `RemoveIPC=no`, which
  also needs `sudo`. GemDB Code asks for it in the same prompt and runs it in its own terminal.
- **Cloning the Brain Freeze demo** writes outside `~/GemDB`, so it happens only when you run the
  command and choose a folder. The demo is cloned into a `brain-freeze` folder inside the folder you
  choose, and the command needs `git`.

GemDB Code never edits your shell profile or any AI client's configuration files. For AI clients it
copies the command or snippet for you to paste. For your shell profile, see
[The gemdb command](#the-gemdb-command) for the line to add.

### Starting and stopping the database

The database runs as background processes that keep running after you close VS Code, so your data
stays available to scripts, terminals and agents. When the extension activates, GemDB Code starts
the database if it's set up and you haven't stopped it yourself, so your first notebook cell doesn't
have to wait. Running Python also starts the database if it isn't running.

If you stop the database yourself, with the **Stop GemDB** button in the GemDB Code sidebar or the
status bar, it stays stopped until something asks for it again: you start it, you run Python in VS
Code or with the `gemdb` command, or a connected AI agent makes a tool call. A database that stopped
for any other reason, such as a reboot, starts again the next time the extension activates.

When you stop the database, GemDB Code closes the sessions this window holds (its notebooks) and
stops the MCP server. Anything those sessions haven't committed is lost, so commit before you stop.
If another session is still logged in, such as a GemDB Shell or a notebook in another window, GemDB
Code asks before disconnecting it.

### Python in the database

Python runs inside the database on Grail, GemTalk Systems' implementation of Python for GemDB.
Everything reachable from `gemdb.root` persists: dicts, lists, instances of your own classes, and
whole object graphs. Changes become permanent when you commit.

Here is a short session in the GemDB Shell:

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
in a GemDB notebook cell, or in a file you run with `gemdb yourfile.py` in a VS Code terminal. Plain
`python3` can't import `gemdb`, because the module lives inside the database.

| Call                   | What it does                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `gemdb.root`           | the persistent root, a dict                                                                       |
| `gemdb.commit()`       | makes this session's changes permanent; raises `ConflictError` if another session got there first |
| `gemdb.abort()`        | discards this session's uncommitted changes                                                       |
| `gemdb.refresh()`      | takes a fresh view to see other sessions' commits; refuses if you have uncommitted changes        |
| `gemdb.needs_commit()` | whether this session has changes that a commit would write                                        |
| `gemdb.transaction()`  | a `with` block that commits when it finishes and aborts on an exception                           |

```python
import gemdb

with gemdb.transaction():
    gemdb.root["visits"] = gemdb.root.get("visits", 0) + 1
```

`gemdb.transaction()` refuses to start if the session already has uncommitted changes. A script run
with the `gemdb` command starts with uncommitted changes, so in a script, call `gemdb.commit()` or
`gemdb.abort()` before the first `with gemdb.transaction():` block.

Each shell, notebook and agent works in its own session, with a consistent view of the database. A
session sees another session's commits after its own `refresh()`, `abort()` or `commit()`.

### The gemdb command

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

The command needs no environment setup, and it starts the database if the database isn't running.
Exit codes work the way scripts expect: 0 on success, 1 on an uncaught exception (with the error
message on stderr), 2 for a missing file, and `sys.exit()` behaves as in CPython.

Some things differ from `python3`:

- The script's own directory isn't on `sys.path`, so a script can't import a file next to it until
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

GemDB notebooks are ordinary `.ipynb` files. To run one, select the kernel **GemDB (Python in the
database)**.

- Variables are shared between the cells of a notebook. Running **GemDB: Clear Notebook Variables**
  from the Command Palette clears them without restarting the database. Uncommitted changes stay in
  the notebook's session; run `gemdb.abort()` to discard those too.
- `print()` output streams into the cell while the cell runs. `input()` opens an input box, and
  pressing Escape raises `KeyboardInterrupt`.
- Each notebook has its own session. Closing a notebook ends its session and discards anything it
  hasn't committed.
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
time an agent uses the server, GemDB Code starts the database if it isn't running. Clients outside
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
  **GemDB: Toggle Read-Only Access for AI Agents**, logs agents in as a database user that can't
  commit. They can still read everything and run code, but nothing they do is saved. Switching it
  restarts the MCP server, which disconnects connected agents, and the first time you turn it on,
  GemDB Code adds an `McpReadOnly` user to your database.

### Sessions

The database that GemDB Code installs allows 10 sessions at once, and the database's own background
processes use some of them. Each GemDB Shell, each notebook that has run a cell, each running
`gemdb` script and each connected AI agent uses one session. GemDB Code itself holds one, and so
does the MCP server while it runs.

If you run out of sessions, GemDB Code tells you, and names the session in this window that has been
idle longest. Close a notebook or a GemDB Shell to free one. Once a notebook in this window has run
a cell, click **Refresh** (↻) at the top of the GemDB Code sidebar to see a **Sessions** row. It
shows how many sessions this window holds, and hovering over it lists each notebook and how long it
has been idle.

### Where things live

Everything GemDB Code creates is under one directory, `~/GemDB` by default (`gemdb.rootPath`):

| Path                                 | What it is                                        |
| ------------------------------------ | ------------------------------------------------- |
| `db/`                                | your database, the only irreplaceable part        |
| `GemStone64Bit<version>-<platform>/` | the database engine                               |
| `grail/`                             | the Python runtime library and native shim        |
| `mcp/`                               | the MCP server, and the scripts to run it by hand |
| `bin/`                               | the `gemdb` command                               |
| `locks/`, `log/`, `mcp-router.json`  | bookkeeping for the engine and the MCP server     |

The default is `~/GemDB` rather than `~/Documents/GemDB` on purpose. `~/Documents` is commonly
synced to iCloud Drive, and letting a sync daemon copy a live database out from under the engine
corrupts it.

### GemDB Code updates and associated data

Each GemDB Code release is tied to one database engine version. Some updates move to a new engine
version, and a database created by the earlier engine can't be opened by the new one. There is no
in-place upgrade. When this happens, GemDB Code tells you before it starts the database and names
the directory to remove. Removing that directory deletes everything stored in the database.

To keep your data, copy out anything you need before you update GemDB Code. VS Code updates
extensions automatically by default. To choose when GemDB Code updates, clear **Auto Update** on its
page in the Extensions view.

The same guidance applies if you change the engine version yourself with the `gemdb.engineVersion`
setting.

> **REVIEWER QUESTION:** How do users copy their data? Can we add a useful detail to this section?

### Settings

The default GemDB Code settings are designed to work on most systems, so most users don't need to
change the default settings. These include settings for locating where GemDB Code stores files,
controlling how Python support is updated, and setting up the MCP server for AI agents.

If you want to review them, open VS Code's Settings (Ctrl+, on Linux, or Cmd+, on macOS) and search
for `gemdb`, or go to **Extensions** > **GemDB Code** in the list on the left. If you need to
customize your setup, update the settings in your **User** settings rather than a workspace's so
they apply to the GemDB database on your machine, not to a project. The following table lists all of
the settings and the defaults.

| Setting                         | Default   | What it does                                                                       |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `gemdb.rootPath`                | `~/GemDB` | where GemDB Code keeps everything                                                  |
| `gemdb.engineVersion`           | _(empty)_ | advanced: override the pinned engine version                                       |
| `gemdb.reinstallPythonOnUpdate` | `true`    | refresh Python support in your database when a GemDB Code update ships a newer one |
| `gemdb.mcp.enabled`             | `false`   | run the MCP server, so AI agents can reach your database                           |
| `gemdb.mcp.port`                | `50390`   | the port it listens on, always on `127.0.0.1`                                      |
| `gemdb.mcp.readOnly`            | `false`   | log agents in as a database user that can't commit                                 |

Before you change the following settings, note these important details:

- **`gemdb.rootPath`**: GemDB Code doesn't move anything when you change it. Your existing database
  stays in the old directory, and the new one starts empty, so stop the database first, then run
  **Set Up GemDB** in the sidebar to set up the new location. Changing it also closes every
  notebook's session.
- **`gemdb.engineVersion`**: a database created by a different engine version can't be opened. See
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
| **GemDB: Start GemDB**                           | ▷ button, or click the **Stopped** row                                | starts the database                                                               |
| **GemDB: Stop GemDB**                            | ■ button                                                              | stops the database (clicking **GemDB** in the status bar does the same)           |
| **GemDB: Open GemDB Shell**                      | terminal button, or click the **Running** row                         | opens a Python shell inside the database                                          |
| **GemDB: New GemDB Notebook**                    | notebook button                                                       | opens a notebook with a starter cell                                              |
| **GemDB: Refresh**                               | ↻ button                                                              | re-reads the state shown in the sidebar                                           |
| **GemDB: Connect an AI Agent to GemDB**          | **⋯** menu, or click the **AI agent access** row                      | turns on the MCP server and gives you a client's configuration                    |
| **GemDB: Show Log**                              | **⋯** menu                                                            | opens GemDB Code's log                                                            |
| **GemDB: Reinstall the Python Execution Engine** | **⋯** menu, or click the **Python** row when an update is available   | reinstalls Python support into your database                                      |
| **GemDB: Restart the MCP Server**                | **⋯** menu, while the database is running                             | restarts the MCP server and releases agent sessions                               |
| **GemDB: Clone the Brain Freeze Demo**           | **⋯** menu                                                            | clones the demo application into a folder you choose                              |
| **GemDB: Uninstall GemDB**                       | **⋯** menu                                                            | removes the engine, Python support and MCP server, and optionally your database   |
| **GemDB: Set Up GemDB**                          | **Set Up GemDB** button, before setup has finished                    | runs or resumes setup                                                             |
| **GemDB: Configure Shared Memory**               | click the **Shared memory** row when it needs configuring             | raises the shared-memory limit (asks for your password)                           |
| **GemDB: Toggle Read-Only Access for AI Agents** | click the **Agent write access** row, shown when the MCP server is on | switches whether agents can commit, and restarts the MCP server                   |
| **GemDB: Run Python File in GemDB**              | none; use the Run button at the top right of a Python file            | runs the current `.py` file in a terminal; listed only when a Python file is open |
| **GemDB: Clear Notebook Variables**              | none                                                                  | clears the active notebook's variables                                            |

### Using GemDB Code vs. GemStone

GemDB Code is deliberately small. It manages the database instance that comes with it for
demonstration purposes.

If you want to manage a GemStone server running your GemStone database, use
[Jasper: A GemStone Smalltalk IDE](https://marketplace.visualstudio.com/items?itemName=GemTalkSystems.gemstone-ide).
This full-featured extension exposes the full control surface, including a version picker, a
database list, a login manager, and a process view. GemDB Code and Jasper can be installed side by
side. GemDB Code keeps its files under `~/GemDB` and names its processes distinctly, so the
databases remain separately maintained and controlled.

### Uninstalling

Removing the extension from VS Code doesn't remove the database or anything under `~/GemDB`, and the
database keeps running after VS Code closes. Uninstall in this order:

1. **Open the GemDB Code sidebar.** Click the **GemDB Code** icon in the activity bar, on the far
   left of VS Code.
2. **Stop the database.** If the top row of the sidebar says **Running**, click **Stop GemDB** (■)
   at the top of the sidebar. Wait until the row says **Stopped**. GemDB Code won't remove its files
   while the database is running.
3. **Remove the database engine and Python support.** In the sidebar's **⋯** menu, choose
   **Uninstall GemDB**. The **Remove GemDB?** dialog shows where your database is and offers:
   - **Keep my database** removes the engine, Python support and the MCP server. Choose this option
     to leave your data in `~/GemDB/db`.
   - **Remove everything, including my data** also deletes the database. If you choose this option,
     it can't be undone.
   - **Cancel** closes the dialog.
4. **Uninstall the extension.** Open the Extensions view, select **GemDB Code**, and click
   **Uninstall**. Then restart VS Code to finish removing it, as with any extension. After the
   restart, the **GemDB Code** icon is gone from the activity bar and `gemdb` is no longer on the
   PATH of VS Code's terminals.
5. **Delete `~/GemDB`** to remove what's left: the `gemdb` command, logs and bookkeeping files, and
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
setting controls them. See [USAGE_DATA.md](USAGE_DATA.md) for exactly what is and isn't collected.

### Licence

MIT. See [LICENSE](LICENSE). GemDB Code reuses code from Jasper and bundles Grail and GemTalk's MCP
server, all from GemTalk Systems, plus the koffi library. See [NOTICE](NOTICE) for details. The
database engine is downloaded at install time under its own licence terms.

To build GemDB Code from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

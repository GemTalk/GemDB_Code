## Keeping the database running, and when to stop it

The database keeps running after you close VS Code, so your data stays available to scripts,
terminals and AI agents. GemDB Code starts it for you, so you never need to start it before running
Python.

### Why stop it

While it runs, the database uses some of your computer's memory, even with VS Code closed. Stop it
when you are done working with GemDB for a while and want that memory back, or before you uninstall
GemDB Code.

### How to stop it

- In the **status bar**, click **GemDB**. It appears whenever the database is running.
- In the **GemDB Code sidebar**, click **Stop GemDB** (■).

### What happens to your work

When you stop the database, everything you have committed is saved. Uncommitted changes in open
notebooks and GemDB Shells are discarded, so commit before you stop. If a GemDB Shell or a notebook
in another window is still connected, GemDB Code prompts you before disconnecting it.

### Starting it again

After you stop it, GemDB Code no longer starts the database automatically, even after you restart VS
Code or your computer. It starts again when you need it: you click **Start GemDB**, you run Python
in VS Code or with the `gemdb` command, or an AI agent in VS Code uses the MCP server.

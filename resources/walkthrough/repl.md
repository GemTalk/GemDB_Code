## The GemDB Shell

The GemDB Shell opens a Python prompt that runs _inside_ the database:

```
>>> import gemdb
>>> gemdb.root["answer"] = 42
>>> gemdb.commit()
>>> gemdb.root["answer"]
42
```

Anything you commit is still there in the next session. That is the point of running Python in a
database rather than beside one.

- **Ctrl+C** interrupts whatever is running with a `KeyboardInterrupt`, as in any Python.
- **`exit()`** or **Ctrl+D** leaves the shell.
- **Opening it again** gives you a _second_ terminal, not the first one back. Each shell is its own
  database session: two terminals hold separate uncommitted work, and each sees the other's commits
  after its own `commit()`, `abort()`, or `refresh()`.

### When the database is not running

If GemDB Code runs your database, it starts the database automatically when you open VS Code, so
you do not have to. If you stop it manually, GemDB Code no longer starts it automatically, even
after you restart VS Code or your computer.

The database starts again when you need it, when you:

- Click **Start GemDB** (▷) in the GemDB Code sidebar
- Run Python in a notebook
- Open a GemDB Shell
- Run a script with the `gemdb` command
- Use an AI agent connected through the MCP server in VS Code

If you use a database that this machine's administrator runs, GemDB Code does not start or stop it.
When it is down, GemDB Code says so instead of opening the shell. Ask the administrator to start
it.

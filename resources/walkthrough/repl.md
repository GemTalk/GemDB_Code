## The Python REPL

Opens a Python prompt that runs *inside* the database:

```
>>> import gemstone
>>> gemstone["answer"] = 42
>>> gemstone.system.commit()
>>> gemstone["answer"]
42
```

Anything you commit is still there in the next session — that is the point of
running Python in a database rather than beside one.

- **Ctrl+C** interrupts whatever is running — a `KeyboardInterrupt`, like any
  Python. It never lands you anywhere strange.
- **`exit()`** or **Ctrl+D** leaves.
- **Open it again** and you get a *second* terminal, not the first one back.
  Each REPL is its own database session: two terminals hold separate
  uncommitted work, and see each other's exactly at `commit()`.

GemDB starts the database for you, so it's normally already running by the
time you get here. If you stop it yourself, it stays stopped until you start it
again or run some Python — GemDB won't quietly restart something you turned
off.

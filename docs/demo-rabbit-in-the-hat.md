# Pulling a rabbit out of a hat

A five-minute demo of the two things GemDB is for: **objects that outlive the
program without being saved**, and **sessions as units of work**.

The scripts are in [`demo/`](demo/). Every command and every line of output
below was run against a real database on 2026-08-23; where something surprised
me, that is noted rather than tidied away.

> **Before you start.** GemDB must be installed (open VS Code once and let it
> finish setting up). A terminal opened in VS Code has `gemdb` on its PATH
> already; in any other terminal, put it there:
>
> ```sh
> export PATH="$HOME/GemDB/bin:$PATH"   # not needed in a VS Code terminal
> cd docs/demo
> ```
>
> Nothing else. You do not create a database, choose a file format, or start a
> server — and if the database happens to be stopped, `gemdb` starts it.

---

## Act 1 — Put the rabbit in the hat

[`hide.py`](demo/hide.py):

```python
import gemdb

RABBIT = r"""
    (\(\
    ( -.-)
    o_(")(")
"""

gemdb.root["hat"] = RABBIT
gemdb.commit()

print("Rabbit stowed.")
```

```console
$ gemdb hide.py
Rabbit stowed.
```

Two lines did the work. `gemdb.root` is a dictionary that lives in the
database, so the assignment puts a Python object *there* rather than in this
process. `commit()` is the moment it becomes everyone's.

There is no `open()`, no `json.dumps`, no `pickle`, no schema and no migration.
The rabbit is stored as the string it is.

## Act 2 — A different process pulls it out

[`reveal.py`](demo/reveal.py):

```python
import gemdb

if "hat" not in gemdb.root:
    raise SystemExit("The hat is empty. Run hide.py first.")

print(gemdb.root["hat"])
```

```console
$ gemdb reveal.py

    (\(\
    ( -.-)
    o_(")(")

```

This is a **different operating-system process** and a different database
session. Nothing was loaded, because nothing was saved: the rabbit never left
the database, and `reveal.py` simply looked where it was.

## Act 3 — Now stop the database entirely

Click the GemDB entry in the VS Code status bar, or run **GemDB: Stop GemDB**
from the command palette. Then, with no database running at all:

```console
$ gemdb reveal.py
gemdb: starting the database…

    (\(\
    ( -.-)
    o_(")(")

```

The wrapper noticed the database was down, started it, and the rabbit was still
in the hat. (Measured exactly this way: the stone was confirmed stopped, then
`gemdb reveal.py` brought it back and printed the rabbit.)

This is the whole point of the demo. At no stage did any program serialise
anything, and at no stage was there a file the program knew about.

## Act 4 — A counter that survives everything

[`tricks.py`](demo/tricks.py) increments a number and commits it:

```python
import gemdb

gemdb.root["tricks"] = gemdb.root.get("tricks", 0) + 1
gemdb.commit()

print("Tricks performed:", gemdb.root["tricks"])
```

```console
$ gemdb tricks.py
Tricks performed: 1
$ gemdb tricks.py
Tricks performed: 2
$ gemdb tricks.py
Tricks performed: 3
```

Stop the database, start it, run it again: `4`.

---

## Act 5 — Two sessions at once

This is the part a file cannot show you. Open **two** GemDB Shells — the
command palette's *GemDB: Open GemDB Shell*, twice, or `gemdb` with no
arguments in two terminals.

Each shell is its own session, which means its own transaction. Call them
**A** and **B**.

**A** swaps the rabbit for a dove, but does not commit:

```pycon
>>> import gemdb
>>> gemdb.root["hat"] = "a dove"
>>> gemdb.needs_commit()
True
```

**B** looks in the hat:

```pycon
>>> import gemdb
>>> print(gemdb.root["hat"])

    (\(\
    ( -.-)
    o_(")(")

```

Still a rabbit. A's work is real, but it is A's alone until it commits.

**A** commits:

```pycon
>>> gemdb.commit()
>>>
```

**B** looks again — and this is the part worth pausing on:

```pycon
>>> print(gemdb.root["hat"])

    (\(\
    ( -.-)
    o_(")(")

```

**Still a rabbit.** B is not out of date by accident; B is holding a consistent
view of the database taken when its transaction began, and a commit by someone
else does not reach in and change what B is looking at halfway through its own
work. B asks for a newer view when it is ready:

```pycon
>>> gemdb.refresh()
>>> print(gemdb.root["hat"])
a dove
```

### `refresh()` will not throw your work away

Suppose B has its own uncommitted change:

```pycon
>>> gemdb.root["hat"] = "oops"
>>> gemdb.refresh()
Error: PendingChangesError - refresh() would discard uncommitted changes; commit() to keep them or abort() to discard them first
```

Refreshing means "adopt everyone else's view", which would silently drop B's
edit. So it refuses and says what the two honest options are:

```pycon
>>> gemdb.abort()
>>> print(gemdb.root["hat"])
a dove
```

## Act 6 — Doing it as one unit

In a shell or a notebook, `with gemdb.transaction():` commits when the block
exits and abandons the changes if it raises, so a multi-step change is never
left half-applied:

```pycon
>>> import gemdb
>>> with gemdb.transaction():
...     gemdb.root["tricks"] = gemdb.root.get("tricks", 0) + 1
...
>>> gemdb.needs_commit()
False
```

> **Known gap.** This does *not* work as the first statement of a script run
> with `gemdb yourfile.py` (or `-c`, or `-m`): the block refuses to start,
> reporting pending changes you did not make. Running a file leaves the session
> with uncommitted changes before your first line executes — measured — so
> `transaction()`'s entry check, which exists to stop it sweeping your
> forgotten work into its commit, fires on Grail's own plumbing. Until that is
> fixed upstream, scripts should use `commit()` as `tricks.py` does, or call
> `gemdb.abort()` before the first block.

---

## The whole API used here

| Call | What it does |
| --- | --- |
| `gemdb.root` | the persistent dictionary; assignment stores a live Python object |
| `gemdb.commit()` | make this session's changes everyone's; raises `ConflictError` if someone else got there first |
| `gemdb.abort()` | discard this session's changes and take a fresh view |
| `gemdb.refresh()` | take a fresh view, refusing if that would discard your work |
| `gemdb.needs_commit()` | does this session hold changes a commit would write? |
| `gemdb.transaction()` | a block that commits on exit and aborts on exception |
| `gemdb.root.get` / `.setdefault` / `.keys` / `.pop` / `in` / `len` | the dict methods you would expect |

## In a notebook

The same demo works cell by cell, with one difference worth knowing: **each
notebook gets its own session**, exactly like each shell. Two notebooks open at
once behave as A and B do above — separate variables, separate transactions —
and a `commit()` in one becomes visible in the other after a `refresh()`.

## Where to go next

- `gemdb.root` holds any Python object, not just strings — dicts, lists, class
  instances, and objects that reference each other. There is no size at which
  you have to start thinking about a file format.
- `gemdb.sessions.all()` lists every session on the database, including the
  system's own gems, so you can see the two shells from Act 5 from either one.

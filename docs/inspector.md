# The Inspector

**Inspect**, on a Variables row or a Persisted Objects row, opens an object in an editor-tab
webview: a strip of columns, one object each, with tabs for what the object has. It is Jasper's
basic Inspector brought over for Python. This note says what was kept from Jasper, what changed and
why, how the panel holds its objects, and what was measured.

## What came from Jasper, and how it stays in step

Three scripts make the page, read from `resources/inspector/` at run time and injected as
`<script>` tags (`src/inspector.ts`), so they are plain browser JavaScript and not part of the
esbuild bundle:

| File | Whose | What it does |
| --- | --- | --- |
| `evaluatePane.js` | Jasper's, unchanged | the Evaluate tab's keys (Shift+Enter, the Ctrl+K D/E/I chord) and its expression history |
| `millerColumns.js` | Jasper's, unchanged | the column strip: drilling to the right, closing one column, focus and the panel title, widths |
| `inspectorView.js` | GemDB's | everything drawn inside a column: tabs, tables, paging, the Class and Evaluate tabs, the context menu, Back and Forward |

The first two are copied byte for byte from Jasper's `client/src/webview/` (Jasper `main` at
e29ad036, 2026-10-19), with their tests (`src/__tests__/millerColumns.test.ts`,
`evaluatePane.test.ts`), which differ only in the path they load the file from, a
`/// <reference lib="dom" />` line, and GemDB's Prettier formatting. To take a Jasper fix, copy the
file again and run those tests. Prettier already accepts the two scripts as they are. They are linted with browser globals
(`eslint.config.mjs`). Their comments mention Jasper's two inspectors and its debugger; those are
Jasper's, left as they are so the copies stay exact.

`inspectorView.js` began as Jasper's `basicInspectorView.js`, and keeps its shape: one module, a
`populate` per column, the host message names (`addRoot`, `addChild`, `replaceColumn`, `tabData`,
`evalResult`, `setSlotResult`), and the jsdom tests beside it (`src/__tests__/inspectorView.test.ts`).
What changed is what a Python object is:

- **Tabs follow the Variables view's kinds**, not Smalltalk's formats: `obj` and `ivars` get
  **Attributes**, `seq` and `coll` **Items**, `dict` **Entries** (`childrenOf` in
  `pauseVariables.ts`). Every object gets **Repr**, **Class** and **Evaluate**. Jasper's Bytes tab
  is not here.
- **Rows are the Variables view's rows** (`childrenQuery`), so an attribute reads the same in
  both: the type badge, the grouping into special, class, function and module variables, the
  two-second budget on a slow `__repr__`. A group is a heading that opens in place, since a group
  is not an object to open a column on.
- **Paging is a page at a time, with a jump**, not Jasper's Load more / Load all. That was tried
  in the Persisted Objects tree and dropped: reaching item 9,000 meant loading or scrolling past
  everything before it. Here ‹ › step a page, and the Go to box takes a position (`-1` from the
  end, `[42]`) or a dict key, found by `keyPositionQuery`, the same lookup as Persisted Objects'
  Go to Item….
- **A column's label is a Python expression**: a child is labelled from its parent's
  (`p.tags['origin']`, `getattr(p, "odd name")`), and **Copy as Expression** copies it. The
  label is only as good as the root's: a Persisted Objects entry starts at `gemdb.root["key"]`,
  a Variables row at the row's name.
- **Class**, in place of Jasper's Meta: the methods and other names each class in the MRO
  defines, nearest class first and each class's dunders last, the MRO, and the docstring. A
  method's source opens in place: Python's for a Python function, and Grail's Smalltalk for a
  built-in one such as `dict.get` (see "Measured").
- **Browse Class** is gone: there is no class browser to land in.

## How the panel holds its objects

The inspector plan left this open: by key path under `gemdb.root`, by OOP held in an export set,
or in a registry of the Inspector's own. It is the last one. `openQuery` copies the object from
the registry it was found in (the pause's `GemDbPauseRefs`, or Persisted Objects'
`GemDbPersistedRefs`) into `GemDbInspectorRefs`, in the same session, and every row the panel
lists is registered there too, so a dive needs no second lookup. Being registered keeps the
object alive, so an uncommitted object stays readable after the pause it was found at resumes,
and between cells. The registry is dropped when the last panel on its session closes.

The other two lost for these reasons:

- **Key paths** reach only what is under `gemdb.root`, and an Inspector opened at a pause is
  mostly on objects that are not.
- **An export set** would mean `GciTsSaveObjs` calls from TypeScript, and nothing in GemDB holds
  an OOP across calls yet (`src/gci/` is vendored, and its export-set helpers are unused). It
  would also need its own release on close, which a registry gets with one `removeKey:`.

Every header carries the object's OOP and whether it is committed, so a committed object could be
re-found from any session by its OOP (`pathToQuery` does this for Persisted Objects). Nothing does
that yet; see "Not done".

## Which session reads it

A column reads in the session its object lives in (`ReadIn`, from `savedObjects.ts`):

- **A Variables row**: the paused notebook's or file run's session, through the pause while it is
  paused (`inNotebook` → `Pause.query`) and directly once it is idle.
- **A committed Persisted Objects entry**: the extension's own session (`extensionQuery`).
- **An addition not committed yet**: its notebook's session.

While that session runs a cell, a read fails as busy, and the column says to refresh once it
finishes (↻ re-reads the column's object, staying on its tab). Reads carry the two-second budget a
Variables read does; an Evaluate line has none, as a Debug Console line has none.

## Edits, and the automation line

**Edit Value…** runs `setVariableQuery` against the Inspector's registry: the typed text is a
Python expression, stored by `setattr` or by assignment, as **Set Value** stores it. Like Set
Value, it changes the object in its session's transaction, and the next commit writes it. It is
the user's own edit, so it sits where Set Value sits on the automation line
(`automation-boundary.md`).

↺ puts back what the row held **before its first edit**: the row's own handle, which the listing
registered, is kept, and `setVariableQuery` with `valueHandle` writes that object back rather than
evaluating anything. So a revert restores the very object, not one that prints the same.

An object read in the **extension's session** (a committed entry opened from Persisted Objects)
is **read-only**: a change there would be in a transaction nobody commits, and the next abort
would drop it silently. Open it from a notebook (as `gemdb.root[...]` in a cell, then Inspect at a
pause) to change it.

## Evaluate

`inspectorEvaluateQuery` runs the text with `self` bound to the column's object, in a scope that
is a **copy** of the notebook's globals plus `gemdb`, so `Point(1, 2)` works and `y = 5` does not
reach the notebook. `self` is bound under Grail's spelling of it (`NameAst doitScopeNameFor:`), as
`consoleQuery` binds it. It answers in `consoleQuery`'s format, so `parseConsoleReply` reads it and
an error reads as the Debug Console's Jupyter-style traceback, with `Inspector` naming the typed
input (`placeFrame`). Display shows the result's whole repr, Execute only what was printed, and
Inspect opens the result in a new column.

## Measured (2026-10-19, engine 4.0.0.a5, Grail a78e8c0)

- **A notebook class's `__module__` is `builtins`**, where CPython says `__main__`, so its repr is
  `<Point object at 0x…>` and the Class tab's Module reads `builtins`. Grail's to fix;
  `src/__integration__/inspector.test.ts` holds it as an expected failure.
- **`inspect` is too slow to use for source**: importing it took 4.6 s the first time in a
  session, past the two-second budget, so a method's source read was broken off ("a soft break
  was received"). It would not have helped anyway: `inspect.getsource` fails on a notebook's
  function (`OSError: could not get source code`), and a method Grail implements, such as
  `list.__add__`, has no `__code__` at all. Such a method is an UnboundMethod holding its
  Smalltalk class and its Python name, and Grail implements it in method environment 1 under
  that name, one method per arity (`dict.get` is `get:` and `get:_:` in KeyValueDictionary,
  `str.split` is `split`, `split:` and `split:_:`), each commented as a docstring would be; the
  Class tab shows those, said to be Smalltalk. For a Python function, `sourceQuery` answers only
  where the code is —
  `co_filename` (`<grail>` for a cell) and `co_firstlineno`, counted within the cell and pointing
  at the first decorator — or that it is built in, and the panel finds the lines itself
  (`sourceAt`): in a file on disk, or in the open notebook's cells, as the debugger places a
  frame. A cell edited since it ran shows only where the method was.

## Not done

- **A table view**: a page of similar objects as a table, a column per attribute, as Visual
  Studio's IEnumerable view shows them. Items and Entries are where it goes.
- **The path from `gemdb.root`** for a committed object, in its header, as Chrome's Retainers
  tree shows the one path to an object. A column's label is the path it was reached by, which is
  not the same thing.
- **Re-finding a committed object by OOP** once its session ends, so an Inspector on a committed
  object outlives its notebook.
- **Bytes**, for `bytes` and `bytearray`.
- **Inspect from the Debug Console** and from a notebook cell's output.

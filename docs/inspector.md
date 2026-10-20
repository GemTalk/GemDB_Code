# The Inspector

**Inspect**, on a Variables row, a Watch row or a Persisted Objects row, or `%inspect expr` in
the Debug Console, opens an object in an editor-tab webview: a strip of columns, one object each,
with tabs for what the object has. It is Jasper's basic Inspector brought over for Python. This
note says what was kept from Jasper, what changed and why, how the panel holds its objects, and
what was measured.

## What came from Jasper, and how it stays in step

Three scripts make the page, read from `resources/inspector/` at run time and injected as
`<script>` tags (`src/inspector.ts`), so they are plain browser JavaScript and not part of the
esbuild bundle. `scripts/check-vsix.sh` asserts the package carries them and the stylesheet.

| File               | Whose               | What it does                                                                                                            |
| ------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `evaluatePane.js`  | Jasper's, unchanged | the Evaluate tab's keys (Shift+Enter, the Ctrl+K (⌘K on a Mac) D/E/I chord) and its expression history                  |
| `millerColumns.js` | Jasper's, unchanged | the column strip: drilling to the right, closing one column, focus and the panel title, widths                          |
| `inspectorView.js` | GemDB's             | everything drawn inside a column: tabs, tables, paging, the Class and Evaluate tabs, the context menu, Back and Forward |

The first two are copied byte for byte from Jasper's `client/src/webview/` (Jasper `main` at
e29ad036, 2026-10-19), with their tests (`src/__tests__/millerColumns.test.ts`,
`evaluatePane.test.ts`), which differ only in the path they load the file from, a
`/// <reference lib="dom" />` line, and GemDB's Prettier formatting. To take a Jasper fix, copy the
file again and run those tests. Prettier already accepts the two scripts as they are. They are
linted with browser globals (`eslint.config.mjs`). Their comments mention Jasper's two inspectors
and its debugger; those are Jasper's, left as they are so the copies stay exact.

`inspector.css` began as the style block of Jasper's panel, with the rules for what this page
does not have (Bytes, Load more, sortable headers, setting links) taken out.

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
  is not an object to open a column on; it opens to up to 2,000 rows, and a last row says how
  many more there are. The Attributes tab lists up to 500 rows the same way.
- **Paging is a page at a time, with a jump**, not Jasper's Load more / Load all. That was tried
  in the Persisted Objects tree and dropped: reaching item 9,000 meant loading or scrolling past
  everything before it. Here the pager's ‹ › step a page (it shows only when there is more than
  one), and its Go to box takes a position (`-1` from the end, `[42]`) or a dict key, found by
  `keyPositionQuery`, the same lookup as Persisted Objects' Go to Item…; a number that is no key
  is taken as a position, and the page says so.
- **A column's label is a Python expression**: a child is labelled from its parent's
  (`p.tags['origin']`, `getattr(p, "odd name")`), and **Copy as Expression** copies it. A base
  that is not a plain path is put in parentheses (`(a or b).x`), a set's item reads
  `list(s)[0]`, since a set has no position to index, and a Grail runtime object's rows, which
  are Smalltalk instance variables, offer no Copy as Expression. The label is only as good as the
  root's: a Persisted Objects row starts at its path under `gemdb.root`
  (`gemdb.root["warehouse"].orders[3]`, `SavedObjectsProvider.expressionOf`); a Variables row at
  the row's name, since GemDB sends no `evaluateName` yet.
- **Class**, in place of Jasper's Meta: the methods and other names each class in the MRO
  defines, nearest class first and each class's dunders last, the MRO, `__bases__`, and the
  docstring. Classes are told apart by their position in the MRO, not by name, since
  `class Config(base.Config)` has two called Config. A member's source opens in place: Python's
  for a Python function or class, Grail's Smalltalk for a built-in such as `dict.get`, and the
  value itself for a class attribute (see "Measured").
- **Browse Class** is gone: there is no class browser to land in.
- **Every reply names the object it is for** (`handle`), and the page drops one for an object a
  column no longer shows, so a Repr asked for just before a dive cannot land under the next
  object. Back and Forward move the history cursor only once the step's object has been read.

## How the panel holds its objects

The inspector plan left this open: by key path under `gemdb.root`, by OOP held in an export set,
or in a registry of the Inspector's own. It is the last one, **one registry per panel**
(`GemDbInspectorRefs-` and a random part, `inspectorRegistry()`), in the session the object lives
in. When Inspect is chosen — before the page exists — `openQuery` copies the object from the
registry it was found in (the pause's `GemDbPauseRefs`, or Persisted Objects'
`GemDbPersistedRefs`) into the panel's, since those two are refilled at every stop and every
re-read; every row the panel lists is registered there too, so a dive needs no second lookup.
Being registered keeps the object alive, so an uncommitted object stays readable after the pause
it was found at resumes, and between cells, until the panel closes or its session ends. A
reloaded page opens its root again from the panel's own registry.

Per panel, not per session: a panel left open after its notebook's session was replaced (the
notebook closed and opened again) must find nothing at its positions, not another panel's objects
in the new session's registry. Each panel drops its own registry when it closes. The registry
grows as the panel is used — every page and group read is registered — and is dropped whole with
the panel; that is the trade for not reading a row twice.

The other two lost for these reasons:

- **Key paths** reach only what is under `gemdb.root`, and an Inspector opened at a pause is
  mostly on objects that are not.
- **An export set** would mean `GciTsSaveObjs` calls from TypeScript, and nothing in GemDB holds
  an OOP across calls yet (`src/gci/` is vendored, and its export-set helpers are unused). It
  would also need its own release on close, which a registry gets with one `removeKey:`.

Every header carries the object's OOP and whether it is committed, so a committed object could be
re-found from any session by its OOP (`pathToQuery` does this for Persisted Objects). Nothing does
that yet; see "Not done".

Every number a page message carries is checked to be a whole number before it is written into
Smalltalk (`wellFormed`): the page is ours, and this keeps a script injected into it from
becoming Smalltalk.

## Where it opens from, and what the tab says

- **A Variables row** gives its handle in the pause's registry: its own reference when it opens,
  else the one its listing recorded (`Pause.handleFor`).
- **A Watch row** has neither when its value is a plain one (`first + 1`), so each watch's result
  handle is kept, by its expression as run (dedented, then trimmed), as it is evaluated at every
  stop (`Pause.watchHandle`).
- **`%inspect expr`** evaluates `expr` in the frame's console names, as any console line does, and
  opens its result. VS Code offers extensions no menu on Debug Console output, so it is a command
  beside `%persist` rather than a right-click.
- **Persisted Objects** rows, by the row's own handle, so an entry with nothing inside (a str,
  an int) inspects too, and a saved stack's: it is a dict under `gemdb.root` (`savedStacks.ts`),
  so the Inspector opens its `frames`, `globals` and `saved_at` like any dict.

The editor tab reads `Inspector: counter · function`: what the column was opened on, then its
type, so several Inspectors can be told apart by variable. A long expression keeps its last whole
steps (`…orders[11999].lines · list`), and a last step too long on its own keeps its start. Where
the object came from — the paused frame's file, `special_values.py`, with its function and line on
hover, or Persisted Objects — sits quietly in the column's header beside the OOP, in the same
small type, rather than in the title. A notebook renamed in the Explorer takes its open Inspectors
with it (`InspectorPanel.retarget`).

## Which session reads it, and how

A column reads in the session its object lives in (`ReadIn`, from `savedObjects.ts`):

- **A Variables or Watch row, or `%inspect`**: the paused notebook's or file run's session,
  through the pause while it is paused (`inNotebook` → `Pause.query`) and directly once it is
  idle. Direct reads on one notebook are chained, one at a time, as the extension session's are,
  since a session runs one call at a time.
- **A committed Persisted Objects entry**: the extension's own session (`extensionQuery`).
- **An addition not committed yet**: its notebook's session.

While that session runs a cell, a read fails as busy, and the column says to refresh once it
finishes (↻ re-reads the column's object, keeping its tab, page, Class sub-tab and open groups).

Reads carry the two-second budget a Variables read does. **The user's own code** — an Evaluate
line, an edit's expression — runs in a notebook's session as a Debug Console line does: no time
limit, and straight past a `breakpoint()` it reaches (`{ budget: false, passHalts: true }`, which
`inNotebook` hands to the pause, or to `executeAsync` between cells, so the debugger never opens
on the Inspector's own query). In the extension's session it keeps the budget, so a runaway
line cannot hold the session Persisted Objects reads with.

## Edits

**Edit Value…** sees what the Evaluate tab sees: the typed text runs as an Evaluate line does
(`self` is the column's object, the program's names are in scope), in parentheses, so a statement
fails as a SyntaxError rather than storing `None`, Set Value's own rule, while an expression whose
value is None stores None. The value it produces is then stored as **Set Value** stores one —
`setattr`, or assignment — by `setVariableQuery` with `valueHandle`. Like Set Value, it changes
the object in its session's transaction, and the next commit writes it. The editor starts with the
row's value as shown; Enter on it unchanged is no change, since that text is a repr (perhaps cut
short, perhaps `list with 150 items`), not Python that rebuilds the object.

↺ puts back what the row held **before its first edit**: the row's own handle, which the listing
registered, is kept, by the column object's OOP and the row's name — which a Refresh does not
change, where registry positions do — and `setVariableQuery` with `valueHandle` writes that object
back rather than evaluating anything. So a revert restores the very object, not one that prints
the same.

**Add to Persisted Objects…**, on a row's menu or the button at the end of a column's tab row, is
the Variables row's command: both go through `addToPersistedObjects` (`savedObjects.ts`), so the
key suggested, the warning on a key already taken, the toast and the reveal in Persisted Objects
are the same. The Inspector reaches it through the internal command
`gemdb.savedObjects.addFromInspector`, handing it the panel's registry, so `saveSuggestionQuery`
and `saveToRootQuery` read the object there.

An object read in the **extension's session** (a committed entry opened from Persisted Objects)
offers neither Edit Value… nor Add to Persisted Objects…: a change there would be in a transaction
nobody commits, and an unrelated commit in that session (removing a committed entry) would write
it. Evaluate still runs there, to read, and whatever its line changes is thrown away when it
finishes (`System abortTransaction`). Open the object from a notebook (as `gemdb.root[...]` in a
cell, then Inspect at a pause) to change it.

## Evaluate

`inspectorEvaluateQuery` runs the text with `self` bound to the column's object, in a scope that
is a **copy** of the program's globals — a notebook's, or a debugged file's `__main__` — plus
`gemdb`, so `Point(1, 2)` works and `y = 5` does not reach the program. Text pasted with
indentation every line shares runs without it, as in the Debug Console. `self` is bound under
Grail's spelling of it (`NameAst doitScopeNameFor:`), as `consoleQuery` binds it. It answers in
`consoleQuery`'s format, so `parseConsoleReply` reads it and an error reads as the Debug Console's
Jupyter-style traceback, with `Inspector` naming the typed input (`placeFrame`). Display shows the
result's whole repr, Execute only what was printed, and Inspect opens the result in a new column,
labelled with the expression (or `(evaluated)` for several lines).

## Measured (2026-10-19 and 20, engine 4.0.0.a5, Grail a78e8c0)

- **A notebook class's `__module__` is `builtins`**, where CPython says `__main__`, so its repr is
  `<Point object at 0x…>` and the Class tab's Module reads `builtins`.
  `src/__integration__/inspector.test.ts` holds it as an expected failure, beside a plain test of
  what Grail says today.
- **`inspect` is too slow to use for source**: importing it took 4.6 s the first time in a
  session, past the two-second budget, so a method's source read was broken off ("a soft break
  was received"). It would not have helped anyway: `inspect.getsource` fails on a notebook's
  function (`OSError: could not get source code`), and a method Grail implements, such as
  `list.__add__`, has no `__code__` at all. Such a method is an UnboundMethod holding its
  Smalltalk class and its Python name, and Grail implements it in method environment 1 under
  that name, one method per arity (`dict.get` is `get:` and `get:_:` in KeyValueDictionary,
  `str.split` is `split`, `split:` and `split:_:`), each commented as a docstring would be; the
  Class tab shows those, said to be Smalltalk. For a Python function, `sourceQuery` answers only
  where the code is — `co_filename` (`<grail>` for a cell) and `co_firstlineno`, counted within
  the cell and pointing at the first decorator — and for a class, where its body begins
  (`__firstlineno__`). The panel finds the lines itself (`sourceAt`): in a file on disk, or in the
  open notebook's cells, the latest cell first, and only a `def` inside the class it belongs to,
  so one class's `__init__` is not shown as another's. A cell edited since it ran shows only
  where the member was.
- **`function` reports Smalltalk to Python**: its `__bases__` is `(BlockClosure,)`, its type's
  docstring is `object`'s, and an AttributeError on one names `ExecBlock`. Filed as
  GemTalk/Grail#1724; the Class tab shows what Grail answers.

## Not done

- **A table view**: a page of similar objects as a table, a column per attribute, as Visual
  Studio's IEnumerable view shows them. Items and Entries are where it goes.
- **The path from `gemdb.root`** for a committed object, in its header, as Chrome's Retainers
  tree shows the one path to an object. A column's label is the path it was reached by, which is
  not the same thing.
- **Re-finding a committed object by OOP** once its session ends, so an Inspector on a committed
  object outlives its notebook.
- **Bytes**, for `bytes` and `bytearray`.
- **Inspect from a notebook cell's output.**
- **Keyboard access to the tabs and group headings**, which, as in Jasper, are mouse-only.

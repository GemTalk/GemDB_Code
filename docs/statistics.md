# GemDB Stats

GemDB Code shows [GemDB Stats](https://github.com/GemTalk/GemDB_Stats),
GemTalk's statmon viewer, in an editor tab. A Flutter web build of it ships in
the `.vsix` as `stats/`. `src/statistics.ts` hosts it, and
`scripts/bundle-stats.mjs` prepares it. GemDB Stats' side of the arrangement is
its `docs/embedding.md`.

## Why a webview

The editor is not always on the machine that holds the statmon files. Under
code-server the only screen is a browser tab, so a desktop app cannot appear
there. A webview is an iframe in that tab whose files the remote machine
serves, so one build works in desktop VS Code and in hosted VS Code. It needs
no port, no server process and no login of its own.

Viewing statistics needs no database. The commands are registered before the
platform gate, so they work on machines that cannot host a database.

## Opening a file

GemDB Stats is a read-only custom editor, `gemdb.statistics`, and the default
editor for `*.out.gz` and `statmon*.out`, so a click on either opens it. A
`.out.gz` is unreadable in the text editor anyway, and statmon names its files
`statmon<pid>.out` or `statmonitor_<stone>_<date>.out`. Any other `.out` (such
as `a.out`, a compiled program) still opens as text. It was `option` for every
`.out` at first, and a click on a `.out.gz` then showed the text editor's
"binary or unsupported encoding" page.

- **GemDB: Open Statistics File…** shows VS Code's open dialog, then opens a
  tab on the file.
- **Open in GemDB Stats** opens a `.out` or `.out.gz` from the explorer's
  right-click menu: every selected file, or, run without one (from a
  keybinding), a file picked in the dialog.
- **Open With… → GemDB Stats** is offered for the same files.
- Each file gets one tab (`supportsMultipleEditorsPerDocument: false`), so a
  file already open is brought forward, not parsed a second time. Tabs open
  out of preview mode, or opening several from the explorer would leave only
  the last.
- `retainContextWhenHidden` keeps a hidden tab's page alive. Bringing a
  discarded one back would mean starting Flutter and parsing the file again.
- VS Code brings the tabs back after a window reload by resolving the editor
  again: the page is rebuilt, says `ready`, and is sent its file.

## The protocol

Three messages, as GemDB Stats' `docs/embedding.md` specifies:

| Message | Direction | GemDB Code's part |
| --- | --- | --- |
| `{type: 'ready'}` | app → GemDB Code | Answer with `open` for the tab's file, every time: a reloaded page says `ready` again. |
| `{type: 'open', url, name}` | GemDB Code → app | `url` is `asWebviewUri(file)`. Sent only in answer to `ready`. |
| `{type: 'pickFile'}` | app → GemDB Code | The user clicked the file name. Show VS Code's open dialog, then show the picked file in a new tab in the same place, and close this one. |

`pickFile` uses VS Code's dialog rather than the browser's because under
code-server the browser's dialog browses the user's own machine, not the
server where the statmon files are.

Each tab shows one file for as long as it is open, and its page can fetch
only under the panel's `localResourceRoots`: the build and that file's
folder. The folder is as narrow as it can be: VS Code refuses a request for a
resource that is itself a root (read in VS Code 1.140's loader). A picked file
gets a new tab rather than widening this one's roots, because widening them
reloads the page, leaves it able to read every folder it was ever shown, and
an `open` posted across the reload could make the app parse a large file
twice. A picked file already open in another tab brings that tab forward.

## The build

A GemDB Stats release publishes `GemDB-Stats-<version>-web.tar.gz` beside its
desktop builds, from v1.1.0 on. `vendor-pins.sh` pins its URL and SHA-256, and
`npm run bundle:stats` downloads it, checks it and assembles `stats/`. GemDB
Code's CI does not carry the Flutter SDK, which is why it uses a release asset
rather than building a pinned commit, as Grail and the MCP server do. For a
local build, set `STATS_WEB` to `GemDB_Stats/app/build/web`.

`bundle-stats.mjs` refuses a build a webview cannot run:

- one that loads CanvasKit from Google's CDN, which the CSP refuses: build with
  `--no-web-resources-cdn`;
- one that offers a Wasm build, whose renderers the payload leaves out: build
  without `--wasm`;
- one whose bootstrap registers a service worker, which a webview cannot host.
  GemDB Stats' own bootstrap template registers none, from PR #10 on.

Its changes to the page are few: a CSP first in `<head>`, `<base href>`
pointing at the webview, and a nonce on every script. They are made at bundle
time, into a `host.html` template, so a page GemDB Code cannot host fails in
front of whoever is packaging it. `fillHostPage` in `statistics.ts` fills the
three `{{GEMDB_*}}` placeholders for each panel.

It also leaves out what a webview never loads: the Wasm renderers, debug
symbols, the service worker, and the PWA manifest and icons. That cuts the
47 MB build to about 23 MB. `check-vsix.sh` asserts the payload is present and
those files are not.

## Recording statistics

The database GemDB runs records its own statistics, so there is a file to
open when something was slow (`src/statmonitor.ts`). The stone starts a
statmonitor of its own for each string in `STN_STATMONITOR_ARGS`. That setting
is documented in the engine's `bin/gemstone_data.conf`, not in the
`data/system.conf` GemDB copies to `conf/default.conf`. That file only has
`GEM_STATMONITOR_ARGS`, which is for remote page caches.

Before every start, `ensureStatmonitor` writes a block of GemDB's own into
`conf/system.conf`, between `# BEGIN GemDB statistics` and
`# END GemDB statistics`, from the `gemdb.statistics.*` settings:

```
STN_STATMONITOR_ARGS = "-i20 -u0 -z -R -k '00:00' -F'<root>/db/stat/statmonitor_%%S_%Y-%m-%d_%H%M%S.out'";
```

- **The block is rewritten on every start, unlike the space limits, which
  are added once.** Turning recording off has to take it out again.
- **A value the developer sets wins.** If `STN_STATMONITOR_ARGS` appears in
  `gemdb.conf`, `gem.conf` or elsewhere in `system.conf`, the block is removed
  rather than left beside it. The stone would otherwise start both.
- **`-u0` writes each sample as it is taken**, so today's file is at most one
  sample behind for GemDB Stats.
- **`-z` makes the name end `.out.gz`**, which opens in GemDB Stats on a
  click.
- **`-R -k '00:00'` starts a new file at midnight.** The time of day in the
  name keeps a restart on the same day out of the earlier file.

The settings reach the stone only when it starts. So the panel's Statistics
row judges "recording" from the newest file, counted as current if it was
written within the last three samples, and not from the setting.

**Pruning is GemDB's.** statmonitor's `-K` deletes only the files of the
process that wrote them, and every stone start is a new process. So
`startPruningStatistics` deletes `statmonitor_*.out(.gz)` files not written
for `gemdb.statistics.keepDays` (14). It runs at activation and every six
hours, whether or not the database is running. It always keeps the newest
file, and never touches a file of any other name.

**GemDB: Open Today's Statistics** opens the newest file, which is the one
being written while the database runs. GemDB Stats reads a file that is still
being written, whose gzip stream has no end yet. It is meant to follow such a
file live eventually.

None of this applies to an external database, whose stone belongs to its
administrator.

## Measured

- **2026-10-04, headless Chrome 154.** The generated page, with the full CSP.
  Flutter drew its first frame, there were no CSP violations and no service
  worker, and the page could fetch a statmon file.
- **2026-10-06, statmonitor on 4.0.0.a4.** These were run on a throwaway
  stone with its own lock folder:
  - The stone starts one statmonitor per `STN_STATMONITOR_ARGS` string and
    passes it the stone's name. The statmonitor exits when the stone stops,
    and leaves its file a complete gzip.
  - It is in neither `System currentSessions` nor the cache's slots, so it
    costs none of the ten sessions.
  - On an idle database a sample is about 3.6 KB uncompressed or 300 B with
    `-z`. At 20 s that is about 1.3 MB a day, more with active sessions.
  - `-k` set a minute ahead started a new file in the same process, and closed
    the old one complete.
  - A folder with a space in it worked inside `-F'…'`.
  - `gzip -t` refuses the file still being written ("unexpected end of
    file"), but a streaming decoder recovers every sample flushed so far.
- **2026-10-05, VS Code.** The app showed its loading screen, then grey.
  Chrome reproduced it once the page and the build were on different origins,
  as they are in a webview: Flutter's first `history.replaceState` resolved its
  URL against `<base href>` and threw a SecurityError. The first test used one
  origin and could not see it. GemDB Stats fixed it at the source in PR #10:
  the app sets no URL strategy, so Flutter never touches the history.

## Open

- **Not yet seen in code-server.**
- **Progress on a large file in VS Code.** A 258 MB `.out.gz` showed progress
  and loaded in under 40 s in Chrome. VS Code 1.140's webview resource loader
  streams files in chunks rather than reading them whole first (read in its
  source, 2026-10-06), so the progress bar should move there too. Not yet
  watched in VS Code.

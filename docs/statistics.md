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

- **GemDB: Open Statistics File…** shows VS Code's open dialog, then opens a
  tab on the file.
- **Open in GemDB Stats** opens a `.out` or `.out.gz` from the explorer's
  right-click menu.
- A file already open in a tab is brought forward, not parsed a second time.
- Each tab is a `WebviewPanel` with `retainContextWhenHidden`. Bringing a
  discarded tab back would mean starting Flutter and parsing the file again.

## The protocol

Three messages, as GemDB Stats' `docs/embedding.md` specifies:

| Message | Direction | GemDB Code's part |
| --- | --- | --- |
| `{type: 'ready'}` | app → GemDB Code | Answer with `open` for the tab's file, every time: a reloaded page says `ready` again. |
| `{type: 'open', url, name}` | GemDB Code → app | `url` is `asWebviewUri(file)`. A later `open` replaces the file. |
| `{type: 'pickFile'}` | app → GemDB Code | The user clicked the file name. Show VS Code's open dialog, then `open` the file in the same tab. |

`pickFile` uses VS Code's dialog rather than the browser's because under
code-server the browser's dialog browses the user's own machine, not the
server where the statmon files are.

The page can fetch only under the panel's `localResourceRoots`: the build and
the folder of every file opened in that tab. A picked file in a new folder
adds its folder, and changing the roots reloads the page. The reloaded page
says `ready` and gets its file then, so the extension does not depend on
whether the reload happens.

## The build

A GemDB Stats release publishes `GemDB-Stats-<version>-web.tar.gz` beside its
desktop builds. `vendor-pins.sh` pins its URL and SHA-256, and
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

## Measured

- **2026-10-04, headless Chrome 154.** The generated page, with the full CSP.
  Flutter drew its first frame, there were no CSP violations and no service
  worker, and the page could fetch a statmon file.
- **2026-10-05, VS Code.** The app showed its loading screen, then grey.
  Chrome reproduced it once the page and the build were on different origins,
  as they are in a webview: Flutter's first `history.replaceState` resolved its
  URL against `<base href>` and threw a SecurityError. The first test used one
  origin and could not see it. GemDB Stats fixed it at the source in PR #10:
  the app sets no URL strategy, so Flutter never touches the history.

## Open

- **No GemDB Stats release has the web build yet.** Until one does, the pins in
  `vendor-pins.sh` are empty, `bundle:stats` needs `STATS_WEB`, and the CI
  integration legs fail at it.
- **Not yet seen in code-server.**
- **Large files through VS Code's resource loader.** A 216 MB `.out.gz` takes
  about 23 s to parse in Chrome. Whether the webview's resource loader streams
  it, and whether the app's progress shows, is unmeasured.
- **Reopening after a window reload.** A `WebviewPanel` does not come back
  after a reload without a `WebviewPanelSerializer`, and there is none yet.

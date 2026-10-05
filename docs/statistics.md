# GemDB Stats

GemDB Code shows GemTalk's statmon viewer,
[GemDB Stats](https://github.com/GemTalk/GemDB_Stats), in an editor tab. A
Flutter web build of it ships in the `.vsix` as `stats/`. `src/statistics.ts`
hosts it, and `scripts/bundle-stats.mjs` prepares it.

## Why a webview

The editor is not always on the machine that holds the statmon files. Under
code-server the only screen is a browser tab, so a desktop app cannot appear
there. A webview is an iframe in that tab whose files the remote machine
serves, so one build works in desktop VS Code and in hosted VS Code. It needs
no port, no server process and no login of its own.

Viewing statistics needs no database. The editor is registered before the
platform gate, so it works on machines that cannot host a database.

## How a file reaches the page

- **Custom editor** `gemdb.statistics`, read-only, for `*.out` and `*.out.gz`.
  Its priority is `option`, so it appears under **Open With…** and never opens
  a `.out` file on a click. `.out` is too common an extension to take over.
- **GemDB: Open Statistics File…** picks a file and opens it in that editor.
- **The page's resource roots** are the build and the folder holding the file.
  The page fetches the file from the webview's resource origin, the same way
  it fetches its own code. Its CSP allows nothing else.
- **`retainContextWhenHidden`** keeps a hidden tab alive. Bringing a discarded
  one back means starting Flutter and parsing the file again.

## The contract with GemDB Stats

Before any of the page's own scripts run, the host sets:

```js
window.gemdbStatsHost = { file: { url: '<webview URL of the file>', name: 'statmon76637.out' } };
```

The app reads it at startup and fetches `file.url`. The response is the
file's bytes exactly as they are on disk, so a `.out.gz` arrives
gzip-compressed. Without `gemdbStatsHost`, for example on GitHub Pages, the app
shows its own file picker.

The build must be:

- dart2js with the CanvasKit renderer, which is `flutter build web` without
  `--wasm`;
- built with `--no-web-resources-cdn`, because the CSP refuses `gstatic.com`;
- an `index.html` with one `<base href>` and one `flutter_bootstrap.js`
  script tag.

`bundle-stats.mjs` refuses any build that is not all of these.

## What `bundle-stats.mjs` changes

`bundle-stats.mjs` turns `index.html` into `host.html`, a template:

- It adds a CSP, first in `<head>`.
- It points `<base href>` at the webview.
- It puts a nonce on every script.
- It replaces `flutter_bootstrap.js` with a direct call to Flutter's loader.
  The stock bootstrap registers a service worker, which a webview cannot host.
- It keeps Flutter's `history.pushState` and `replaceState` calls on the
  page's own URL. Flutter resolves the URL against `<base href>`, which in a
  webview is another origin, so the browser refuses the call and Flutter stops
  before drawing. A webview has no address bar, so dropping the URL costs
  nothing.

The page keeps everything else, including its loading screen, which belongs to
GemDB Stats. `fillHostPage` in `statistics.ts` fills the four `{{GEMDB_*}}`
placeholders for each panel.

These changes happen at bundle time, not when the panel opens, so a build
GemDB Code cannot host fails in front of whoever is packaging it.

`bundle-stats.mjs` also leaves out files that are never loaded:

- the Wasm renderers;
- debug symbols;
- the service worker;
- the PWA manifest and icons.

That cuts the 47 MB build to a 22.7 MB payload.

## Measured

On 2026-10-04, in headless Chrome 154: the generated page, served the way a
webview serves it, with the full CSP. Flutter drew its first frame, there were
no CSP violations, no service worker was registered, and a fetch of a statmon
file from the page succeeded.

That first test served the page and the build from one origin, which a
webview does not. In VS Code on 2026-10-05 the app showed its loading screen,
then grey. Chrome reproduced it with the page and the build on different
origins: a SecurityError from Flutter's first `replaceState`. With the history
calls kept on the page's own URL, Chrome draws the app in that same setup.

## Open

- **Not yet seen in VS Code or code-server.** The Chrome measurement covers the
  CSP, `<base href>` and the loader. A real webview adds its own resource
  origin and service worker.
- **Large files through VS Code's resource loader.** A 216 MB `.out.gz` takes
  23 s to parse in Chrome when GemDB Stats loads it from its own picker.
  Whether the webview resource loader streams a file that size has not been
  measured.
- **Where CI gets the build.** `bundle:stats` takes a local build
  (`STATS_WEB`). There is no pinned source yet, so `check-vsix.sh` does not
  require `stats/` and CI does not run `bundle:stats`.
- **Loading the file from `gemdbStatsHost`** is GemDB Stats' half of the
  contract, and is not built yet. Until it is, the panel shows the app with its
  own picker.

# The MCP server

GemDB bundles [GemTalk's native GemStone MCP server](https://github.com/GemTalk/mcp_server)
so that an AI agent can reach the database GemDB installed, and so that it can
do so without the user configuring anything.

This note is the reasoning and the measurements. The user-facing shape is in
the README; the invariants that must not be broken are in CLAUDE.md, except the
MCP-specific ones, which are here.

## What the payload is

Thirty-eight Smalltalk class file-outs (`.gs`) plus the loaders that `input`
them. That single fact settles most of the design, and it is worth stating
plainly because the obvious analogue — Grail — is the opposite in every
respect:

|                        | Grail                              | MCP server                        |
| ---------------------- | ---------------------------------- | --------------------------------- |
| What ships             | Python sources + a compiled shim   | Smalltalk file-outs               |
| Platform-specific      | yes — one shim per target          | no — identical on all three       |
| Tied to an engine      | yes — links `gciualib.o`           | no                                |
| Size                   | ~25 MB                             | ~480 KB                           |
| Install time           | minutes                            | seconds                           |
| GemDB's own installer  | yes (`resources/install-grail.sh`) | no — the payload's own `install.sh`|

So `scripts/bundle-mcp.sh` takes no `GEMSTONE`, appears once per CI leg only
because each leg packages its own `.vsix`, and there is no
`resources/install-mcp.sh`: what justified a GemDB-specific installer for Grail
was skipping a C compile, and there is no compile here. GemDB runs
`install.sh --grail --no-auth`, which is what a developer would run by hand.

**The payload's entry points are a list; everything they source is derived.**
`ENTRYPOINTS` in `bundle-mcp.sh` names what something *outside* the payload
runs, and a closure copies whatever those scripts source. A script named only
in prose is copied by neither, which is why the build also scans every staged
script for `./*.sh` and fails on a name it cannot find — that is how
`setup-read-only-user.sh` arriving upstream stopped a build rather than
shipping a payload whose own error messages pointed at a file it did not
carry. When that scan fires, the fix is to widen `ENTRYPOINTS` or fix the
reference, never to add a name to an exclusion list.

The two flags are the only decisions:

- **`--grail`** files in the Python toolset. It is opt-in upstream because
  loading it is not inert — it joins the default tool surface — which for GemDB
  is exactly the point. A server that could browse Smalltalk classes but not
  run Python would be the wrong half of GemDB. `mcp.test.ts` asserts
  `eval_python` and `compile_python` are in `tools/list`, because a GemDB that
  forgot this flag would install cleanly and quietly hand an agent the wrong
  server.
- **`--no-auth`** leaves out the OAuth/OIDC front end. The pinned engine
  (a 4.0 alpha) *can* compile it, so this is a choice: `McpAuthRouter` exists for a
  port reachable from another host, which is Jasper's territory. Nothing in
  GemDB can start it, so shipping it would file code into every user's database
  that nothing can reach.

## The Python toolset takes two separate acts: file it in, then name it

`--grail` on the payload's `install.sh` is the first — without it the classes
are not in the image at all. It is **not** sufficient, and believing it was
cost a red CI run: mcp_server 0.8.0 removed
`McpServer class>>installedDefaultToolsetNames`, which used to add
`McpGrailToolset` to the surface whenever `src/grail` was loaded, so **no
toolset joins the default surface by being present any more**. A router that
names nothing gets `defaultToolsetNames` — the core seven — and an agent asking
for `eval_python` is told "Unknown tool". That is a server that browses
Smalltalk and cannot run Python, which is the wrong half of GemDB.

So `startMcpServer` names it: `r toolsetNames: (McpServer defaultToolsetNames
copyWith: 'McpGrailToolset')`. Asked of the image rather than spelled out,
because the core seven are upstream's to change and only the one name GemDB
chooses belongs here. Alongside it goes `toolsetOptions` carrying
`grailDirectory` — the toolset reads Grail's `.py` files from disk for
`get_python_source`, `run_python_tests` and Python tracebacks, and a worker gem
cannot work out where they are: its working directory is the stone's.

## Why it is a process, and not just an install

`McpRouter>>runOnPort:` is a blocking accept loop, and it has to be the main
activity of a dedicated gem: a `GsProcess` forked inside a GCI session only
runs while that session is executing Smalltalk, so a background fork in an idle
session would never answer a request. `forkOnPort:` therefore spawns a real gem
through `GsTsExternalSession` and detaches it.

Two consequences follow, and they are why the MCP server is started and stopped
alongside the stone and the NetLDI rather than merely installed:

- **It needs the NetLDI**, which is what forks those gems. `ensureRunning`
  starts the listener before it gets here, so this is satisfied by ordering
  rather than by a check.
- **It outlives the editor**, exactly as the stone does. That is the intended
  behaviour — an agent in another application should still reach the database —
  and it is why `deactivate` does not stop it.

## The session cost

This is the real price, and it is worth being blunt about it. The Community
Edition keyfile GemDB installs says `Stone Session limit: 10`.

Measured on 2026-09-07, on a database with Grail already filed in:

| Session | Holder                                  |
| ------- | --------------------------------------- |
| 2       | `SymbolGem` — the engine's own          |
| 3       | `GcReclaim` — the engine's own          |
| 4       | whatever opened the database (`GemDB Code`) |
| 5       | the MCP router                          |
| 6, 7    | one worker gem per connected client     |

So a router, two agents talking to it, three notebooks and a GemDB Shell is
eight of ten. The router's own reaper closes a client's worker after 30 minutes
idle (`sessionIdleTimeoutSeconds`), which bounds the damage from an abandoned
client but not from an active one.

Two places surface this rather than letting it be discovered at a
`SessionLimitError`: the **AI agent access** row in the status view says the
server holds one session and gives each client another, and the
`gemdb.mcp.enabled` setting says the same in its description.

## The session leak, found by running it (2026-09-07)

**A worker gem is not released when its client goes away.** Only three things
close one: the client sending `DELETE /mcp`, the router's idle reaper after 30
minutes, or the router itself ending. A client that simply stops talking —
crashed, killed, or a one-shot `curl` that never had a session to give back —
leaves its gem logged in for up to half an hour.

Measured on a real GemDB database while verifying this work: nine `initialize`
calls from separate `curl` invocations opened nine worker gems and **exhausted
the ten-session limit**, at which point the database refused every further
login with GemStone error 4039 — including plain `topaz`. The owner of the
machine could not get into their own database. Stopping the router fixed it
instantly (all nine gems went with it, as above), which is the one piece of
good news: the recovery path works and is one command.

Two things make this less alarming than it sounds, and one makes it worse:

- A well-behaved client calls `initialize` **once** and reuses the session id
  for the life of the connection. VS Code and Claude Code both do. So ordinary
  use costs one session per client, not one per request, and `curl` in a loop
  is the pathological case rather than the representative one.
- The reaper does eventually clear it, so this is a half-hour outage, not a
  permanent one, and it cannot corrupt anything.
- But **reconnecting counts as a new client**. Reloading the VS Code window,
  restarting an agent, or a client that crashes and retries each leaves a gem
  behind. Eight of those inside thirty minutes locks the user out of their own
  database, and nothing in that sequence looks reckless.

That last point is why this is a real defect and not a testing artifact.

**Decided 2026-09-07 (James): fix it upstream, and ship opt-in until that
lands.**

The upstream fix is the correct one because the router is the only component
that knows how many gems it has opened. Two changes, both small against code
that already keeps a sessions map and runs a reaper: **cap the concurrent
workers** and refuse an `initialize` beyond the cap, so a router can never
consume more of the stone than it was allotted; and make
**`sessionIdleTimeoutSeconds` configurable**, so a ten-session database can ask
for two minutes instead of thirty. Filed as
[mcp_server#2](https://github.com/GemTalk/mcp_server/issues/2).

In the meantime `gemdb.mcp.enabled` **defaults to `false`**. A user who asks
for agent access gets it; everyone else is left alone. The cost of the default
being wrong in this direction is a setting to flip, and in the other direction
it is losing access to your own data — so the asymmetry decides it. The default
comes back on when the cap exists, and
`src/__tests__/mcp.test.ts` pins the current value so that flip has to be
deliberate.

Two consequences of shipping it off, both handled:

- The status view shows the **AI agent access** row *even when the server is
  off*, which was the opposite call while the default was on. Then a "disabled"
  row was noise for someone who had turned it off deliberately; now off is
  where everyone starts, and a feature nobody can see is a feature nobody turns
  on.
- **GemDB: Connect an AI Agent to GemDB** offers to turn it on, stating what it
  costs, before it starts anything. Writing GemDB's own setting on an explicit
  request is not the line the other clients' config files are on — it is ours,
  it is visible in Settings, and stopping to say "change a setting first" would
  be a strange answer to someone who just asked to connect an agent. The
  consent comes *before* `ensureRunning`, so a decline never leaves a database
  started for nobody.

**Rejected for now: GemDB-side reaping.** A worker is identifiable by
`System descriptionOfSession:` slot 21 matching the router's pid (measured,
above), so GemDB could stop the idlest workers when sessions get tight. It
works today and needs no upstream change, which is exactly why it is tempting
— but it is GemDB policing another component's gems on a guess about which are
expendable, and it would paper over the missing cap rather than motivate it.
Worth revisiting if upstream does not land.

## State carries over between tool calls, as in a notebook

Measured 2026-10-02 on GemDB Code 1.5.4, and the opposite of what the bundled
server did on 2026-09-07: **within one MCP session, `eval_python` keeps both
Python names and an uncommitted transaction from one call to the next.** One
call ran `x = 41` and wrote `gemdb.root['d9probe'] = 1` without committing; the
next printed `42` for `x + 1`, found the key, and `needs_commit()` was still
true. The server says so after any call that leaves changes behind:

```
[session] You have uncommitted changes. No tool commits for you: call commit to
persist them or abort to discard them. They are lost when this session ends:
1 minute with no event stream open.
```

So an agent can build up state across calls the way a notebook does, and the
same rule applies: nothing is in the database until something commits, and
uncommitted work is lost with the session. The Brain Freeze tutorial's MCP step
depends on the first half -- one call imports and binds, the next asks the
question -- and passes on 1.5.4.

## Stopping it, and the thing that had to be measured

The router is a logged-in session, so leaving it up would make `stopstone`
refuse and put the "Stop Anyway" modal — the one meant for a notebook someone
forgot about — in front of every ordinary "Stop GemDB". So `runStop` stops it,
after `logout` and before the NetLDI.

The question that could not be answered by reading the code: **what happens to
the worker gems?** `McpRouter>>stop` only ends the accept loop, nothing closes
the workers, they are separate gems, and the idle reaper that would eventually
have collected them is a `GsProcess` inside the router — so it dies with it.
If the workers survived, every client that had ever connected would cost a
session until the stone was force-stopped.

**Measured 2026-09-07.** They do not survive. `System descriptionOfSession:`
slot 21 (the client's pid) of each worker is the router's own pid — slot 2 of
the router's session — so each worker is an RPC gem whose client process *is*
the router. Ending the router leaves them without a client and the engine
terminates them; sessions 5, 6 and 7 above were all gone within four seconds.
That is why `stopMcpServer` names one gem and no more, and
`mcp.test.ts` finds the router's gems by those two slots after a client has
connected and asserts every one of them is gone after the stop, so the day it
stops being true is the day a test goes red rather than the day a user cannot
stop their database.

The test names gems by **serial** (slot 9), not by counting sessions and not
by session id. It used to count, and that raced on CI's macOS runner on
2026-10-01: `stopMcpServer` returns once the port closes, the previous
router's gems exit a moment later, and a count taken in between was one too
high, so the test saw the count fall *below* its baseline. A session id is no
better, because the stone hands a freed id to the next login. A serial is
never reused. The test relies on two things the image's own comments say and
4.0.0.a4 does (measured 2026-10-01, the same run). `descriptionOfSession:`
answers an Array of zeros for a session that has gone, not an error, so slot
10 (the session id) is 0. And `descriptionOfSessionSerialNum:` answers the
same way for a serial that has logged out. It does not answer nil;
`GsSession sessionWithSerialNumber:` is the one that does. On that run slot
21 still named the router, too: the test found two gems with one client
connected and three with two.

The stop itself is `System stopSession:` from a *linked* topaz login — clean,
needs no NetLDI (already down by then in `runStop`'s ordering) and no `lsof`.
A signal to the recorded host pid is the fallback if the port is still open,
guarded by a `ps comm` check so a recycled pid belonging to something else is
left alone. GemDB records the pid, the session id and the session serial at
fork time in `<rootPath>/mcp-router.json`, which is *outside* `mcp/` because
staging replaces that directory wholesale and a running router must survive an
update.

The clean stop finds the router by **serial**, and stops it only if slot 2
still names the recorded pid. It used to send `System stopSession:` the
recorded id, which is right only while the router holds that id. Once the
router has gone some other way (a crash, a force-stopped stone, a kill from a
shell), the record outlives it, and the stone hands a freed id to the next
login. The next "Stop GemDB" would then have stopped that session, most likely
a notebook's. `forkOnPort:` reports the id and the pid but not the serial, so
the start script reads slot 9 for the id it reported, in the same topaz run,
while the child is certainly logged in.

Two cases have no serial, and both fall back to looking the session up by id
under the same pid check: a record written by a GemDB from before the serial
was kept (a running router outlives an extension update), and an account
without SessionAccess, for which `descriptionOfSession:` raises for any
session but its own (the pid is missing in that case too, and `listeningPid`
supplies it). The check stops nothing it cannot identify. Where it declines,
the signal does the stopping.

There is no public stop by serial. `System stopSession:` converts the id to a
serial with `GsSession serialOfSession:` at the moment of the call and hands
it to the private `_stopSession:kind:timeout:`. `GsSession
sessionWithSerialNumber:` and its `stop` are public, but they answer nil for a
session whose UserProfile slot is nil, which the comments say includes a
session "in login or processing". The router never stops processing, so
relying on them would mean measuring what that phrase covers first; this
route did not need it. The check reads the current id from the serial and
sends that to `stopSession:`, microseconds apart in one topaz `run`, which
leaves no realistic time for the id to change hands.

One caller skips the clean stop and goes straight to the signal:
`stopMcpServer({ bySession: false })`, when a `gemdb.externalDatabase.*`
setting that names a database changes. The record survives that change,
because the root path has not moved, but the session id in it belongs to the
previous database. `topazLogin()` now reaches the new one, where that id is
someone else's session or nobody's. The signal alone is enough. Measured
2026-10-01, `mcp.test.ts` again: after SIGTERM to a router with one client
connected, neither the router's serial nor its worker's was still logged in,
so the worker followed the router down here too.

## Registering it with clients

Two problems with two different answers, and the asymmetry is the automation
line from CLAUDE.md applied to a new case.

**VS Code is registered automatically**, through
`vscode.lm.registerMcpServerDefinitionProvider` (the API arrived in 1.101,
which is what `engines.vscode` already pins). This is the same call as
`putCliOnPath`: the editor owns the reversal. The definition exists only while
the extension is enabled, it is scoped to this editor, and disabling GemDB
takes it away — nothing is written to a file the user would have to find.

`resolveMcpServerDefinition` is the part that makes it feel like nothing: VS
Code calls it when it is about to start the server, so an agent's first tool
call brings the database up the same way a notebook's first cell does.

**Claude Code is connected on request, by its own CLI.** Picking Claude Code
from **GemDB: Connect an AI Agent to GemDB** runs `claude mcp add --transport
http --scope local gemdb <url>` in the first workspace folder. It then shows
what ran and the command that undoes it. All of this was measured against Claude Code 2.1.283:

- **Which `claude`.** The Claude Code VS Code extension's bundled CLI
  (`resources/native-binary/claude` in its install directory) comes first,
  then the PATH. The extension does not put its CLI on the PATH, which is why
  the command GemDB used to copy failed for most people who pasted it. The
  location inside the extension is not documented, so a layout change there
  falls through to the PATH, and then to the clipboard.
- **Local scope, in the first folder.** Local scope is keyed by the working
  directory, so the entry reaches Claude Code sessions in this project only.
  The first folder because the Claude Code panel uses `workspaceFolders[0]`
  (or the home directory in an empty window) wherever it needs a root, read
  from its 2.1.283 `extension.js`. In a multi-root window, any other folder
  would register GemDB where the panel never looks. Every Claude Code session
  connects to every server it is configured with, so user scope would make
  every Claude Code window in every project spend one of the database's ten
  sessions, and each restart would leave a worker behind (see "The session
  leak" above). Project scope would commit a `127.0.0.1` URL for teammates
  who may not run GemDB.
- **Add first; replace only when asked.** `add` fails, with exit 1 and
  "already exists in local config", when the name is taken, and there is no
  upsert. Only that answer leads to a remove, and only after the user agrees,
  because the entry may be one they wrote for something else. Replacing is
  how a changed port gets picked up. Any other failure removes nothing, so an
  add that fails can't cost a working entry. If the add fails *after* a
  remove, the message says the old entry is gone. `get` and `list` are not
  used to look first: both connect to the server to report its status, which
  costs a worker gem.
- **Claude Code does not read VS Code's MCP list.** The automatic registration
  above reaches VS Code's own chat, not the Claude Code panel. That bridge
  is an open request upstream
  ([claude-code#47344](https://github.com/anthropics/claude-code/issues/47344)).

With no folder open, an untrusted folder, or no `claude` to be found, GemDB
falls back to copying the command, and says why.

**Claude Desktop and Cursor are handed the details and never configured.**
Each is configured by a JSON file the user owns (`claude_desktop_config.json`,
`~/.cursor/mcp.json`), and neither has a CLI to do the edit. Editing those
files is the other side of the line: persistent, global, outside the root path,
not ours to undo. It is the same call the README makes about the shell
profile, which asks rather than does. So **GemDB: Connect an AI Agent to
GemDB** offers the exact snippet, puts it on the clipboard, and stops.

## Why the port is not 8000

The payload's `run-server.sh` defaults to 8000, which is right for a script a
developer runs deliberately and wrong for something GemDB starts on its own:
8000 is what Django, `python -m http.server` and half of every developer's side
projects bind, and the router refuses a port already served. GemDB defaults to
**50390**, just past the range the engine uses for its own listeners (the
conventional NetLDI port is 50377), so it reads as belonging to the database in
an `lsof` listing.

Fixed rather than auto-selected, deliberately: every client outside VS Code is
configured by writing a literal URL into a file, so a port that moved between
runs would silently break all of them.

## Is it safe to open a port on every developer's machine?

The two properties this rests on, both asserted in `mcp.test.ts`:

- The router binds **loopback only**, and `bindAddress` has no setter — a base
  `McpRouter` performs no authentication, so a reachable port would be an open
  door into the repository.
- Every request's `Origin` is validated against a loopback allowlist, so a page
  in the user's browser cannot reach it by DNS rebinding. A non-loopback
  `Origin` gets 403; an absent one (curl, an SDK client) is allowed.

What an agent may *do* is another matter, and it is a deliberate default rather
than an oversight: the tools run Python and Smalltalk in the database and
commit the result. That is the entire reason to point an agent at GemDB — a
server that can only read browses a database the user could already browse in a
notebook — so `gemdb.mcp.readOnly` is off by default and exists for whoever
wants the narrower promise.

**It is a GemStone user, and that changed under us.** Until mcp_server 0.9.0
the setting drove `McpRouter>>readOnly:`, which hid and refused the tools that
write. Upstream deleted that, and the reasoning is worth keeping: `execute_code`
evaluates arbitrary Smalltalk, a test body is arbitrary Smalltalk, and a tool
that compiles can be followed by one that runs — so the gate could only ever be
advisory, and its real danger was *looking* like an access-control boundary in
the one place that mattered. What replaced it is enforced where it can be, in
the stone: `workerUserId:` names the GemStone user every worker gem logs in as,
and `setup-read-only-user.sh` provisions `McpReadOnly`, a user whose
UserProfile disables commits — which covers gems it forks in turn — and which
cannot reach the host.

GemDB provisions that user the first time the setting is turned on, and only
then: re-running the script **drops and recreates** the user, which is
upstream's documented way to change its privilege set and precisely the wrong
thing to do to a router that is serving with it. If provisioning fails, the
server does not start. Forking a read-write router for a user who asked for
read-only would be a promise broken in the one direction they cannot check.

`ensureReadOnlyUser` probes for that user and provisions it only if
it is missing. On the database GemDB manages it does not run the script: the
script creates the user from the router's own account, and `gemdb` lacks the
privilege to create users, so `provisionReadOnlyUserForGemdb` runs the same
steps as DataCurator (see [`repository-space.md`](repository-space.md)). That probe reads topaz's **result line**,
not its output: topaz echoes a script before running it, so searching the whole
answer for a marker finds the probe's own source and both spellings with it —
which answered "present" whatever the image held, provisioned nothing, and left
every session open failing in the router with LookupError 2015.

Two honest limits, both upstream's words and worth repeating wherever this is
described to a user: it bounds what a session can **change**, not what it can
**read**, and not how much of the machine it can occupy. A read-only agent
still sees everything in the database and still spends one of the ten
sessions.

## Open, and worth doing

**The worker cap** — the reason the feature ships off. See the section above;
filed as [mcp_server#2](https://github.com/GemTalk/mcp_server/issues/2).

**The router and its workers have no names.** Measured 2026-09-07: they appear
in `System cacheStatisticsForAllSlots` as `GciTs` — the stock name for any gem
a `GsTsExternalSession` created — with nothing to distinguish the MCP router
from its workers, or either from an unrelated external session. GemDB names
every session it opens for exactly this reason (`cacheNameFor` in `session.ts`,
and the note in CLAUDE.md about why a committed registry was rejected), and
these are the only sessions in a GemDB database that arrive unnamed.

The fix belongs upstream: `McpRouter` sending `System cacheName: 'mcp router'`
as it starts its loop, and `McpSession` naming each worker as it prepares it.
Two lines, and they would let the status view attribute an MCP session the same
way it attributes a notebook's, and give the stop path a name to look for
instead of a recorded pid. Until then the pid bookkeeping in
`<rootPath>/mcp-router.json` stands in for it. Filed as
[mcp_server#1](https://github.com/GemTalk/mcp_server/issues/1) (James, before
this note existed) — the measurements are in a comment there.

**The payload is filed in on first `ensureRunning`, like Grail.** GemDB ships
no prepared extent — a user's database is theirs, and Grail and the MCP server
have to be installable into one that already holds data — so both file-ins
happen on the user's machine. The MCP one takes seconds against Grail's
minutes, so it was never the part worth pre-baking anyway.

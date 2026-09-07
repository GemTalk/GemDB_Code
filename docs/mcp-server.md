# The MCP server

GemDB bundles [GemTalk's native GemStone MCP server](https://github.com/GemTalk/mcp_server)
so that an AI agent can reach the database GemDB installed, and so that it can
do so without the user configuring anything.

This note is the reasoning and the measurements. The user-facing shape is in
the README; the invariants that must not be broken are in CLAUDE.md.

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

The two flags are the only decisions:

- **`--grail`** files in the Python toolset. It is opt-in upstream because
  loading it is not inert — it joins the default tool surface — which for GemDB
  is exactly the point. A server that could browse Smalltalk classes but not
  run Python would be the wrong half of GemDB. `mcp.test.ts` asserts
  `eval_python` and `compile_python` are in `tools/list`, because a GemDB that
  forgot this flag would install cleanly and quietly hand an agent the wrong
  server.
- **`--no-auth`** leaves out the OAuth/OIDC front end. The pinned engine
  (3.7.5) *can* compile it, so this is a choice: `McpAuthRouter` exists for a
  port reachable from another host, which is Jasper's territory. Nothing in
  GemDB can start it, so shipping it would file code into every user's database
  that nothing can reach.

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

Measured on 2026-09-07, on a database created from the shipped extent:

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

## Each tool call is a clean slate

Also measured 2026-09-07, and worth knowing before writing anything that
assumes otherwise: **`eval_python` neither keeps Python module scope nor
carries an uncommitted transaction between calls.** Within one call a write is
visible and `needs_commit()` is true; on the next call the variable is a
`NameError` and `needs_commit()` is false — the worker has aborted in between.

So an agent cannot build up state across calls the way a notebook does: to
persist anything it must `commit()` **in the same call** that writes. That was
verified end to end — a commit inside one call put a key in the database and
took `needs_commit()` back to false.

This is upstream behaviour, not GemDB's, and it is defensible: it means a tool
call cannot leave the session dirty for the next one, which is the failure that
`gemdb.transaction()`'s entry check exists to complain about. It is only a
problem if a user expects notebook semantics from an agent.

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
`mcp.test.ts` asserts the session count returns to its baseline after a client
has connected, so the day it stops being true is the day a test goes red rather
than the day a user cannot stop their database.

The stop itself is `System stopSession:` on the recorded session id from a
*linked* topaz login — clean, needs no NetLDI (already down by then in
`runStop`'s ordering) and no `lsof`. A signal to the recorded host pid is the
fallback if the port is still open, guarded by a `ps comm` check so a recycled
pid belonging to something else is left alone. GemDB records both the pid and
the session id at fork time in `<rootPath>/mcp-router.json`, which is *outside*
`mcp/` because staging replaces that directory wholesale and a running router
must survive an update.

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

**Every other client is handed the details and never configured.** Claude Code,
Claude Desktop and Cursor are each configured by a JSON file the user owns
(`~/.claude.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`), and
editing those is the other side of the line — persistent, global, outside the
root path, not ours to undo. It is the same call the README makes about the
shell profile, which asks rather than does. So **GemDB: Connect an AI Agent to
GemDB** offers the exact command or snippet, puts it on the clipboard, and
stops.

This is not timidity. A user who runs `claude mcp add` has chosen to add a
server to their agent; GemDB writing that file on their behalf, from an editor
they opened to write Python, is a different act with the same result and no
consent.

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

The tool surface itself is another matter, and it is a deliberate default
rather than an oversight: the tools run Python and Smalltalk in the database
and commit the result. That is the entire reason to point an agent at GemDB —
a read-only server can browse a database the user could already browse in a
notebook — so `gemdb.mcp.readOnly` is off by default and exists for whoever
wants the narrower surface.

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

**Nothing pre-files the payload into the shipped extent.** `bundle-extent.sh`
files Grail in because that saves minutes; the MCP file-in takes seconds, so it
happens on first `ensureRunning` instead. If that ever becomes the slow part of
a first run, the extent is where it belongs.

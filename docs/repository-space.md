# Repository space

How GemDB keeps the database inside the free license's 10 GB without reaching
the point where it can no longer collect its own garbage. The code is
`withSpaceLimits` / `ensureSpaceLimits` / `assertRoomForExtent` in
`database.ts`, `maintenance.ts`, `account.ts`, and `GciSession.peek` /
`abortIfClean` in `session.ts`. Everything below
was measured on 4.0.0.a4 on 2026-10-04, against scratch stones with small caps,
unless it says otherwise. The integration files `space.test.ts` and
`spaceFull.test.ts` repeat the parts that matter.

## The configuration

Three lines, added to `conf/system.conf` for a new database and before every
start for an existing one, unless a configuration file already sets them:

```
DBF_EXTENT_SIZES = 10240MB;
STN_FREE_SPACE_THRESHOLD = 500MB;
DBF_PRE_GROW = TRUE;
```

- **Without `DBF_EXTENT_SIZES`, the extent stops 2 GB short.** The stone's log
  says `STN_DBF_EXTENT_SIZES is unlimited, using REPOS MAX: 8192 Mbytes`,
  though the key says `Repository size limit: 10240 MB`. With the setting, the
  stone accepts exactly 10240 MB (pregrowing to it worked; 10256 MB started
  too, and was not explored further). The stone applies a new maximum to an
  existing extent at startup: "changing the maximum size from UNLIMITED MB to
  10240 MB" in its log, after an "In extent 0, maxSize is inconsistent" line
  that is the stone noticing, not a fault.
- **The threshold counts room the extent can still grow into.** The stone
  keeps at least the threshold free *by growing the extent ahead of demand*:
  with a 64 MB threshold the stock 48 MB extent was at 112 MB, with 79 MB free,
  before anything was written, and it grew in 16 MB steps as data arrived. With
  500 MB a new database's extent starts at about 560 MB. The threshold fired
  only once the extent reached its cap. So the threshold is accurate with or
  without pregrowing.
- **`DBF_PRE_GROW` reserves the cap on disk, because a full disk is otherwise
  a silent, smaller cap.** Measured on a 1 GB volume with a 2 GB cap:
  - *Without pregrow*, the stone logged "Repository grow failure, extent 0,
    failed with No space left on device" at about 999 MB, treated that as the
    cap, went below its threshold there, and left the disk 98% full for
    everything else; a session committing was suspended for over ten minutes.
  - *With pregrow*, the stone refused to start: "failed with No space left on
    device … Stone startup has failed", with the extent left at its original
    size. Nothing was damaged and the failure was at startup, where it can be
    explained.

  Pregrowing to 10240 MB took 3 seconds on an SSD and is a real 10 GB (`du`
  agrees; not sparse). GemDB checks for the room first, so the user gets
  numbers and a way out rather than the stone's log line: `assertRoomForSetup`
  before setup downloads anything (the cap plus the engine), and
  `assertRoomForExtent` before every start (what the extent still needs), and
  `startStone` explains a startup that failed with "No space left on device"
  anyway. With the extent pregrown, `SystemRepository freeSpace` alone is the
  room left, for every tool that reads it.
- **The test suite reserves 1 GB, not 10.** Each integration file makes a
  database, on runners GitHub documents at 14 GB of SSD. The fixture sets the
  cap in the stone's own configuration file, which overrides `system.conf`
  and which `ensureSpaceLimits` leaves alone (`limitTestDatabase` in
  `fixture.ts`). The 10240 MB figure is held to the engine's key instead, by
  `space.test.ts`. The test extent is built with no limits at all, or the
  cached artifact would be the size of its cap.
- The threshold's default is 0, which means 0.1% of the repository: 10 MB on a
  10 GB cap.

## What the stone does below the threshold

Its own list, from `system.conf`, with what each item means for GemDB:

1. Disposes of commit records more aggressively, and writes a checkpoint.
2. Logs "Repository freespace = 62 MB, has dropped below the config threshold
   … Stone is taking action to avoid shutdown", and logs again when it is back
   above.
3. **Refuses logins except DataCurator and SystemUser** — by account, not
   privilege: an account granted `GarbageCollection`, `SessionAccess` and
   `FileControl` was still refused. GemDB's sessions use the `gemdb` account,
   so a new notebook or Shell gets error 4002 (`REP_ERR_REPOS_FULL`, "The
   logical repository is full"), which `session.ts` turns into "the database
   is full, so it is not opening new sessions". Sessions already open carry
   on, and could still commit a small change. One that keeps writing is let
   through a commit at a time — free space flickers just above and below the
   threshold every ten to forty seconds — until the termination below ends it;
   it then sees error 4002 as "The Repository is full and can no longer be
   expanded", which `session.ts` reports as the database having stopped the
   session. Because of the flicker, GemDB counts the database as full from the
   crossing until free space is a quarter of the threshold above it
   (`isFull`), so it warns once rather than at every flicker.
4. **Sends error 2338 to every DataCurator session**, once per crossing — not
   to `gemdb` sessions, which got no notice at all (measured), so the warning
   is GemDB's to give (below). It
   arrives at the session's next request and *replaces* it. Measured through a
   notebook: the cell did not run (a variable it assigned was undefined
   afterwards), the session was fine, and the next cell ran normally. A
   second fill below the threshold raised no second 2338. `session.ts` turns
   the stone's wording into one that says the cell did not run and to run it
   again (`BELOW_THRESHOLD_MESSAGE`). GemDB's own queries ask again
   (`fetchAskingAgain`, `askingAgain` in `maintenance.ts`). That matters because
   a session that logs in below the threshold gets the notice on its first
   request.
5. After `STN_DISKFULL_TERMINATION_INTERVAL` (default 3 minutes), it begins
   **terminating sessions that hold the oldest commit record**. It spares
   DataCurator: an idle DataCurator session holding the oldest record 35
   commits behind survived over three minutes. It does not spare `gemdb`: "User
   gemdb with session 4 is being terminated because repository is full",
   measured at the three-minute mark. That is deliberate — the interval is left
   at its default, because losing a little uncommitted work beats a repository
   with no free pages, where nothing can be collected at all. It also ends the
   **symbol-creation gem**, again every minute or three. While that lasts, a
   session creating a new Symbol gets error 2249 ("Further commits have been
   disabled for this session because: 'symbolVm died during transaction'") or
   hangs — a DataCurator commit creating one hung for over ten minutes. GemDB's
   own recovery compiles no new Symbols.
6. **The reclaim gem stops**: "Suspending reclaims because repository
   freeSpace (30 MB) is below the freeSpaceThreshold (64 MB)", in its own log.
   A collection still finds the garbage (`markForCollection` reported it),
   and none of it is freed. **This is the deadlock** the whole design is about:
   the threshold is not a reserve that collection gets to use; crossing it
   switches collection off.

**An extent at its cap is not stuck there.** The trigger is free space, not
the extent's size. Growth room counts only while the extent can grow; at the
cap, what counts is free space inside it, and freeing that ends the condition
with the extent still at the cap. Measured with a 256 MB cap: filled to 21 MB
free, a non-DataCurator login was refused (4002). After the junk was deleted
and collected, the extent was still 256 MB but 191 MB of it was free, the
stone logged "Repository freespace 191 MB, is now above the freespace
threshold", and the same login worked. The stone re-checks on its own clock,
not at the moment free space changes, so a login a second after recovery can
still be refused; within five seconds it was not. What cannot be undone is a
repository with no free pages at all, which is what the threshold is there to
prevent.

The way back is to lower the threshold under what is free. Only SystemUser may
(`System configurationAt: #StnFreeSpaceThreshold put:`). Measured: lowered to
16 MB with 19 MB free, the reclaim gem resumed, and free space went 19 → 41 →
84 MB within ten seconds. `collectGarbage` does exactly this when it finds free
space below the threshold. It sets the threshold to half of what is free, as
SystemUser with the stock password (the same login `install-grail.sh`
makes), and puts back the value it read once reclaim settles. The change is
runtime-only, so a stone restart restores the configured value whatever
happens.

## The `gemdb` account

On a database GemDB manages, every notebook, Shell, Python run and MCP
worker logs in as `gemdb`, never DataCurator (`DB_USER` in `config.ts`), so the
threshold's protections apply to them. The account mirrors the one GemDB
Cloud's image creates: its own security policy, and only `CodeModification`
(to define classes) and `CreateOnetimePassword` (for the MCP server's gem).
DataCurator creates it before Python is installed into it (`account.ts`,
called from `ensureRunning`); measured, DataCurator can create the account,
its policy and both privileges, so SystemUser is not involved. Its password
is generated with the database, in `db/conf/gemdb.password`, mode 600 — not a
security boundary while the stock administrator passwords are in use, but out
of settings and out of the generated wrapper's source.

What `gemdb` may and may not do, measured:

| Operation | `gemdb` |
| --- | --- |
| `SystemRepository freeSpace`, `fileSize`, `stoneConfigurationAt:` | yes |
| Vote state, dead and possibly-dead counts | yes |
| Its own `descriptionOfSession:`; `cacheName:` | yes |
| Another session's `descriptionOfSession:` | no — `SessionAccess` |
| `markForCollection` | no — `GarbageCollection` |
| `startCheckpointSync`, `stopSession:` | no — `SystemControl` (which can also stop the stone) |
| Writing Globals | no (error 2116) |

So maintenance reads space and sweeps through the window's own `gemdb`
sessions, and logs in as DataCurator, on a session of its own, for the rest:
collecting garbage, listing and stopping sessions, provisioning the MCP
read-only user, describing the MCP router's gem. SystemUser is used for two
things only: Grail's shared base, once per extent, and lowering the threshold
during recovery. Grail's own `gemdb.admin.garbage_collect`, `gemdb.admin.backup`
and `gemdb.sessions.all()` need privileges `gemdb` lacks, and raise a
`SecurityError` from a notebook.

## Why idle sessions are aborted

GemDB's sessions run in `autoBegin`, the stone's default, since nothing sets a
transaction mode. So an idle session is always *inside* a transaction, and holds
the commit record its view was taken from.

- The stone's remedies for that apply only to sessions **outside** a
  transaction. `STN_SIGNAL_ABORT_CR_BACKLOG`, `STN_GEM_ABORT_TIMEOUT` and
  `STN_GEM_LOSTOT_TIMEOUT` all say so in `system.conf`, and none fired on an
  idle autoBegin session.
- `STN_GEM_TIMEOUT` would catch it, by killing any gem idle that long. That is
  the "kill anything idle" cron job customers write, and it would end
  notebooks and Shells along with their variables, so it is not set.
- Measured: after a mark, the vote stayed at `VOTING`, with the idle session
  the only one not voted, for as long as it sat there. One abort from it, and
  the vote finished and the dead objects were reclaimed.

`abortIfClean` aborts only when `System needsCommit` is false. That loses
nothing: a notebook's variables live in SessionTemps, which an abort leaves
alone (`space.test.ts` checks this), and `gemdb.abort()` is the same send. It
uses `peek`, so it never counts as use and a session left alone stays the
idlest. A dirty session is the user's to decide about. Maintenance asks its
owner to commit or abort, and only once it is at least 20 commits behind
(`STN_SIGNAL_ABORT_CR_BACKLOG`'s default). A dirty notebook that nothing else
is committing past holds nothing back, so it is left alone.

## What a collection has to do

`markForCollection` alone frees nothing visible. The chain, each link measured:

1. **Mark.** On 4.0 it *answers* a Warning carrying the report ("found 157318
   live objects, 8002 dead objects…"), rather than signalling it.
2. **Every session votes**, by committing or aborting. The collection aborts
   this window's clean sessions straight after the mark, and its own session on
   every poll.
3. **Reclaim**, then a **checkpoint**: freed pages are not counted as free until
   one. Measured: 69 MB free after reclaim, 144 MB after `startCheckpointSync`.
4. **Wait for the pages, not the counters.** Vote state, `possibleDeadSize`,
   `deadNotReclaimedCount` and `pagesNeedReclaimCount` all reach zero within a
   quarter of a second. The space follows anywhere from two seconds to a
   minute later, longest straight after a large commit while the shared cache
   is still writing it out (the reclaim gem logs "Suspending reclaims because
   cache numberOfFreeFrames … is below targetFreeFrameCount"). So the
   collection checkpoints and reads free space every five seconds until it has
   grown and then stopped growing for 30 seconds (90 when it lowered the
   threshold), or is back above the threshold it lowered. The quiet window
   counts from the first growth, not the first reading: on a macOS CI runner
   a collection straight after a 20-odd MB commit found the garbage, waited
   out 30 quiet seconds from its first reading, and reported nothing given
   back. Until free space
   grows it waits up to 90 seconds, read in KB so that one freed page counts.

Two hypotheses for the slow cases were tested and are **wrong**. Don't chase
them again:

- *A session that made the garbage keeps it alive while logged in.* A filler
  session that logged out before the mark gave space back just as slowly as
  one that stayed.
- *`GEM_TEMPOBJ_POMGEN_PRUNE_ON_VOTE`'s five-minute window.* Garbage six
  minutes old came back no faster, and `System _vmPrunePomGen` in the filler
  changed nothing.

## When GemDB collects

A tick every minute, in each window that holds a session — every fifteen
seconds once less than 2 GB is left or the threshold has been crossed. A window
that holds no session has nothing to sweep, and reading space would cost one.
A tick is one short query on a session that is already open.

**Telling the user.** The moment a tick sees free space under the threshold,
GemDB says the database is full and to commit now, and starts a collection
straight away, whatever the hour-long spacing. Two minutes in, it says so
again: the stone starts ending sessions at three. When free space is back
above the threshold, it says so. (`nextFullState` in `maintenance.ts`.)

- **Room short**: less than 2 GB left (`GC_HEADROOM_MB`, four times the
  threshold), at most once an hour. It runs whether or not someone is working,
  since a collection runs alongside other sessions.
- **Schedule**: every `gemdb.maintenance.garbageCollectionIntervalHours`
  (default 24; 0 turns the schedule off), once nothing in the window has run
  for five minutes.
- **Collect Garbage Now** runs one immediately.

The last collection is recorded in `<root>/db/maintenance.json`, so windows
agree on when it was. A collection runs in a session of its own and is logged
out afterwards. The stone serialises marks itself.

## Stopping a session

**Stop a Database Session…** lists the stone's sessions, with the ones holding
garbage back first. It shows each session's published name (`System
cacheName:`), the age of its view (`descriptionOfSession:` slot 5, in
`System timeGmt` seconds) and how many commits behind it is (slot 16). It
leaves out the stone's own gems (slot 17 is their kind, nil for an ordinary
session) and the window's own administrative sessions. It always asks first.
For this window's notebooks it logs the session out. Otherwise it sends
`System stopSession:` as DataCurator, which holds `SystemControl`, the
privilege that needs; listing needs `SessionAccess`. Measured:
the session left the stone's list within two seconds. Its owner's next request
raised "Your session has been forcibly terminated", which `isDeadSession`
already recognises, and the request after that logged in afresh.

## Not done, and why

- **Transaction logs.** `STN_TRAN_FULL_LOGGING = TRUE` keeps every log
  forever, outside the 10 GB, roughly a byte of log per byte committed, so
  the disk is likelier to fill than the repository. The setting is **sticky**:
  once a stone has started with it, the repository keeps it, and going back
  needs a backup restored into a fresh extent. So every existing database can
  only manage its logs by deleting old ones. After a checkpoint,
  `SystemRepository oldestLogFileIdForRecovery` names the oldest log crash
  recovery needs (measured: 7 of 7, with 1–6 deletable). Older logs matter
  only for rolling a backup forward. Deleting them is irreversible, so it is
  a decision for the user, not maintenance.
- **Epoch garbage collection** (`STN_EPOCH_GC_ENABLED`). The stone's own
  collector for short-lived garbage, which is most of what Python makes. Not
  measured here.

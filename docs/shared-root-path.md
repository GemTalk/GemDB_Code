# Several GemDB versions on one root path

VS Code on one GemDB release and Cursor on another, both pointed at `~/GemDB`,
used to replace each other's Grail and MCP server at every start: each saw a
payload that was not its own and filed its own in. Three rules stop that. The
mechanics live in `stamps.ts` and `paths.ts`, and their comments are the
reference for how it works. This note records why.

## Where the stamps live

The "filed in" stamps are `db/.gemdb-grail-installed` and
`db/.gemdb-mcp-installed`. They used to sit inside `grail/` and `mcp/`, which
every staging replaces wholesale, so any GemDB that restaged made every other
one forget what the database held. They describe the database, so they live
and die with it: `clearDatabaseDirWithoutExtent` discards them with an
extent-less `db/`.

Each staged payload also carries `.gemdb-staged-by`, written last. It describes
the files on disk, so it lives inside the payload and goes with it.

## How stamps order

Every stamp ends with `extension=<GemDB version>`. The payload's own lines are
`git describe` output, and those cannot be ordered. Each release pins one Grail
and one MCP server, so GemDB's version stands in for how new the payload is.

`compareStamps` answers `older`, `newer`, `same` or `sameVersionDifferent`:

- A missing record, a missing `extension=` line or an unparseable version is
  `older`, and so is a pre-release compared with its release.
- Nothing replaces, restages or reinstalls a payload that a newer GemDB filed
  in *or* staged.
- `sameVersionDifferent` is still replaced, as every difference was before
  versions were recorded.

## Legacy stamps

`grail/.gemdb-grail-stamp` and `mcp/.gemdb-mcp-stamp` are what releases up to
1.5.4 read and write. This GemDB reads them as a fallback and never writes
them.

When both locations exist, the more recent mtime wins. Only an older GemDB
writes the legacy file, so a newer legacy stamp means that GemDB filed its
payload in since. A legacy stamp has no version, so it reads as `older`, and
the newer GemDB upgrades again.

Anything that forgets a stamp (a file-in about to run, the `gemdb` account
being created) removes **both** locations (`removeGrailStamps`,
`removeMcpStamps`). Otherwise the legacy stamp would be read in its place.

## Adding a file under the root path

Any new file GemDB writes to the root path needs the same reasoning before it
ships:

- What does an older GemDB on the same root path do when it finds the new
  file?
- What does this GemDB do with the file the older one wrote?

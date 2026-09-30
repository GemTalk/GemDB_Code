# Using a database someone else runs

GemDB Code normally installs and runs its own database. On a hosted or shared
machine an administrator does that instead — installing the engine, running the
stone and NetLDI as services, and giving each developer an ordinary database
account — and GemDB Code only connects. Setting
`gemdb.externalDatabase.gemstone` switches it to that mode.

## What GemDB Code does and does not do

Against an external database, GemDB Code:

- **does** stage its bundled Grail under `gemdb.rootPath` and file it into the
  configured account, open sessions as that account, write the `gemdb` command,
  and run the MCP server if `gemdb.mcp.enabled` is on;
- **does not** download an engine, create a database, check or ask to raise
  shared memory, start or stop the stone or NetLDI, or remove anything. Start,
  Stop and Remove are hidden, and a database that is down is reported rather
  than started.

Refusing to start the stone is the point rather than a convenience. The
administrator's stone runs as its own operating-system account. A stone
started by GemDB on the same extent would run as the developer, and GemStone
allows passwordless logins — as any user, SystemUser included — to linked
sessions running as the stone's account.

## Settings

All `"scope": "machine"`, so a repository's `.vscode/settings.json` cannot set
them. In a remote window (code-server, SSH) they are read on the machine the
database is on.

| Setting                                  | Default                   |                                                    |
| ---------------------------------------- | ------------------------- | -------------------------------------------------- |
| `gemdb.externalDatabase.gemstone`        | _(empty: off)_            | The engine's product directory (`GEMSTONE`)        |
| `gemdb.externalDatabase.globalDirectory` | `/opt/gemstone`           | `GEMSTONE_GLOBAL_DIR`, which holds `locks/`        |
| `gemdb.externalDatabase.stone`           | `gs64stone`               | The stone's name                                   |
| `gemdb.externalDatabase.netldi`          | `gs64ldi`                 | The NetLDI's name                                  |
| `gemdb.externalDatabase.user`            | `DataCurator`             | The account GemDB Code logs in as                  |
| `gemdb.externalDatabase.passwordFile`    | _(empty: stock password)_ | A file whose first line is that account's password |

The password is read from a file on every login rather than stored in a
setting, so it never appears in `settings.json`, and a password changed on the
server is picked up without touching the editor. Make it readable by the
developer's account only (`chmod 600`).

The engine version is read from the product's `version.txt`, because it names
the GCI library GemDB Code loads.

## What the administrator provides

- **An engine GemDB Code can use**: Grail needs a 4.0 of 2026-07-29 or later.
- **A running stone and NetLDI** with the configured names. The NetLDI must run
  in guest mode (`startnetldi -g -a <developer>`) as the developer's
  operating-system account, so sessions need no host password.
- **Python's environment on the NetLDI.** Sessions inherit the NetLDI's
  environment, and Grail finds itself through it, so start the NetLDI with
  these set to the developer's GemDB Code root path (`~/GemDB` by default):

  ```sh
  GRAIL_DIR=/home/<developer>/GemDB/grail
  PYTHON_PACKAGE_PATH=/home/<developer>/GemDB/grail/src/python
  SHIM_LIB_PATH=/home/<developer>/GemDB/grail/src/c/shim/libcpython_ua.so
  ```

- **Grail's shared base, installed once.** Its `install_base.sh` sets the
  database's Unicode comparison mode and a marker in Globals, both of which
  need SystemUser; GemDB Code's installer runs it only if the marker is
  missing, and logs in as SystemUser with the stock password to do it. Run it
  as SystemUser before handing the database over, at the Grail commit GemDB
  Code bundles (`PINNED_GRAIL_REF` in `vendor-pins.sh`).
- **An account for the developer** with the `CodeModification` privilege,
  which is what defining classes and methods needs, and with which Grail
  installs. An ordinary account cannot create the MCP server's `McpReadOnly`
  user, so `gemdb.mcp.readOnly` needs that user created by an administrator.
- **Access for linked sessions.** The `gemdb` command runs Python in a linked
  session as the developer's account, which needs read-write access to the
  extent and the shared page cache — typically by putting that account in the
  stone owner's group, with the extent `660` and the cache at its default
  `SHR_PAGE_CACHE_PERMISSIONS` of `0660`.

#!/bin/sh
#
# Pinned upstream commits for the payloads GemDB bundles into the .vsix.
# Sourced by scripts/bundle-grail.sh and scripts/bundle-mcp.sh, and read as
# text by scripts/bundle-stats.mjs; not meant to be run on its own.
#
# Full 40-character shas, not tags for now: neither upstream publishes tags worth
# tracking yet. Override per-build with GRAIL_REF/MCP_REF -- these are read only
# when that env var is unset.
#
# Bumping a pin is a one-line PR to this file; a green CI run on it is the
# proof the new upstream commit works.

# Grail: main as of 2026-11-02 (c893bce), for the 1.10.0 release, 96 PRs on
# from 29833cd -- which brought the engine move to 4.0.0.a8 (GemDB_Code #178):
# #1867's scripts/upgrade_engine.sh --in-place, which GemDB runs to upgrade an
# a5 database in place (upgradeImage.topaz for a8 bundled under
# scripts/upgrade/4.0.0.a8; the temporary stone on GemDB's own stone config),
# the install's repair of a Grail an engine upgrade stripped, and
# scripts/redeployModules.gs, which install-grail.sh runs last; #1888's
# defaults re-evaluated on a rebuild; #1886's compile() inside an
# except SyntaxError: handler. Since 29833cd it carries:
#   - #1949, #1957: a rebuild (the redeploy after an install) keeps the class
#     of stored float and int subclass instances and of int- and float-mixin
#     enum members, and a functional-API enum (Enum('Color', ...)) keeps its
#     class and members. One gap, from 1.9.0's Grail only (c8cbc92 kept a
#     functional mixin enum's members in the session): those members come back
#     equal, not identical (Grail #1957, "Known gap").
#   - #1934, #1958: a native module's data attribute that Python assigned
#     (sys.argv, sys.excepthook, ...) is what Smalltalk reads back too, and
#     assigning a function to one no longer turns it into a call; an uncaught
#     exception goes through an assigned sys.excepthook (#1899: the default
#     hook prints the traceback to sys.stderr).
#   - #1962, #1963: re-running an unchanged script under a namespace (or a
#     session-local one declaring __transient__) writes nothing, so it leaves
#     no dirty session and commits no records.
#   - #1951, #1932: an imported module's source, and compile() of bytes, are
#     read in the encoding their PEP 263 declaration names.
#   - #1905: the CPython shim frees C objects whose count reaches zero.
#   - CPython conformance: SyntaxErrors (f-strings, tabs, future statements,
#     missing commas, CRLF source), built-in type and descriptor refusals in
#     CPython's words, exception copy/pickle, property getter/setter chains,
#     super() binding, format() of int/float/str subclasses.
# Since 06ccec5 (29 PRs) it carries:
#   - #1987: a module body that fails writes none of its records, so the
#     install's redeploy can repair a base change nothing is stored against
#     (1.9.0's email.message.EmailMessage, Message -> MIMEPart) instead of
#     refusing it -- and every module importing email after it -- and running
#     out of temporary memory on the repeated failed builds. 06ccec5 failed
#     the brain-freeze upgrade gate on exactly that.
#   - #1995: exec'd code writes globals through and keeps comprehension
#     targets.
#   - #2000, #2004, #2011: a nested class, a function attribute and an
#     annotated store run at their own place in the class body; #1998, #2010:
#     a metaclass that is no class is called with the namespace, and a class
#     type() builds is treated as a class statement's.
#   - #1990, #1991, #1976: __annotate__ and __annotations__ follow CPython's
#     getsets, and a method's annotations see its class namespace.
#   - #1992-#1997: PEP 695 type parameters and type aliases (class scope,
#     generic methods, private-name mangling, refusals) as CPython has them.
#   - #2006, #2007, #2008, #2009: string.templatelib (t-strings), ctypes'
#     generic types and GenericAlias attribute reads as CPython's.
#   - #2012: a warning raised in a finalizer hook is blamed on <sys>.
#   - #1977-#1988: install.sh refuses a product that cannot build methods
#     through IR (4.0.0.a8 can), and IR codegen groundwork.
# Since c893bce (the 1.10.0 pin), main as of 2026-11-06 (4d57909), 149 PRs.
# Taken for #2106, which writes sys.stderr to fd 2: GemDB_Code #191 already
# installs #GrailConsoleErr for gemdb file runs, and it was inert until now.
# The installer is unchanged across the range -- install.sh,
# scripts/install_rowan.gs, scripts/upgrade_engine.sh, scripts/upgrade/,
# scripts/redeployModules.gs and the shim are byte-identical -- except that
# rowan's postload doit gains two steps: registering io.UnsupportedOperation's
# kernel exception bases, and #2130's removal of the change stamps a runtime
# compile left before #2108 (#1971), which kept a class Grail built
# persistent. Idempotent; on a database 1.10.0 set up it removes those stamps.
# Otherwise it carries:
#   - #2106 (#1972): sys.stderr is fd 2, not fd 1. #2129 (#2122): logging's
#     lastResort and the implicit basicConfig() as CPython has them.
#   - #2107: after gemdb.modules.relocate(), a module whose file moved records
#     its new file even when its source is unchanged; #2132: functional enums
#     keep their members across importlib.reload; #2109: a star import no longer
#     binds a stray initialize; #2131 (#1973): a module accessor that
#     computes its value honours a Python assignment.
#   - calendar (#2060), configparser (#2055), locale (#2044) and keyword
#     (#2045) are CPython's own; time.struct_time, os.stat_result and
#     sys.version_info are struct sequences (#2053, #2058); datetime takes any
#     int for its fields (#2054); io's FileIO, BytesIO and StringIO bind and
#     refuse as CPython's do (#2031, #2081-#2084, #2094, #2095, #2178).
#   - CPython conformance: Argument Clinic signatures and refusals, buffer
#     protocol (PEP 688) and memoryview, descriptors and metaclasses, f-string
#     and lexer errors, and more of CPython 3.14's test corpus passing.
PINNED_GRAIL_REF=4d5790905d8211c138bda69581d3485b72c19a70

# mcp_server: 0.9.0 (main as of 2026-10-19), 20 commits (9 PRs) on from the
# previous pin (d836520) -- and, like Grail, NOW A ROWAN PROJECT (#57). Its six
# packages are Tonel in src/Mcp-* (components Core, Auth, Grail), its project is
# in rowan/, and install.sh loads it with Rowan by default; the src/*/load.gs
# loaders are gone. The Grail component -- the Python toolset GemDB serves --
# loads ONLY through Rowan: the release's file-out (--from-gs) carries Core and
# Auth. GemDB's flags are unchanged (--grail --no-auth), bundle-mcp.sh ships
# rowan/ and checks every package the components name, and check-vsix.sh looks
# for the Rowan router class. Also: every forked gem reaches the stone by
# localhost (#63), topaz runs with -i so no .topazini is read (#62), and
# find_python_senders takes its positions from Grail's send sites (#65).
PINNED_MCP_REF=7ab106728285c41f573b5469b8c341dfdad988aa

# GemDB Stats: a release asset, not a commit. Its web build needs the Flutter
# SDK to compile, which GemDB Code's CI does not carry, so GemDB Stats'
# release.yml publishes it as GemDB-Stats-<version>-web.tar.gz beside the
# desktop builds, and bundle-stats.mjs downloads this one and refuses it unless
# the SHA-256 matches (the release's SHA256SUMS.txt carries the value). Override
# per-build with STATS_URL (and STATS_SHA256), or STATS_WEB for a local build.
#
# v1.1.1 (3f6487d), released 2026-10-06. v1.1.0 was the first release with the
# web build, including GemDB_Stats PR #10, which lets GemDB Code choose the file
# (ready / open / pickFile) and starts Flutter without a service worker. v1.1.1
# adds PR #16: the web build opens a .gz that statmonitor is still writing,
# with every sample so far, where v1.1.0 failed with "Compressed input was
# truncated" -- which is today's file whenever the database is recording.
PINNED_STATS_URL=https://github.com/GemTalk/GemDB_Stats/releases/download/v1.1.1/GemDB-Stats-1.1.1-web.tar.gz
PINNED_STATS_SHA256=d319df2541482a5032e1d87255f2b6a3ed658fb3cd6f7a4ce7907b12e6f060b6

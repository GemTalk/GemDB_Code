#!/bin/bash
#
# Install Grail into the GemDB database.
#
# This is GemDB's own installer, standing in for Grail's ./install.sh. The
# difference is one step: Grail's script compiles the CPython shim from source,
# which needs a C toolchain and the engine's headers. GemDB ships that library
# prebuilt inside the extension, so the compile is skipped and a new developer
# needs no compiler at all. Everything else below is the same sequence Grail's
# own installer runs, in the same order, and it is kept deliberately close to
# that script so the two can be diffed when Grail moves.
#
# Required environment:
#   GRAIL_DIR            staged Grail checkout (also the working directory)
#   GEMSTONE             engine product directory
#   GEMSTONE_GLOBAL_DIR  engine global directory
#   GEMDB_STONE          stone name
#   GEMDB_USER           login user for the per-user install
#   GEMDB_PASSWORD       that user's password
#   SHIM_LIB_PATH        prebuilt CPython shim (empty to install without it)
#   PYTHON_PACKAGE_PATH  Grail's Python package root
#
set -euo pipefail

: "${GRAIL_DIR:?GRAIL_DIR is not set}"
: "${GEMSTONE:?GEMSTONE is not set}"
: "${GEMDB_STONE:?GEMDB_STONE is not set}"
: "${GEMDB_USER:?GEMDB_USER is not set}"
: "${GEMDB_PASSWORD:?GEMDB_PASSWORD is not set}"

export PATH="$GEMSTONE/bin:$PATH"
cd "$GRAIL_DIR"

if ! command -v topaz >/dev/null 2>&1; then
    echo "ERROR: topaz is not on PATH (looked in $GEMSTONE/bin)." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Topaz session defaults.
# ---------------------------------------------------------------------------
# Grail's install scripts deliberately do NOT hardcode a user or stone: they
# read both from ./.topazini, so that the same scripts can install a per-user
# Grail for whoever is running them. GemDB writes that file to point at its own
# single database.
cat > "$GRAIL_DIR/.topazini" <<EOF
! Written by GemDB. Edit gemdb settings rather than this file.
set user $GEMDB_USER pass $GEMDB_PASSWORD
set gemstone $GEMDB_STONE
EOF

# Report the whole of version.txt, not just the three-part version. GemDB pins
# one engine, so the version alone no longer distinguishes anything a log
# reader needs -- but the Build: line carries the commit the binary was made
# from, which is the first question when a file-in fails on one machine and not
# another. (Grail's own installer prints it for the same reason.)
echo "Database engine:"
sed 's/^/  version.txt | /' "$GEMSTONE/version.txt" 2>/dev/null || echo "  (no version.txt)"

run_topaz() {
    local script="$1"
    if [ ! -f "$script" ]; then
        echo "ERROR: expected Grail script is missing: $script" >&2
        exit 1
    fi
    echo "--- topaz $script"
    LC_ALL=C topaz -lq -S "$script" < /dev/null
}

# ---------------------------------------------------------------------------
# Step 0: the database has Rowan.
# ---------------------------------------------------------------------------
# Grail is a Rowan project, loaded into an image started from the engine's
# bin/extent0.rowan3.dbf. A database GemDB created before 1.9 started from the
# plain extent0.dbf and has no Rowan, and nothing can add it in place, so say
# that in a sentence rather than let the load fail deep inside with "Rowan does
# not understand". GemDB's own database is refused before it starts
# (assertDatabaseHasRowan); this catches an external one too. Only a positive
# "absent" stops here: an inconclusive probe leaves the install to report.
# The script is read into a variable rather than written as a heredoc inside
# $( ): macOS's bash 3.2 mis-parses a quoted heredoc in a command substitution.
read -r -d '' ROWAN_PROBE_GS <<'EOF' || true
login
run
'GEMDB_ROWAN=' , ((System myUserProfile symbolList objectNamed: #Rowan) isNil
  ifTrue: ['absent'] ifFalse: ['present'])
%
logout
exit
EOF
ROWAN_PROBE=$(printf '%s\n' "$ROWAN_PROBE_GS" | LC_ALL=C topaz -lq 2>/dev/null || true)
if printf '%s\n' "$ROWAN_PROBE" | grep -q 'GEMDB_ROWAN=absent'; then
    echo "ERROR: this database has no Rowan, and Grail installs through Rowan." >&2
    echo "       It was created from the engine's extent0.dbf; Grail needs one created from" >&2
    echo "       bin/extent0.rowan3.dbf. Recreate the database to install Python support." >&2
    exit 3
fi

# ---------------------------------------------------------------------------
# Step 1: the shared base, installed once per extent, as SystemUser.
# ---------------------------------------------------------------------------
# The base is what an ordinary (non-SystemUser) session may not create for
# itself: Unicode comparison mode, which the kernel allows only SystemUser to
# set, and a marker in Globals, which objectSecurityPolicyId 1 refuses to
# anyone else. Grail's ./install_base.sh is exactly those two steps, so GemDB
# runs that script rather than reimplementing it.
#
# Probed rather than run unconditionally, which is also what Grail's install.sh
# does: on every install after the first the base is already there, and the
# branch below never runs -- so installing Grail touches SystemUser exactly
# once per database.
#
# Only a positive "absent" triggers it. An inconclusive probe (the stone is
# down, the login failed) steps aside and lets the real install report that in
# its own words.
echo "== Checking for the shared Grail base"
BASE_PROBE=$(LC_ALL=C topaz -lq -S "$GRAIL_DIR/scripts/check_base_installed.gs" < /dev/null 2>/dev/null || true)
if printf '%s\n' "$BASE_PROBE" | grep -q 'GRAIL_BASE=absent'; then
    echo "== Installing the shared Grail base (SystemUser)"
    "$GRAIL_DIR/install_base.sh"

    # Re-probe rather than assume: install_base.sh writes its marker last, so a
    # base still absent here means a step failed without a non-zero exit --
    # better caught now than as a SecurityError minutes into the Rowan load.
    BASE_PROBE=$(LC_ALL=C topaz -lq -S "$GRAIL_DIR/scripts/check_base_installed.gs" < /dev/null 2>/dev/null || true)
    if printf '%s\n' "$BASE_PROBE" | grep -q 'GRAIL_BASE=absent'; then
        echo "ERROR: install_base.sh reported success but the base marker is still absent." >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Step 2: the per-user install.
# ---------------------------------------------------------------------------
# The Rowan load's post-load doits read SHIM_LIB_PATH from the session
# environment and record it in the database, so every later session finds the shim without the variable
# being set again. That recorded path is why GemDB stages Grail to a stable
# directory instead of running it from inside the extension.
#
# PYTHON_LIB_PATH is deliberately not set. It points Grail at a CPython shared
# library on the host for its embedded-FFI backend, and GemDB's whole promise
# is a Python that needs nothing installed on the machine; the install treats it
# as optional, so leaving it unset simply leaves that backend unconfigured.
export SHIM_LIB_PATH="${SHIM_LIB_PATH:-}"
export PYTHON_PACKAGE_PATH="${PYTHON_PACKAGE_PATH:-$GRAIL_DIR/src/python}"
export GRAIL_DIR

if [ -n "$SHIM_LIB_PATH" ] && [ ! -f "$SHIM_LIB_PATH" ]; then
    echo "WARNING: no prebuilt CPython shim at $SHIM_LIB_PATH." >&2
    echo "         Grail will install, but C extension modules will not be available." >&2
    export SHIM_LIB_PATH=""
fi

echo "== Installing Grail as $GEMDB_USER"
rm -f "$GRAIL_DIR"/*.out
# Rowan loads the Grail project (rowan/specs/Grail.ston, the Tonel packages in
# src/Grail-*), as Grail's install.sh does. It compiles the whole project as one
# patch set, far past gem.conf's temporary object space, so this one gem gets
# Grail's figure; GEM_TEMPOBJ_CACHE_SIZE is a ceiling it grows into, not a
# reservation.
echo "--- topaz scripts/install_rowan.gs"
LC_ALL=C topaz -lq -C "GEM_TEMPOBJ_CACHE_SIZE=1000000;" -S scripts/install_rowan.gs < /dev/null

# ---------------------------------------------------------------------------
# Step 3: deploy gemdb, so a fresh session starts clean.
# ---------------------------------------------------------------------------
# One cold import of the `gemdb` module, committed here, so that no user
# session has to make it. Compiling a module is a WRITE -- it creates the
# module's class in the committed PythonModules -- so without this the first
# `import gemdb` in every new session dirties the transaction, and
# `gemdb.transaction()` then refuses to start, describing pending changes the
# user did not make. Deploying here turns that import into a warm bind.
#
# After the Rowan load, never before: the load recreates the Python runtime
# classes and bumps Grail's runtime generation, which discards any deployment
# made under the previous one.
echo "== Deploying gemdb"
run_topaz scripts/deployGemdb.gs

# ---------------------------------------------------------------------------
# Step 4: build unicodedata's tables, for the same reason.
# ---------------------------------------------------------------------------
# The first normalize/category/... call in a session parses the Unicode tables
# into a database cached in a module global: about a second for both versions,
# and the session is left with something to commit. Built and committed here, a
# fresh session's first call costs milliseconds and writes nothing. Since Grail
# #1512, compiling an identifier NFKC can change (`µ`) reaches it too.
#
# A failure is a warning, as in Grail's install.sh: Python works without it,
# only slower and dirtier on first use, which is no reason to fail a setup.
echo "== Building unicodedata"
if LC_ALL=C topaz -lq -S scripts/deployUnicodedata.gs < /dev/null \
     | grep -E 'deployUnicodedata: both databases built'; then
    :
else
    echo "WARNING: building unicodedata's tables failed. Grail is installed, but each" >&2
    echo "         session's first unicodedata call will rebuild them and leave the" >&2
    echo "         session with something to commit." >&2
fi

# Rebuild every other deployed module the install made stale, and commit it --
# last, as Grail's own install.sh does: after gemdb and unicodedata, which the
# steps above have just deployed under the new GrailRuntimeGeneration, so this
# finds them current and leaves them alone. Every other module a user's code
# deployed (an app's, the stdlib ones it imported) is stale after an install,
# and without this its next import rebuilds it in whichever session imports it
# first, dirtying that session. It is also where Grail repairs a deployed class
# whose bases a newer Grail changed while no instance of it is stored -- e.g.
# EmailMessage (Message -> MIMEPart) once Grail took CPython's email package --
# which a plain import refuses. Measured on the brain-freeze upgrade gate: after
# a5 -> a8 the web app's `import email.message` was refused until this ran.
#
# A WARNING on failure, as in Grail's install.sh: the modules it could not
# rebuild stay stale and rebuild (or raise) on their next import, as they would
# have anyway, so Python support is still installed.
echo "== Rebuilding the deployed modules"
# Every `redeployModules:` line goes to the log, not only the summary, so a
# module that failed or was skipped is named where the user can find it.
REDEPLOY_OUT=$(LC_ALL=C topaz -lq -C "GEM_TEMPOBJ_CODE_SIZE=300000;GEM_TEMPOBJ_CACHE_SIZE=900000;" \
     -S scripts/redeployModules.gs < /dev/null 2>&1 || true)
printf '%s\n' "$REDEPLOY_OUT" | grep -E '^redeployModules:' || true
if printf '%s\n' "$REDEPLOY_OUT" \
     | grep -qE '^redeployModules: [0-9]+ rebuilt, [0-9]+ skipped, 0 failed'; then
    :
else
    echo "WARNING: rebuilding the deployed modules failed for some of them. Grail is" >&2
    echo "         installed; each of those rebuilds on its next import, and leaves" >&2
    echo "         that session with something to commit. Run" >&2
    echo "         $GRAIL_DIR/scripts/redeployModules.gs in topaz to see which, and why." >&2
fi

echo "== Grail installed"

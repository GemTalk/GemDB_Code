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
    # better caught now than as a SecurityError minutes into install.gs.
    BASE_PROBE=$(LC_ALL=C topaz -lq -S "$GRAIL_DIR/scripts/check_base_installed.gs" < /dev/null 2>/dev/null || true)
    if printf '%s\n' "$BASE_PROBE" | grep -q 'GRAIL_BASE=absent'; then
        echo "ERROR: install_base.sh reported success but the base marker is still absent." >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Step 2: the per-user install.
# ---------------------------------------------------------------------------
# install.gs reads SHIM_LIB_PATH from the session environment and records it in
# the database, so every later session finds the shim without the variable
# being set again. That recorded path is why GemDB stages Grail to a stable
# directory instead of running it from inside the extension.
#
# PYTHON_LIB_PATH is deliberately not set. It points Grail at a CPython shared
# library on the host for its embedded-FFI backend, and GemDB's whole promise
# is a Python that needs nothing installed on the machine; install.gs treats it
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
run_topaz src/smalltalk/install.gs

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
# After install.gs, never before: install.gs recreates the Python runtime
# classes and bumps Grail's runtime generation, which discards any deployment
# made under the previous one.
echo "== Deploying gemdb"
run_topaz scripts/deployGemdb.gs

echo "== Grail installed"

#!/bin/bash
# Configure macOS shared memory for the GemDB database engine.
# Run with: sudo ./setSharedMemoryDarwin.sh
# Changes take effect immediately; no restart required.
#
# Only ever raises a limit, now and at every boot. This script is reachable
# from "GemDB: Configure Shared Memory" on a Mac that is already fine, and
# other tools install LaunchDaemons that set these same limits higher (Jasper's
# com.gemtalksystems.shared-memory, for one). launchd runs RunAtLoad daemons in
# no fixed order, so a daemon that set the engine's minimum unconditionally
# would lower theirs on the boots where it happened to run last.

set -e

PLIST_PATH="/Library/LaunchDaemons/com.gemdb.shared-memory.plist"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root. Use: sudo $0"
  exit 1
fi

# The one definition of "raise it if it is below what the engine needs": run
# now, and embedded in the LaunchDaemon so every boot applies the same rule.
# Plain integer comparison is safe here, unlike on Linux: macOS limits are
# nowhere near 64 bits. Kept free of <, > and & so it can sit in the plist
# unescaped.
# shellcheck disable=SC2016 # single-quoted on purpose: expanded when it runs, not here
RAISE='set -e
for setting in kern.sysv.shmmax=1073741824 kern.sysv.shmall=262144; do
  key=${setting%=*}
  want=${setting#*=}
  current=$(/usr/sbin/sysctl -n "$key")
  if [ "$current" -lt "$want" ]; then
    /usr/sbin/sysctl -w "$setting"
  else
    echo "$key is already $current, which is enough; leaving it."
  fi
done'

before=$(/usr/sbin/sysctl -n kern.sysv.shmmax kern.sysv.shmall)
/bin/sh -c "$RAISE"
after=$(/usr/sbin/sysctl -n kern.sysv.shmmax kern.sysv.shmall)

# Persist only when something was raised -- nothing machine-wide is installed
# on a Mac that did not need it -- or when a daemon is already there, since one
# written by an earlier version of this script sets its values unconditionally
# and has to be replaced to stop it lowering anything at boot.
if [ "$before" = "$after" ] && [ ! -f "$PLIST_PATH" ]; then
  echo "Shared memory was already enough. Nothing changed."
  exit 0
fi

cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gemdb.shared-memory</string>
  <key>UserName</key>
  <string>root</string>
  <key>GroupName</key>
  <string>wheel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$RAISE</string>
  </array>
  <key>KeepAlive</key>
  <false/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

chown root:wheel "$PLIST_PATH"
chmod 644 "$PLIST_PATH"

if [ "$before" = "$after" ]; then
  echo "Shared memory was already enough. Updated $PLIST_PATH so boot only ever raises it."
else
  echo "Shared memory configured at $PLIST_PATH"
  echo "Changes are active immediately. No restart required."
fi

#!/bin/bash
# Configure Linux shared memory for the GemDB database engine.
# Run with: sudo ./setSharedMemoryLinux.sh
# Changes take effect immediately; no restart required.
#
# Only ever raises a limit. A current kernel's default is far above what the
# engine needs, and this script is also reachable from "GemDB: Configure Shared
# Memory" on a machine that is already fine -- so writing the engine's minimum
# unconditionally would lower a limit something else on the machine relies on.

set -e

SYSCTL_CONF="/etc/sysctl.d/60-gemdb.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root. Use: sudo $0"
  exit 1
fi

# Is decimal string $1 less than $2? Compared as strings, not with $((...)):
# the stock limit is 18446744073692774399, which overflows bash's signed 64-bit
# integers.
less_than() {
  if [ ${#1} -ne ${#2} ]; then
    [ ${#1} -lt ${#2} ]
  else
    [[ $1 < $2 ]]
  fi
}

# Record a raised value so it survives a reboot, replacing any line for the
# same key a previous run left, and leaving the other key's line alone.
persist() {
  if [ ! -f "$SYSCTL_CONF" ]; then
    echo "# GemDB database engine shared memory settings" >"$SYSCTL_CONF"
  fi
  sed -i "/^${1//./\\.}[[:space:]]*=/d" "$SYSCTL_CONF"
  echo "$1 = $2" >>"$SYSCTL_CONF"
}

raised=0
raise() {
  local current
  current=$(sysctl -n "$1")
  if less_than "$current" "$2"; then
    sysctl -w "$1=$2"
    persist "$1" "$2"
    raised=1
  else
    echo "$1 is already $current, which is enough; leaving it."
  fi
}

raise kernel.shmmax 1073741824 # 1 GB, in bytes
raise kernel.shmall 262144     # 1 GB, in 4 KiB pages

if [ "$raised" -eq 1 ]; then
  echo "Shared memory configured at $SYSCTL_CONF"
  echo "Changes are active immediately. No restart required."
else
  echo "Shared memory was already enough. Nothing changed."
fi

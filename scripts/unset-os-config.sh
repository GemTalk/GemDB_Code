#!/bin/bash
# Put the operating system back the way ensureOsConfigured() found it, so that
# first-run setup can be tested against an unconfigured machine.
#
#   sudo ./scripts/unset-os-config.sh
#
# Development tooling: this lives under scripts/, which .vscodeignore keeps out
# of the .vsix, and no command invokes it. That is deliberate rather than
# incidental. Raising shared memory is machine-wide, so anything else that
# depends on it -- Jasper, PostgreSQL, another GemStone install -- is relying on
# the same setting, and an extension that quietly lowered it on uninstall would
# break software it knows nothing about. Reverting is a decision for whoever
# owns the machine, taken at a prompt, not a side effect of removing GemDB.
#
# No restart is required, on either platform. The folklore that macOS freezes
# the SysV shared-memory tunables once the subsystem initializes is out of date:
# in xnu's sysctl_shminfo() (bsd/kern/sysv_shm.c) the only tunable refused after
# init is kern.sysv.shmmni. shmmax and shmall stay writable in both directions
# for the life of the boot -- which is also why the setup scripts can raise them
# without a reboot. Linux never froze them.

set -u

REQUIRED_GB=1

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root. Use: sudo $0" >&2
  exit 1
fi

# Existing segments keep the memory they were given -- the limit is only
# consulted when a segment is created (shm_committed + size > shmall). So
# lowering it under a running database is harmless, but the database will not
# come back after it stops.
segments=$(ipcs -m 2>/dev/null | grep -c '^m ')
if [ "${segments:-0}" -gt 0 ]; then
  echo "Note: ${segments} SysV shared memory segment(s) are in use right now."
  echo "      Lowering the limit does not disturb them, but a database that"
  echo "      stops will not be able to start again. Stop them first if you"
  echo "      want a clean slate."
  echo
fi

case "$(uname -s)" in
Darwin)
  PLIST="/Library/LaunchDaemons/com.gemdb.shared-memory.plist"
  if [ -f "$PLIST" ]; then
    launchctl bootout system "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed ${PLIST}"
  else
    echo "No ${PLIST} -- nothing to remove."
  fi

  # Any other daemon that raises these will simply put them back at the next
  # boot, and on a machine that also runs Jasper there is one.
  others=$(grep -l 'kern\.sysv\.shm' /Library/LaunchDaemons/*.plist 2>/dev/null)
  if [ -n "${others}" ]; then
    echo
    echo "Warning: these other LaunchDaemons also raise shared memory, and will"
    echo "         restore it at the next boot:"
    echo "${others}" | sed 's/^/           /'
    echo "         Jasper installs one of them. Leave it alone unless you mean"
    echo "         to un-configure Jasper as well."
  fi

  # xnu's compiled-in defaults: DEFAULT_SHMMAX 4 MB, DEFAULT_SHMALL 1024 pages.
  echo
  sysctl -w kern.sysv.shmmax=4194304 kern.sysv.shmall=1024
  shmmax=$(sysctl -n kern.sysv.shmmax)
  shmall=$(sysctl -n kern.sysv.shmall)
  ;;

Linux)
  CONF="/etc/sysctl.d/60-gemdb.conf"
  if [ -f "${CONF}" ]; then
    rm -f "${CONF}"
    echo "Removed ${CONF}"
  else
    echo "No ${CONF} -- nothing to remove."
  fi

  IPC_CONF="/etc/systemd/logind.conf.d/gemdb.conf"
  if [ -f "${IPC_CONF}" ]; then
    rm -f "${IPC_CONF}"
    echo "Removed ${IPC_CONF}"
    echo "  RemoveIPC goes back to the systemd default at the next boot, or now"
    echo "  with: sudo systemctl restart systemd-logind"
  fi

  # The kernel's own default since 3.16: ULONG_MAX - (1 << 24), i.e. no
  # practical limit. Note this is *larger* than what setSharedMemoryLinux.sh
  # writes -- on a current kernel that script is a formality, and only matters
  # on a distribution that still ships the old 32 MB cap.
  echo
  sysctl -w kernel.shmmax=18446744073692774399 kernel.shmall=18446744073692774399
  shmmax=$(sysctl -n kernel.shmmax)
  shmall=$(sysctl -n kernel.shmall)
  ;;

*)
  echo "Unsupported platform: $(uname -s). GemDB supports macOS and Linux." >&2
  exit 1
  ;;
esac

# The same arithmetic isSharedMemoryConfigured() uses, so the verdict below is
# the one the extension will reach. Both count shmall in 4096-byte units, which
# is right even where the hardware page is larger: xnu's btoc(), the macro that
# converts a segment size to the units shmall is measured in, is defined against
# a hardcoded NBPG of 4096 in bsd/arm/param.h -- not the 16 KiB VM page that
# Apple silicon actually uses.
echo
if awk -v m="${shmmax}" -v a="${shmall}" -v n="$((REQUIRED_GB * 1073741824))" \
  'BEGIN { exit !(m >= n && a * 4096 >= n) }'; then
  echo "Shared memory is still at or above ${REQUIRED_GB} GB, so GemDB will go on"
  echo "treating this machine as configured and will not ask for a password."
else
  echo "Shared memory is now below ${REQUIRED_GB} GB. GemDB sees an unconfigured"
  echo "machine and will ask to raise it the next time it needs the database."
fi

echo
echo "Changes are active immediately. No restart required."
echo
echo "To replay first-run setup as well, remove the root path and the marker"
echo "that records that setup was offered (both as yourself, not as root):"
echo "  rm -rf ~/GemDB"
echo "  rm -f ~/Library/Application\\ Support/Code/User/globalStorage/gemdb.gemdb/setup-attempted"

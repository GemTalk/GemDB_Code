#!/bin/bash
# Configure systemd to preserve GemDB shared memory on session logout.
# Without this, systemd destroys the shared memory segment -- and with it the
# running database -- when the login session that started it ends.
# Run with: sudo ./setRemoveIPC.sh

set -e

CONF_DIR="/etc/systemd/logind.conf.d"
CONF_FILE="$CONF_DIR/gemdb.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root. Use: sudo $0"
  exit 1
fi

mkdir -p "$CONF_DIR"

cat > "$CONF_FILE" <<'EOF'
[Login]
RemoveIPC=no
EOF

echo "Configured at $CONF_FILE"

# Writing the file is not enough: the running logind keeps the value it last
# loaded, and it reads that value when a user's last session ends -- so until
# it reloads, a logout still destroys the database. logind re-reads its config
# on SIGHUP (every systemd since at least v245), which applies the change now
# without the session-disrupting restart. `systemctl kill` rather than
# `reload` because older units define no ExecReload.
if systemctl kill --signal=SIGHUP systemd-logind.service 2>/dev/null; then
  # The reload is asynchronous; wait briefly for the running value to change.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ "$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
      org.freedesktop.login1.Manager RemoveIPC 2>/dev/null)" = "b false" ]; then
      echo "Applied: systemd-logind now keeps IPC at logout."
      exit 0
    fi
    sleep 0.2
  done
fi

echo "systemd-logind has not loaded the change. Restart your computer to apply it."

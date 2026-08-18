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
echo "To apply: restart your computer, or run: sudo systemctl restart systemd-logind"

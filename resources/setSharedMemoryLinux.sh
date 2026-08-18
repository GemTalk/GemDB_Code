#!/bin/bash
# Configure Linux shared memory for the GemDB database engine.
# Run with: sudo ./setSharedMemoryLinux.sh
# Changes take effect immediately; no restart required.

set -e

SYSCTL_CONF="/etc/sysctl.d/60-gemdb.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root. Use: sudo $0"
  exit 1
fi

# Apply immediately
sysctl -w kernel.shmmax=1073741824
sysctl -w kernel.shmall=262144

# Persist across reboots
cat > "$SYSCTL_CONF" <<'EOF'
# GemDB database engine shared memory settings
kernel.shmmax = 1073741824
kernel.shmall = 262144
EOF

echo "Shared memory configured at $SYSCTL_CONF"
echo "Changes are active immediately. No restart required."

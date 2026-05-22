#!/bin/bash
set -euo pipefail

# ─── Match host user inside container ────────────────────────────
# Ensures the process runs as the host UID/GID with a matching
# home directory so volume mounts and config paths are consistent.

HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"
HOST_USER="${HOST_USER:-dispatch}"

USER_HOME="/home/$HOST_USER"

# Create group if it doesn't exist
if ! getent group "$HOST_GID" > /dev/null 2>&1; then
    groupadd -g "$HOST_GID" "$HOST_USER"
fi

# Ensure user with this UID has the correct home directory
if id -u "$HOST_UID" > /dev/null 2>&1; then
    USER_NAME=$(getent passwd "$HOST_UID" | cut -d: -f1)
    usermod -d "$USER_HOME" "$USER_NAME" 2>/dev/null || true
else
    useradd -u "$HOST_UID" -g "$HOST_GID" -d "$USER_HOME" -m -s /bin/bash "$HOST_USER"
    USER_NAME="$HOST_USER"
fi

# Ensure home and data directories exist with correct ownership
mkdir -p "$USER_HOME" "$USER_HOME/.local/share/dispatch"
chown "$HOST_UID:$HOST_GID" "$USER_HOME"
chown -R "$HOST_UID:$HOST_GID" "$USER_HOME/.local/share/dispatch"

# Ensure .claude is accessible
if [ -d "$USER_HOME/.claude" ]; then
    chown -R "$HOST_UID:$HOST_GID" "$USER_HOME/.claude" 2>/dev/null || true
fi

# Ensure all node_modules are writable (created as root during build)
find /app -name node_modules -type d -maxdepth 3 -exec chown -R "$HOST_UID:$HOST_GID" {} + 2>/dev/null || true

# Install/update dependencies as the target user (skip with SKIP_INSTALL=1)
if [ "${SKIP_INSTALL:-}" != "1" ]; then
    su -s /bin/bash - "$USER_NAME" -c "export HOME=$USER_HOME && cd /app && bun install"
fi

# Execute the main command as the target user
exec su -s /bin/bash - "$USER_NAME" -c "export HOME=$USER_HOME && cd /app && exec $*"

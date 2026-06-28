#!/usr/bin/env bash
# apply-memory-limits.sh — apply the MemoryMax/MemoryHigh cgroup limits to the
# LIVE dispatch.service WITHOUT a full reinstall. Safe to run while the server
# is up (the limits take effect on the next restart).
#
# What it does (all privileged lines use sudo):
#   1. Copies the updated dispatch.service template to /etc/systemd/system/  (sudo)
#   2. Reloads systemd so it picks up the new unit file                       (sudo)
#   3. Restarts dispatch so the cgroup limits are applied                     (sudo)
#
# Why sudo: /etc/systemd/system/ is root-owned; daemon-reload and restart
# require root. The script carries its own sudo — run it directly (no sudo prefix).
#
# Run:  ./bin/apply-memory-limits.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

SERVICE_SRC="$ROOT/systemd/dispatch.service"
SERVICE_DST="/etc/systemd/system/dispatch.service"

if [ ! -f "$SERVICE_SRC" ]; then
	echo "apply-memory-limits: template not found at $SERVICE_SRC" >&2
	exit 1
fi

echo "[apply] copying updated dispatch.service → $SERVICE_DST"
# Patch in the real user (same as bin/install does)
REAL_USER="${SUDO_USER:-$USER}"
REAL_GROUP=$(id -gn "$REAL_USER" 2>/dev/null || echo "$REAL_USER")
sed "s/^# User\/Group are set by bin/install.*/User=$REAL_USER\nGroup=$REAL_GROUP/" "$SERVICE_SRC" | sudo tee "$SERVICE_DST" > /dev/null
sudo chmod 644 "$SERVICE_DST"

echo "[apply] daemon-reload…"
sudo systemctl daemon-reload

echo "[apply] restarting dispatch (cgroup limits take effect)…"
sudo systemctl restart dispatch

echo "[apply] done!"
echo "  Status:   systemctl status dispatch"
echo "  Memory:   systemctl show dispatch -p MemoryHigh -p MemoryMax"
echo "  Logs:     journalctl -u dispatch -f"

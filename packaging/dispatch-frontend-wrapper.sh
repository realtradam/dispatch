#!/bin/bash
# dispatch-frontend-wrapper.sh
# Wrapper script for running the Dispatch Frontend static-file server
# outside of systemd / s6.
# Install to /usr/bin/dispatch-frontend (chmod 755).
#
# Usage:
#   dispatch-frontend          # runs the server, inheriting the current environment
#   dispatch-frontend --help   # passes flags through to bun

set -euo pipefail

DISPATCH_CONF="/etc/dispatch/dispatch-frontend.conf"
DISPATCH_DIR="/opt/dispatch"
BUN="/usr/bin/bun"
ENTRY_POINT="packages/frontend/serve.ts"

# Source the environment file if it exists
if [[ -f "$DISPATCH_CONF" ]]; then
    set -o allexport
    # shellcheck source=/etc/dispatch/dispatch-frontend.conf
    source "$DISPATCH_CONF"
    set +o allexport
fi

# Change to the application directory
cd "$DISPATCH_DIR"

# Hand off to bun — exec replaces this process so signals are forwarded correctly
exec "$BUN" "$ENTRY_POINT" "$@"

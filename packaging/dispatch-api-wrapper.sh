#!/bin/bash
# dispatch-api-wrapper.sh
# Wrapper script for running the Dispatch API outside of systemd.
# Install to /usr/bin/dispatch-api (chmod 755).
#
# Usage:
#   dispatch-api          # runs the server, inheriting the current environment
#   dispatch-api --help   # passes flags through to bun

set -euo pipefail

DISPATCH_CONF="/etc/dispatch/dispatch-api.conf"
DISPATCH_DIR="/opt/dispatch"
BUN="/usr/bin/bun"
ENTRY_POINT="packages/api/src/index.ts"

# Source the environment file if it exists
if [[ -f "$DISPATCH_CONF" ]]; then
    # Export every variable defined in the conf file so child processes see them.
    # Lines starting with '#' and blank lines are skipped automatically by bash's
    # 'source' builtin.
    set -o allexport
    # shellcheck source=/etc/dispatch/dispatch-api.conf
    source "$DISPATCH_CONF"
    set +o allexport
fi

# Change to the application directory
cd "$DISPATCH_DIR"

# Hand off to bun — exec replaces this process so signals are forwarded correctly
exec "$BUN" "$ENTRY_POINT" "$@"

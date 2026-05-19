#!/bin/bash
set -euo pipefail

# Install/update dependencies.
# Source code is bind-mounted from the host; node_modules lives on the host
# filesystem via the bind mount so it persists across container restarts
# and is shared between the api and frontend services.
bun install

# Execute the main command
exec "$@"

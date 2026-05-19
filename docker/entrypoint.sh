#!/bin/bash
set -euo pipefail

# Production entrypoint
# Future phases: add database migrations here

# Execute the main command
exec "$@"

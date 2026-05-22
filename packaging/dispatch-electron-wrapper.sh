#!/bin/bash
exec /usr/bin/electron --name="Dispatch" /opt/dispatch/packages/frontend/electron/main.cjs "$@"

#!/bin/bash
exec /usr/bin/electron --name="Dispatch" /opt/dispatch-electron/electron/main.cjs "$@"

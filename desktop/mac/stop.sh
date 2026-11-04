#!/bin/bash
set -euo pipefail
clock_pid=${1:-}
case "$clock_pid" in ''|*[!0-9]*) exit 0 ;; esac
clock_main="$HOME/Library/Application Support/Katra Clock/app/desktop/main.mjs"
clock_command=$(/bin/ps -p "$clock_pid" -o command= 2>/dev/null || true)
case "$clock_command" in *"$clock_main"*) /bin/kill -TERM "$clock_pid" 2>/dev/null || true ;; esac

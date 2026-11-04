#!/bin/bash
set -euo pipefail
umask 077
clock_support="$HOME/Library/Application Support/Katra Clock"
clock_main="$clock_support/app/desktop/main.mjs"
clock_pidfile="$clock_support/clock.pid"
if [ -f "$clock_pidfile" ]; then
  clock_old_pid=$(cat "$clock_pidfile")
  case "$clock_old_pid" in
    ''|*[!0-9]*) ;;
    *)
      clock_command=$(/bin/ps -p "$clock_old_pid" -o command= 2>/dev/null || true)
      case "$clock_command" in
        *"$clock_main"*) /usr/bin/open 'http://127.0.0.1:34157/'; printf '%s\n' "$clock_old_pid"; exit 0 ;;
      esac
      ;;
  esac
fi
"$clock_support/runtime/bin/node" "$clock_main" </dev/null >"$clock_support/clock.log" 2>&1 &
clock_pid=$!
printf '%s\n' "$clock_pid" >"$clock_pidfile"
printf '%s\n' "$clock_pid"

#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/.bridge.pid"

if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "Antigravity Bridge (PID: $PID) stopped."
    else
        echo "Antigravity Bridge (PID: $PID) was not running."
    fi
    rm -f "$PIDFILE"
else
    # Also check by process name / port
    PID=$(lsof -ti:8765 2>/dev/null)
    if [ -n "$PID" ]; then
        kill "$PID"
        echo "Antigravity Bridge (PID: $PID) stopped."
    else
        echo "No bridge running on port 8765."
    fi
fi

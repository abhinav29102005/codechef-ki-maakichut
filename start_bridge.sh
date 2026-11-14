#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/.bridge.pid"
LOGFILE="$DIR/.bridge.log"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Antigravity Bridge is already running (PID: $(cat "$PIDFILE"))."
    exit 0
fi

nohup /usr/bin/python3 -B "$DIR/bridge.py" > "$LOGFILE" 2>&1 &
PID=$!
echo $PID > "$PIDFILE"
sleep 1
if kill -0 "$PID" 2>/dev/null; then
    echo "Antigravity Bridge started on http://127.0.0.1:8765 (PID: $PID)"
else
    echo "Failed to start bridge. Log output:"
    cat "$LOGFILE"
    exit 1
fi

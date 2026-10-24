#!/bin/sh
node dist/src/server.js &
api_pid=$!
WORKER_MODE=true node dist/src/workers/index.js &
worker_pid=$!

stop_children() {
  trap '' TERM INT
  kill -TERM "$api_pid" "$worker_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
}
trap 'stop_children; exit 0' TERM INT

# Fail the container when either process exits, so Kubernetes can recover it.
# Launch Node directly so both processes receive shutdown signals and drain jobs.
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
done
if ! kill -0 "$api_pid" 2>/dev/null; then
  wait "$api_pid"
  result=$?
  echo "[Supervisor] API exited with status $result; stopping worker" >&2
else
  wait "$worker_pid"
  result=$?
  echo "[Supervisor] Worker exited with status $result; stopping API" >&2
fi
stop_children
if [ "$result" -eq 0 ]; then result=1; fi
exit "$result"

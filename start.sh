#!/usr/bin/env bash
# Serve the ad generator locally and open it in your browser.
# Usage: ./start.sh [port]   (default port 8000)

cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
URL="http://localhost:${PORT}"

# Pick a Python that has http.server.
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python is required but was not found. Install Python 3 and try again."
  exit 1
fi

# Free the port if something is already serving on it.
if lsof -ti tcp:"${PORT}" >/dev/null 2>&1; then
  echo "Port ${PORT} is busy — stopping the old server…"
  lsof -ti tcp:"${PORT}" | xargs kill 2>/dev/null
  sleep 1
fi

echo "Static Ad Generator → ${URL}"

# Start the server in the background, then open the browser once it's up.
"${PY}" -m http.server "${PORT}" >/dev/null 2>&1 &
SERVER_PID=$!

# Stop the server when you press Ctrl+C.
trap 'echo; echo "Stopping server…"; kill ${SERVER_PID} 2>/dev/null; exit 0' INT TERM

# Wait for the server to respond, then open the default browser.
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "${URL}"; then break; fi
  sleep 0.25
done

if command -v open >/dev/null 2>&1; then
  open "${URL}"        # macOS
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}"    # Linux
fi

echo "Server running. Press Ctrl+C to stop."
wait ${SERVER_PID}

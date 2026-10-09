#!/bin/sh
set -eu

export DISPLAY=:99
export HOME="${HOME:-/home/chromium}"
mkdir -p "$HOME" /tmp/runtime
export XDG_RUNTIME_DIR=/tmp/runtime

Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &

i=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
	i=$((i + 1))
	if [ "$i" -gt 50 ]; then
		echo "Xvfb did not start" >&2
		cat /tmp/xvfb.log >&2 || true
		exit 1
	fi
	sleep 0.1
done

exec chromium \
	--no-memcheck \
	--no-sandbox \
	--disable-dev-shm-usage \
	--no-first-run \
	--no-default-browser-check \
	--window-size=1280,800 \
	--remote-debugging-address=127.0.0.1 \
	--remote-debugging-port=9222 \
	--remote-allow-origins='*' \
	--user-data-dir=/tmp/chromium-profile \
	"$@"

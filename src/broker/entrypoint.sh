#!/bin/sh
set -eu

if [ -n "${SSH_AUTH_SOCK:-}" ]; then
	rm -f "$SSH_AUTH_SOCK"
	ssh-agent -a "$SSH_AUTH_SOCK" >/dev/null
	for key in ${SSH_KEY_FILES:-}; do
		ssh-add -q - <"$key"
	done
fi

exec node /app/broker/broker.cjs

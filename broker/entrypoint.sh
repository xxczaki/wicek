#!/bin/sh
set -eu

CONFDIR="${BROKER_STATE_DIR:-/run/broker-state}"
CA_DIR="${BROKER_CA_DIR:-/run/broker-ca}"

if [ ! -f "$CONFDIR/mitmproxy-ca.pem" ]; then
	python3 -c "import sys; from mitmproxy.certs import CertStore; CertStore.from_store(sys.argv[1], 'mitmproxy', 2048)" "$CONFDIR"
fi
cp "$CONFDIR/mitmproxy-ca-cert.pem" "$CA_DIR/ca.pem.tmp" && mv "$CA_DIR/ca.pem.tmp" "$CA_DIR/ca.pem"
cat /etc/ssl/certs/ca-certificates.crt "$CA_DIR/ca.pem" >"$CA_DIR/bundle.pem.tmp" && mv "$CA_DIR/bundle.pem.tmp" "$CA_DIR/bundle.pem"

if [ -n "${SSH_AUTH_SOCK:-}" ]; then
	rm -f "$SSH_AUTH_SOCK"
	ssh-agent -a "$SSH_AUTH_SOCK" >/dev/null
	for key in ${SSH_KEY_FILES:-}; do
		ssh-add -q - <"$key"
	done
fi

exec mitmdump \
	--listen-host "${BROKER_LISTEN_HOST:-127.0.0.1}" \
	--listen-port "${BROKER_PORT:-3128}" \
	--set confdir="$CONFDIR" \
	--set flow_detail=0 \
	--set block_global=false \
	--scripts /app/credentials.py

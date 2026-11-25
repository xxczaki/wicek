#!/bin/sh
exec tini -s -- python3 /usr/local/lib/chromium-lazy.py "$@"

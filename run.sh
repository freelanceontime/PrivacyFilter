#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
    exec .venv/bin/python -m waitress --listen=127.0.0.1:8787 server:app
fi
exec python3 -m waitress --listen=127.0.0.1:8787 server:app

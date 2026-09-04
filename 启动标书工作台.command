#!/bin/zsh
cd "$(dirname "$0")"
NODE="/Users/lijunjie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
exec "$NODE" server.js

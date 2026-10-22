#!/usr/bin/env bash
# Build only inside an unpublished staging tree. Never update a live runtime.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
for path in pi/package-lock.json server/package-lock.json; do
    [ -f "$root/$path" ] || { printf 'Missing locked dependencies: %s\n' "$path" >&2; exit 1; }
done
(cd "$root/pi" && npm ci --omit=dev)
(cd "$root/server" && npm ci --include=dev && npm run build && npm prune --omit=dev)
for path in pi/node_modules server/node_modules/ws server/dist/cli.js server/dist/bridge.js; do
    [ -e "$root/$path" ] || { printf 'Incomplete runtime build: %s\n' "$path" >&2; exit 1; }
done

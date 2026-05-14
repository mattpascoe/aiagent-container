#!/bin/sh
# This copies the last .claude.json file from the backups into the tmpfs mountpoint
# It is done because we mount read only but claude requires writes into $HOME
# If only they put it in the ~/.claude folder we'd be fine since it is mounted r/w
set -e

latest=$(find ~/.claude/backups -maxdepth 1 -type f -printf '%T@ %p\n' \
    | sort -nr \
    | head -1 \
    | cut -d' ' -f2-)

if [ -n "$latest" ]; then
    cp "$latest" ~/.claude.json
fi

exec claude "$@"

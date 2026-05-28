#!/bin/sh
# This is here as a stub for now
# This way its consistent with how the other containers work.
set -e

# If START_DASHBOARD is set, start the dashboard
# Note this binds to 0.0.0.0 and has insecure flag set.  THIS IS NOT GREAT
# but it is required to expose it to the docker host. Be careful.
if [ -n "$START_DASHBOARD" ]; then
  hermes dashboard --host 0.0.0.0 --insecure --no-open --tui &
fi

# TODO: add a flag for the --tui.  maybe this is just a make run-args --tui

exec hermes "$@"

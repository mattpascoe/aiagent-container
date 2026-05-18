#!/bin/sh
# This is here as a stub for now even tho for pi we just start pi directly.
# This way its consistent with how the other containers work.
set -e

# Directory containing extensions
EXTENSIONS_DIR="/workspace/pi/extensions"

# Build the extension flags
extension_args=""
for ext in "$EXTENSIONS_DIR"/*/index.ts; do
    if [ -f "$ext" ]; then
        extension_args="$extension_args -e $ext"
    fi
done

# Start pi with arguments and load all extensions available in the extensions folder
exec pi $extension_args "$@"

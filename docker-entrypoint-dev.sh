#!/bin/sh
set -e

DATA_DIR="/data"
PLUGIN_DIR="/opt/opcua-suite"
PLUGIN_NAME="node-red-contrib-opcua-suite"
NR_USER="node-red"

echo "=== [entrypoint] Preparing development environment..."

# Phase 1 — /data/lib muss existieren und beschreibbar sein.
# Node-RED legt dort intern /data/lib/flows/ an.
mkdir -p "$DATA_DIR/lib"
chown "$NR_USER:$NR_USER" "$DATA_DIR/lib"
echo "=== [entrypoint] /data/lib is writable"

# Phase 2 — Plugin per Symlink in /data/node_modules verlinken
mkdir -p "$DATA_DIR/node_modules"
chown "$NR_USER:$NR_USER" "$DATA_DIR/node_modules"

LINK_TARGET="$DATA_DIR/node_modules/$PLUGIN_NAME"
if [ -L "$LINK_TARGET" ]; then
    rm "$LINK_TARGET"
elif [ -d "$LINK_TARGET" ]; then
    rm -rf "$LINK_TARGET"
fi
ln -s "$PLUGIN_DIR" "$LINK_TARGET"
chown -h "$NR_USER:$NR_USER" "$LINK_TARGET"
echo "=== [entrypoint] Symlinked $PLUGIN_NAME -> $PLUGIN_DIR"

# Phase 3 — data/package.json sicherstellen
if [ ! -f "$DATA_DIR/package.json" ]; then
    cat > "$DATA_DIR/package.json" <<EOF
{
  "name": "node-red-project",
  "description": "A Node-RED Project",
  "version": "0.0.1",
  "private": true,
  "dependencies": {
    "$PLUGIN_NAME": "file:$PLUGIN_DIR"
  }
}
EOF
    chown "$NR_USER:$NR_USER" "$DATA_DIR/package.json"
    echo "=== [entrypoint] Created $DATA_DIR/package.json"
else
    echo "=== [entrypoint] $DATA_DIR/package.json already exists, skipping"
fi

# Phase 4 — Node-RED als node-red User starten
echo "=== [entrypoint] Starting Node-RED as $NR_USER ..."
exec su-exec "$NR_USER" npm start -- --userDir "$DATA_DIR"

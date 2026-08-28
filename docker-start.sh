#!/bin/bash

# Docker Start Script für Node-RED OPC UA Suite

set -e

echo "🚀 Starte Node-RED OPC UA Suite Docker Container..."

# Prüfe ob Docker installiert ist
if ! command -v docker &> /dev/null; then
    echo "❌ Docker ist nicht installiert. Bitte installiere Docker zuerst."
    exit 1
fi

# Compose auflösen: v2 (docker compose) bevorzugt, v1 (docker-compose) als
# Fallback. DOCKER.md nennt Compose >= 2.0 als Voraussetzung, auf v2-only
# Systemen gibt es das docker-compose Binary nicht mehr.
if docker compose version &> /dev/null; then
    COMPOSE="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE="docker-compose"
else
    echo "❌ Docker Compose ist nicht installiert. Bitte installiere Docker Compose zuerst."
    exit 1
fi
echo "🔧 Verwende: $COMPOSE"

# Erstelle notwendige Verzeichnisse
mkdir -p data logs

# Starte Container
echo "📦 Baue Docker Image..."
$COMPOSE build

echo "▶️  Starte Container..."
$COMPOSE up -d

# Ports laut docker-compose.yml: Node-RED 1881, OPC UA Testserver 4841
echo "✅ Node-RED läuft jetzt auf http://localhost:1881"
echo "   OPC UA Testserver: opc.tcp://localhost:4841"
echo ""
echo "📊 Container Status:"
$COMPOSE ps

echo ""
echo "📝 Logs anzeigen mit: $COMPOSE logs -f"
echo "🛑 Stoppen mit: $COMPOSE down"

#!/bin/bash

# Docker Start Script für Node-RED OPC UA Suite

set -e

echo "🚀 Starte Node-RED OPC UA Suite Docker Container..."

# Prüfe ob Docker installiert ist
if ! command -v docker &> /dev/null; then
    echo "❌ Docker ist nicht installiert. Bitte installiere Docker zuerst."
    exit 1
fi

# Prüfe ob Docker Compose installiert ist
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose ist nicht installiert. Bitte installiere Docker Compose zuerst."
    exit 1
fi

# Erstelle notwendige Verzeichnisse
mkdir -p data logs

# Starte Container
echo "📦 Baue Docker Image..."
docker-compose build

echo "▶️  Starte Container..."
docker-compose up -d

echo "✅ Node-RED läuft jetzt auf http://localhost:1880"
echo ""
echo "📊 Container Status:"
docker-compose ps

echo ""
echo "📝 Logs anzeigen mit: docker-compose logs -f"
echo "🛑 Stoppen mit: docker-compose down"

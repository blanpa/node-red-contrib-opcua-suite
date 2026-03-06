# Quick Start Guide

## Start with Docker

```bash
# Option 1: Start script (recommended)
./docker-start.sh

# Option 2: Make
make build && make up

# Option 3: Docker Compose
docker-compose build
docker-compose up -d
```

## After Startup

1. Open **http://localhost:1881** in your browser
2. The OPC UA Suite nodes are available in the palette under "opcua"
3. Import the example flow: Menu → Import → `examples/all-use-cases.json`

## Stop

```bash
make down
# or
docker-compose down
```

## Status & Logs

```bash
docker-compose ps
docker-compose logs -f
```

## Troubleshooting

See [DOCKER.md](DOCKER.md) for detailed troubleshooting.

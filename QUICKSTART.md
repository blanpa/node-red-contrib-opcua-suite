# Quick Start Guide

## Start with Docker

```bash
# Option 1: Start script (recommended)
./docker-start.sh

# Option 2: Make
make build && make up

# Option 3: Docker Compose
docker compose build
docker compose up -d
```

## After Startup

1. Open **http://localhost:1881** in your browser
2. The OPC UA Suite nodes are available in the palette under "opcua"
3. Import an example flow: **Menu → Import → Examples → node-red-contrib-opcua-suite**
   (the `examples/` folder ships flows `01` – `14`; `14 - Full Suite Validation`
   exercises every node and self-asserts)

## Stop

```bash
make down
# or
docker compose down
```

## Status & Logs

```bash
docker compose ps
docker compose logs -f
```

## Troubleshooting

See [DOCKER.md](DOCKER.md) for detailed troubleshooting.

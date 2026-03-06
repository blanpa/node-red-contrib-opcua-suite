# Docker Deployment Guide

## Quick Start

```bash
docker-compose build
docker-compose up -d
```

Node-RED available at **http://localhost:1881**, OPC UA test server at `opc.tcp://localhost:4841`.

## Prerequisites

- Docker >= 20.10
- Docker Compose >= 2.0

## Commands

### Makefile

```bash
make build      # Build Docker image
make up         # Start containers
make down       # Stop containers
make logs       # Show logs
make restart    # Restart containers
make clean      # Remove containers and volumes
make status     # Show container status
make shell      # Open shell in container
```

### Docker Compose

```bash
docker-compose build                # Build
docker-compose up -d                # Start (background)
docker-compose down                 # Stop
docker-compose logs -f              # Follow logs
docker-compose restart              # Restart
docker-compose ps                   # Status
```

## Configuration

### Ports

Default: Node-RED on port **1881**, OPC UA test server on **4841**. Change in `docker-compose.yml`:

```yaml
ports:
  - "1880:1880"  # external:internal
```

### Volumes

- `./data` — Node-RED user data (flows, credentials)

### Environment Variables

```yaml
environment:
  - NODE_OPTIONS=--max-old-space-size=512
  - TZ=Europe/Berlin
```

## Development Mode

```bash
docker-compose -f docker-compose.dev.yml up
```

Source directories (`nodes/`, `lib/`) are mounted as volumes — changes are visible after Node-RED restart.

## Troubleshooting

### Container won't start

```bash
docker-compose logs          # Check logs
docker-compose up            # Run in foreground
```

### Port already in use

Change port in `docker-compose.yml` or find the process:

```bash
lsof -i :1881
kill <PID>
```

### Native module issues

```bash
docker-compose build --no-cache    # Full rebuild
```

### Data persistence

The `data/` directory is mounted as a volume. `docker-compose down` preserves data. To also remove data: `docker-compose down -v`.

## Production

1. **HTTPS**: Use a reverse proxy (nginx, traefik) with SSL
2. **Credentials**: Use Docker secrets
3. **Backup**: Regular backups of `./data`
4. **Monitoring**: Set up log aggregation

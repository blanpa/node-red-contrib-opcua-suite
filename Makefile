.PHONY: help build up down logs restart clean

help: ## Zeige diese Hilfe
	@echo "Verfügbare Befehle:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Baue Docker Image
	docker compose build

up: ## Starte Container
	docker compose up

down: ## Stoppe Container
	docker compose down

logs: ## Zeige Logs
	docker compose logs -f

restart: ## Starte Container neu
	docker compose restart

clean: ## Entferne Container und Volumes
	docker compose down -v
	docker system prune -f

dev: ## Starte Development Container
	docker compose -f docker-compose.dev.yml up --build

dev-build: ## Baue Development Image
	docker compose -f docker-compose.dev.yml build

shell: ## Öffne Shell im Container
	docker compose exec node-red sh

status: ## Zeige Container Status
	docker compose ps

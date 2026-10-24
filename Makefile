.PHONY: setup up down migrate api engine test test-api test-engine check signing-key

setup:        ## one-time: .env, node deps, python venv
	./scripts/setup.sh

up:           ## start postgres
	docker compose up -d postgres

down:
	docker compose down

migrate:
	./scripts/migrate.sh

api:
	cd services/api && npm start

engine:
	cd services/engine && . .venv/bin/activate && python -m uvicorn app.main:app --port $${ENGINE_PORT:-8001} --reload

signing-key:  ## print a new package-signing key (keep the private key secret)
	@cd services/api && node src/signing-key.js

test: test-api test-engine

test-api:
	cd services/api && npm test

test-engine:
	cd services/engine && . .venv/bin/activate && python -m pytest -q

check:        ## hit health/ready on both services
	curl -s localhost:3000/v1/health; echo
	curl -s localhost:3000/v1/ready; echo
	curl -s localhost:8001/v1/ready; echo

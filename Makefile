PY := .venv/bin/python
NPM := npm

.PHONY: dev build run install test

install:
	python3 -m venv .venv
	.venv/bin/pip install -r backend/requirements.txt
	cd frontend && npm install

dev:
	./scripts/dev.sh

build:
	cd frontend && npm run build

run:  ## production: backend serves the built SPA
	PYTHONPATH=backend $(PY) -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8744

test:
	.venv/bin/python -m pytest backend/tests tests -q
	cd frontend && npm test -- --run

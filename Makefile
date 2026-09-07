PY := backend/.venv/bin/python
NPM := npm

.PHONY: dev build run install test

install:
	backend/.venv/bin/pip install -r backend/requirements.txt
	cd frontend && npm install

dev:
	./scripts/dev.sh

build:
	cd frontend && npm run build

run:  ## production: backend serves the built SPA
	PYTHONPATH=backend $(PY) -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8744

test:
	backend/.venv/bin/python -m pytest backend/tests tests -q
	cd frontend && npm test -- --run

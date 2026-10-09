# Your project

A Django REST Framework API on Python 3.12 with PostgreSQL (`backend/`), and a React frontend
built with Vite (`frontend/`), run with Docker Compose.

## Run it

```bash
docker compose --profile local up --build   # http://localhost:3000 (the API: http://localhost:8000)
```

Or without Docker (SQLite is used when `DATABASE_URL` isn't set):

```bash
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python manage.py migrate && python manage.py runserver 8000
cd frontend && npm install && npm run dev
```

## Before you push

```bash
ruff check backend                       # pip install ruff
cd backend && python manage.py test
```

## How your work is graded

Every push to `main` is tested automatically, and you can start a run from the course page. The
latest push before the deadline is the one graded. A run goes through these steps; each failure
tells you what was expected and what your app did:

1. **Project structure**: `backend/manage.py`, `frontend/package.json` and `compose.yaml` stay
   where they are.
2. **Build**: `docker compose build` must succeed.
3. **App starts**: `backend` answers `GET /health` on port **8000** and `frontend` answers `GET /`
   on port **3000**, within two minutes. The grader provides PostgreSQL and sets `DATABASE_URL`
   and `SECRET_KEY`; migrations run when the backend starts (the `db` service in `compose.yaml`
   is only for your computer).
4. **Lint** (`ruff check backend`) and **your own tests** (`python manage.py test`), if the
   assignment uses them. Your tests run without `DATABASE_URL`, on SQLite.
5. **Hidden tests**: API tests call your backend, and browser tests use your pages, with random
   data. Failures come with the request and response, or a screenshot and a trace of the browser.

The grader runs your app without internet access, so install everything in the Dockerfiles.
Settings that reach outside your containers (privileged mode, host networking, mounting folders
outside the repository, the Docker socket) are rejected.

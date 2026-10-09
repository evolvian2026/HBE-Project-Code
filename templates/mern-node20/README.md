# Your project

A MERN app: an Express API on Node.js 20 with MongoDB (`backend/`), and a React frontend built
with Vite (`frontend/`), run with Docker Compose.

## Run it

```bash
docker compose --profile local up --build   # http://localhost:3000 (the API: http://localhost:4000)
```

Or without Docker (you need MongoDB running locally):

```bash
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

## Before you push

```bash
npm run lint --prefix backend && npm run lint --prefix frontend
npm test --prefix backend   # node:test, also written to backend/junit.xml
```

## How your work is graded

Every push to `main` is tested automatically, and you can start a run from the course page. The
latest push before the deadline is the one graded. A run goes through these steps; each failure
tells you what was expected and what your app did:

1. **Project structure**: `backend/package.json`, `frontend/package.json` and `compose.yaml`
   stay where they are.
2. **Build**: `docker compose build` must succeed.
3. **App starts**: `backend` answers `GET /health` on port **4000** and `frontend` answers `GET /`
   on port **3000**, within two minutes. The grader provides MongoDB and sets `MONGODB_URI` and
   `JWT_SECRET` for the backend; read them from the environment (the `mongo` service in
   `compose.yaml` is only for your computer).
4. **Lint** and **your own tests** (if the assignment uses them).
5. **Hidden tests**: API tests call your backend, and browser tests use your pages, with random
   data. Failures come with the request and response, or a screenshot and a trace of the browser.

The grader runs your app without internet access, so install everything in the Dockerfiles.
Settings that reach outside your containers (privileged mode, host networking, mounting folders
outside the repository, the Docker socket) are rejected.

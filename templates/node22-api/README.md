# Your project

A Node.js 22 HTTP API, run with Docker Compose. Start in `src/app.js`.

## Run it

```bash
docker compose up --build        # http://localhost:4000/health
# or, without Docker:
npm install
npm run dev
```

## Before you push

```bash
npm run lint   # ESLint
npm test       # your tests (node:test), also written to junit.xml
```

## How your work is graded

Every push to `main` is tested automatically, and you can start a run from the course page. The
latest push before the deadline is the one graded. A run goes through these steps; each failure
tells you what was expected and what your app did:

1. **Project structure**: `package.json` and `compose.yaml` stay at the top of the repository.
2. **Build**: `docker compose build` must succeed.
3. **App starts**: the `backend` service listens on port **4000** and answers `GET /health` with
   a 2xx status within two minutes.
4. **Lint** and **your own tests** (if the assignment uses them): `npm run lint` and `npm test`
   must pass.
5. **Hidden tests**: they call your API over HTTP with random data, so make the behaviour right
   rather than matching particular values.

The grader runs your app without internet access, so install everything in the `Dockerfile`.
Settings that reach outside your containers (privileged mode, host networking, mounting folders
outside the repository, the Docker socket) are rejected.

# Your project

A Spring Boot 4 API on Java 21 with PostgreSQL (`backend/`), and a React frontend built with
Vite (`frontend/`), run with Docker Compose.

## Run it

```bash
docker compose --profile local up --build   # http://localhost:3000 (the API: http://localhost:8080)
```

Or without Docker (an in-memory H2 database is used when `DATABASE_URL` isn't set; you need
Java 21 and Maven):

```bash
cd backend && mvn spring-boot:run
cd frontend && npm install && npm run dev
```

## Before you push

```bash
cd backend && mvn checkstyle:check   # lint (rules in backend/checkstyle.xml)
cd backend && mvn test               # your tests; the coverage report is in target/site/jacoco
```

## How your work is graded

Every push to `main` is tested automatically, and you can start a run from the course page. The
latest push before the deadline is the one graded. A run goes through these steps; each failure
tells you what was expected and what your app did:

1. **Project structure**: `backend/pom.xml`, `frontend/package.json` and `compose.yaml` stay
   where they are.
2. **Build**: `docker compose build` must succeed.
3. **App starts**: `backend` answers `GET /health` on port **8080** and `frontend` answers `GET /`
   on port **3000**, within two minutes. The grader provides PostgreSQL and sets `DATABASE_URL`
   (`postgres://user:password@host:port/database`; `DatabaseConfig` turns it into a connection),
   and `schema.sql` runs when the backend starts (the `db` service in `compose.yaml` is only for
   your computer).
4. **Lint** (`mvn checkstyle:check`), **your own tests** (`mvn test`) and their **coverage**, if
   the assignment uses them. Your tests run without `DATABASE_URL`, on H2.
5. **Hidden tests**: API tests call your backend, and browser tests use your pages, with random
   data. Failures come with the request and response, or a screenshot and a trace of the browser.

The grader runs your app without internet access, so install everything in the Dockerfiles.
Settings that reach outside your containers (privileged mode, host networking, mounting folders
outside the repository, the Docker socket) are rejected.

# Your project

An ASP.NET Core minimal API on .NET 10 with PostgreSQL (`backend/`), and a React frontend built
with Vite (`frontend/`), run with Docker Compose.

## Run it

```bash
docker compose --profile local up --build   # http://localhost:3000 (the API: http://localhost:8080)
```

Or without Docker (notes are kept in memory when `DATABASE_URL` isn't set; you need the .NET 10
SDK):

```bash
cd backend && dotnet run --project Notes.Api --urls http://localhost:8080
cd frontend && npm install && npm run dev
```

## Before you push

```bash
cd backend && dotnet format --verify-no-changes   # lint (dotnet format fixes what it reports)
cd backend && dotnet test                         # your tests
```

## How your work is graded

Every push to `main` is tested automatically, and you can start a run from the course page. The
latest push before the deadline is the one graded. A run goes through these steps; each failure
tells you what was expected and what your app did:

1. **Project structure**: `backend/Notes.slnx`, `frontend/package.json` and `compose.yaml` stay
   where they are. Add projects to the solution; the commands below run on it.
2. **Build**: `docker compose build` must succeed.
3. **App starts**: `backend` answers `GET /health` on port **8080** and `frontend` answers `GET /`
   on port **3000**, within two minutes. The grader provides PostgreSQL and sets `DATABASE_URL`
   (`postgres://user:password@host:port/database`; `NotesStore` turns it into a connection),
   and the table is created on first use (the `db` service in `compose.yaml` is only for your
   computer).
4. **Lint** (`dotnet format --verify-no-changes`), **your own tests** (`dotnet test`) and their
   **coverage** (coverlet), if the assignment uses them. Your tests run without `DATABASE_URL`,
   with the in-memory store.
5. **Hidden tests**: API tests call your backend, and browser tests use your pages, with random
   data. Failures come with the request and response, or a screenshot and a trace of the browser.

The grader runs your app without internet access, so install everything in the Dockerfiles.
Settings that reach outside your containers (privileged mode, host networking, mounting folders
outside the repository, the Docker socket) are rejected.

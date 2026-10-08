# Grader

Builds a student's commit, runs the assignment's hidden tests against it, and reports the
results to the platform. It runs on GitHub Actions (later on self-hosted EC2 runners), never on
the platform's servers.

This folder is deployed as the separate **private** repository named in `GRADER_REPO` (for
example `hbe-platform/hbe-grader`): its contents become that repository's root. It lives here so
the harness, the platform and their tests change together.

```
.github/workflows/evaluate.yml   The workflow the platform dispatches for every test run
harness/run.mjs                  The harness (Node 22, no dependencies)
harness/lib/                     Compose sandboxing, process execution, platform callbacks
harness/runner/                  Runs inside the test container: health probes and suites
suites/<group>/<suite>/          Hidden test suites (suite.json + test files)
test-fixtures/                   Small apps used to test the harness (a correct and a buggy one)
test/                            Unit tests and Docker-backed harness tests
```

## How a run works

1. The platform's worker queues a run (on push, on a pull request, or on request) and dispatches
   `evaluate.yml` with the run id, the student repository and commit, the suite and the stack
   profile.
2. The workflow checks out the harness, the suite and the student's commit (with a read-only
   token for that one repository), then runs the harness.
3. The harness reports `started`, then runs the stages, then reports the results. Each callback
   authenticates with a fresh GitHub Actions OIDC token whose audience is the API; the API only
   accepts tokens from this repository's `evaluate.yml` on the configured branch, bound to one
   workflow run.

| Stage | What it checks | If it fails |
|-------|----------------|-------------|
| `contract` | The files the stack profile expects exist; `compose.yaml` is valid and doesn't reach outside its containers | Nothing else runs; score 0 |
| `lint` (optional) | The profile's lint command passes | Shown with the linter's output; worth the assignment's share of the score |
| `student_tests` (optional) | The student's own tests pass (the profile's test command) | Shown with the failing tests (from JUnit) and the output; worth its share |
| `build` | `docker compose build` succeeds | Nothing else runs; score 0 |
| `health` | The app starts and every service answers its health URL within 2 minutes | Tests don't run; score 0 |
| `api` (suite stages) | The hidden tests | Each failure lists what was expected, what the app did, a hint, the request and response, and the app's logs |
| `ui` (browser suite stages) | Hidden Playwright tests against the app's pages | Each failure names the step that failed, with a screenshot, a Playwright trace (no test sources), the browser console and the app's logs |

`lint` and `student_tests` run only when the assignment turns them on and the profile defines
them. Each runs in a fresh container of the stage's `image` on a Docker volume holding a copy of
the repository (not the suite, and no host mounts), with memory, CPU and process limits;
`setup` (installing dependencies, with internet access like the build) runs once per image and
setup command. Each counts as one test worth a share of the automated score (set per
assignment, at most 50% together); the hidden tests share the rest by weight. The assignment
can also turn off hidden-test stages by kind (`"kind": "api"` or `"browser"` in `suite.json`).
The worker passes these choices as `options` in the profile JSON:

```json
{ "options": { "stages": { "lint": { "share": 10 }, "student_tests": { "share": 20 } }, "skip_kinds": [] } }
```

When a stage fails because of the platform (Docker Hub rate limits, a full disk, a broken
suite), the results carry `infra_error` instead: the run is shown as a platform error and not
graded.

## Isolation

- The student's Compose project is rewritten before it runs: settings that reach the host
  (`privileged`, host networking or namespaces, extra capabilities, devices, the Docker socket,
  bind mounts outside the repository, build contexts or secrets outside the repository) are
  rejected with a message the student can act on.
- After the build, the app runs on an internal Docker network with **no internet access** and no
  published ports, with memory and process limits.
- The hidden tests run in a separate container on that network. The suite is never mounted into
  the student's containers.
- Child processes get a minimal environment, so a `compose.yaml` can't interpolate the runner's
  OIDC request token (or anything else) into a build or container. The harness removes those
  variables from its own environment at startup too.
- Tests use random data per run: students see full failure details, so answers can't be hard-coded.

## Writing a suite

A suite is a folder with `suite.json` and one test file per stage:

```json
{ "key": "todo-api", "version": 1, "title": "Todo API", "stack_profile": "node22-api",
  "stages": [{ "key": "api", "file": "api.test.mjs" }] }
```

```js
export default {
  tests: [
    {
      id: "todos.create",               // stable id: letters, digits, . _ - : /
      title: "Creates a todo",          // shown to students
      category: "Todos API",
      weight: 2,                        // share of the automated score
      hint: "POST /todos should answer 201 with the new todo.",  // shown when it fails
      staff_notes: "Common cause: …",   // course staff only
      async run(t) {
        const title = t.random.title();
        const res = await t.api.post("/todos", { title });
        t.expectStatus(res, 201);
        t.expect(res.json?.title === title, {
          message: "The created todo should have the title that was sent",
          expected: JSON.stringify(title),
          actual: JSON.stringify(res.json?.title),
        });
      },
    },
  ],
};
```

- `t.api` talks to the profile's `backend` service (or its only service); `t.service(name)` to
  any other. Each has `get`, `post`, `put`, `patch` and `delete`; responses have `status`,
  `headers`, `text` and `json`.
- `t.expectStatus(res, status)`, `t.expect(condition, { message, expected, actual })` and
  `t.fail(message)` fail the test with details for the student.
- `t.random` has `int()`, `word()`, `title()` and `email()`.
- Browser stages (`"kind": "browser"` in `suite.json`) get `t.page`, a fresh Playwright page whose
  base URL is the profile's `frontend` service (or its only service), and `t.step(name, fn)`,
  which names what the test is doing so a failure says which step went wrong. Playwright
  errors (an element that never appears, a page that doesn't load) fail the test. They run in
  `hbe-browser-tester:<version>` (`harness/browser/Dockerfile`: Playwright's image plus
  `playwright-core`), which the harness builds the first time it needs it. See
  `suites/sample/todo-web`.
- Tests are black-box (HTTP or the browser only) and must not depend on each other. Every test needs a title and
  a hint. Never put answers in `hint`; put staff-only advice in `staff_notes`.

Register a new suite version in the platform's `grader_suites` table (path and git ref of this
repository). Suites are immutable once used: change a suite by adding a new version.

## Running it yourself

Grade a folder without reporting anywhere:

```bash
node harness/run.mjs --run-id 00000000-0000-4000-8000-000000000001 \
  --submission test-fixtures/todo-api-buggy --suite suites/sample/todo-api \
  --profile '{"key":"node22-api","version":1,"detect":["package.json","compose.yaml"],"services":{"backend":{"port":4000,"health":"/health"}}}' \
  --no-callback --out results.json
```

Against a local platform (`GRADER_CALLBACK_AUTH=token`, `GITHUB_FAKE=true`): start a run in the
UI, and the worker logs the exact command for that run, including its one-time token. Replace
`<student-code-dir>` with a folder holding the code to grade.

Tests: `pnpm --filter @hbe/grader test` (unit) and `pnpm --filter @hbe/grader test:docker` (grades
the fixture apps with Docker; about 30 seconds).

## Not yet

Uploading logs, screenshots and traces to Storage is planned (docs/ROADMAP.md).

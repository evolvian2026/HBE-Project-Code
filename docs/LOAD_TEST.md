# Load test (Phase 2G)

`e2e/load/load-test.ts` checks the platform against REQUIREMENTS.md NFR-1 (about 100 students
active at once, bursts of pushes, 50+ runs queued at a deadline) and NFR-2 (p95 page load
under 2 s, p95 API under 300 ms, webhook acknowledged within 500 ms, visible within 30 s).

## Running it

Against the local stack (`pnpm db:start`, then the server with `ROLES=web,api,worker`):

```sh
pnpm --filter @hbe/e2e load
```

It reads `.env.local` for the Supabase URL and keys, creates its own institution, course,
published assignment and students (real Supabase Auth users with real sessions, each with a
repository, commits and a finished test run), and deletes all of it afterwards. Then:

1. **Browsing**: every student loads one of five pages (institution home, course, assignment,
   their submission, grades) with their session cookie, then calls `GET /v1/me`, then reads for
   a while. A page counts only if it rendered for that student (the institution's name is in
   it), not a sign-in redirect or an error.
2. **Pushes**: signed GitHub push webhooks, 20 at a time; the time to acknowledge, then the
   time from stored to processed.
3. **Deadline rush**: every student asks for a test run in the same instant.

| Variable                         | Default         | Meaning                                                    |
| -------------------------------- | --------------- | ---------------------------------------------------------- |
| `LOAD_STUDENTS`                  | 100             | Students active at once                                    |
| `LOAD_DURATION_S`                | 60              | How long they browse                                       |
| `LOAD_THINK_MS`                  | `5000-15000`    | Time on a page before the next (`1000-3000` is a stress)   |
| `LOAD_PUSHES`                    | 200             | Push webhooks sent                                         |
| `LOAD_BASE_URL` / `LOAD_API_URL` | `localhost:3000` | Web app and API                                           |
| `LOAD_WEBHOOK_SECRET`            | from env        | The server's `GITHUB_WEBHOOK_SECRET`                       |
| `LOAD_OUT`                       | none            | Also write the results as JSON to this file                |

It refuses a `supabase.co` or `onrender.com` address unless `LOAD_I_KNOW=yes` (a staging stack
only, never production: it creates and deletes users).

## Results (13 Oct 2026)

One machine with 4 vCPUs (Xeon 2.8 GHz) and 16 GB ran everything: the server (web, API and
worker in one process, free profile), the whole local Supabase stack (Postgres, PostgREST,
Auth, Realtime, Kong) and the load generator itself. The deployed platform has Supabase on its
own machines, so these figures are pessimistic.

### 100 students at a realistic pace (5–15 s per page), after the fixes below

| Measurement                   | p50 ms | p95 ms | Target            |
| ----------------------------- | -----: | -----: | ----------------- |
| Pages (five kinds)            |  64–90 | 113–177 | < 2,000 ✓        |
| `GET /v1/me`                  |      6 |     20 | < 300 ✓           |
| Webhook acknowledged          |     29 |     42 | < 500 ✓           |
| Webhook stored → processed    |  2,572 |  3,274 | visible < 30 s ✓  |
| 100 run requests at once      |    475 |    536 | see below         |

No errors. All 100 run requests were recorded and queued (none dropped); they dispatch as
runner capacity allows (`global_concurrency`). The 100 requests arrived in the same instant and
were all answered within 0.56 s; one alone takes about 27 ms, so their p95 is the wait behind
the others in that instant, not slowness. With the paid profile's database pools (10 + 5
connections) the figures were the same.

### 100 students at a stress pace (1–3 s per page)

About 45 requests a second, more than 100 real students make. Before and after the fixes:

| Measurement                | Before (p95)                         | After (p95)        |
| -------------------------- | ------------------------------------ | ------------------ |
| Pages                      | 5.7–9.4 s                            | 2.9–3.3 s          |
| Requests served in 60 s    | 937 page + 937 API                   | 1,352 + 1,352      |
| Webhook stored → processed | 112 s, and 80 of 200 not done in 2 min | 3.3 s, all done  |

At this pace the machine's 4 vCPUs are the limit (PostgREST, Postgres, the server and the load
generator share them); pages stay above 2 s. On the free tier (a 512 MB Render instance and
Supabase Free) plan for about 30 active students, as DEPLOYMENT.md says; 100 students at this
pace need the paid deployment (separate web, API and worker containers, Supabase Pro).

## What the load test found and fixed

- **Webhooks were processed one per worker every 2 seconds.** pg-boss waits out its polling
  interval after every fetch, even one that found a job, so a burst of 200 pushes took minutes.
  The worker now fetches again at once after a job (`packages/queue`); an empty queue still
  waits. Tested in `queue.test.ts`.
- **Row-level security on submissions ran ~200 small queries per page.** The policies of
  `submissions`, `evaluation_runs`, `test_results`, `run_artifacts` and
  `submission_snapshots` called security-definer functions once per row. They now compute the
  caller's staff courses and teammates' submissions once per statement, and runs, results,
  files and snapshots follow their submission's (or run's) policy
  (`20261108000001_rls_performance.sql`). The slowest query went from 127 ms to 7 ms. Who sees
  what is unchanged: `028-submission-visibility.test.sql` passes against the old and the new
  policies, and all other pgTAP tests pass.

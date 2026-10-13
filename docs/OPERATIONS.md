# Operations: logs, metrics, errors and alerts

How to see what the platform is doing once it is deployed (DEPLOYMENT.md), and what to alert
on. The platform console's **System health** page shows the same queue, run and webhook figures
to the operator without any of this set up.

## Logs

- Every process writes JSON lines (pino) to stdout; Render and CloudWatch keep them.
- Each request has a `request_id`. The web app gives every page request one and sends it with
  the API calls made for that page, so one page's requests can be found together; the API
  accepts a well-formed `X-Request-Id` from a proxy, makes one up otherwise, and sends it back
  as `X-Request-Id`.
- Failed background jobs are logged as `job failed` with the queue (`job`), the job id and how
  long it ran; pg-boss then retries them as configured.
- Never in logs: the `Authorization` and `Cookie` headers, webhook signatures, and secrets in
  query strings (`code`, `state`, `invite`, `registration_token`, `token`, `id_token`, …).
  Request logs show the method, the path, the host and the client address.

## Metrics

Set `METRICS_TOKEN` (at least 24 characters, e.g. `openssl rand -hex 32`) and scrape
`GET /metrics` on each process with `Authorization: Bearer <token>`. Without the token the
endpoint doesn't exist. Grafana Cloud's free tier or any Prometheus can scrape it.

| Metric                                         | What it is                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `hbe_http_requests_total{method,route,status}` | Requests answered, by route template (`/v1/institutions/:institutionId`) |
| `hbe_http_request_duration_seconds{…}`         | Histogram; bucket edges at the NFR-2 targets (0.3 s, 0.5 s)              |
| `hbe_jobs_total{queue,outcome}`                | Background jobs this process ran, completed or failed                    |
| `hbe_job_duration_seconds_total{queue}`        | Time spent in background jobs                                            |
| `hbe_queue_jobs{queue,state}`                  | Jobs queued, active, retrying, and failed in the last 24 hours           |
| `hbe_runs{state}`                              | Test runs queued, and dispatched or running                              |
| `hbe_runs_concurrency_limit`                   | How many runs may use runners at once                                    |
| `hbe_webhooks_unprocessed`                     | GitHub deliveries stored but not processed                               |
| `hbe_webhooks_oldest_unprocessed_seconds`      | Age of the oldest of them                                                |
| `hbe_runner_minutes_used` / `_budget`          | Runner minutes this month, and the budget                                |
| `hbe_event_loop_delay_p99_seconds`             | Event loop delay since the last scrape (a busy or blocked process)       |
| `hbe_process_resident_memory_bytes`            | Memory of the process                                                    |

HTTP and job figures are per process; queue, run and webhook figures are the platform's (the
same from every process, so use `max` across processes).

## Errors

Set `SENTRY_DSN` to send unexpected errors to Sentry: API errors answered with
`internal_error`, failed background jobs and unhandled promise rejections, tagged with the
request id, route or queue. Only the error and its stack are sent, never request headers,
cookies, bodies or query strings, and no breadcrumbs (PDPA). Without the DSN, errors are only
logged.

## Health checks

- `/healthz`: the process is up (Render's health check and the keep-awake job use it).
- `/readyz`: the database is reachable (`503` otherwise).
- An external uptime check (e.g. UptimeRobot, Better Stack) on `https://api.example.com/healthz`
  and `https://app.example.com/login`.

## Alerts

Suggested rules (PromQL). The thresholds follow REQUIREMENTS.md NFR-1 (scale) and NFR-2
(latency); adjust them
after the first weeks of real traffic.

| Alert                     | Rule                                                                                                                                                                                    | Why                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| API slow                  | `histogram_quantile(0.95, sum by (le) (rate(hbe_http_request_duration_seconds_bucket{route=~"/v1/.*"}[10m]))) > 0.3` for 15m                                                            | NFR-2: p95 under 300 ms                     |
| API errors                | `sum(rate(hbe_http_requests_total{status="5xx"}[5m])) / sum(rate(hbe_http_requests_total[5m])) > 0.02` for 10m                                                                          | More than 2% of requests failing            |
| Webhook backlog           | `max(hbe_webhooks_oldest_unprocessed_seconds) > 600`                                                                                                                                    | Pushes not being processed (worker down?)   |
| Webhook acknowledgement   | `histogram_quantile(0.95, sum by (le) (rate(hbe_http_request_duration_seconds_bucket{route="/webhooks/github"}[10m]))) > 0.5`                                                           | NFR-2: acknowledged within 500 ms           |
| Runs piling up            | `max(hbe_runs{state="queued"}) > 50` for 30m                                                                                                                                            | NFR-1: 50 queued runs drain; runners stuck? |
| Jobs failing              | `sum by (queue) (increase(hbe_jobs_total{outcome="failed"}[1h])) > 5`                                                                                                                   | A job keeps failing (see Sentry and logs)   |
| Runner budget             | `max(hbe_runner_minutes_used) / max(hbe_runner_minutes_budget) > 0.8`                                                                                                                   | 80% of the month's runner minutes used      |
| Process stalled           | `max(hbe_event_loop_delay_p99_seconds) > 0.5` for 10m                                                                                                                                   | Something blocks the event loop             |
| Down                      | uptime check fails twice in a row                                                                                                                                                       | Site or API unreachable                     |

Supabase's own dashboard covers the database (connections, CPU, disk) and Auth; alert there on
connection saturation and disk usage. GitHub Actions minutes for the grader account are watched
by the runner budget alert and by GitHub's spending limit.

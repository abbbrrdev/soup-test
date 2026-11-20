# Mini Experiment Tracker

A small experiment tracker: projects with API keys, runs, batched metric ingestion, and a live-updating
run page. Built for the Soup take-home task — see `docs/design.md` for the design written before any
code, and `docs/submission-note.md` for the consistency/isolation evidence and SHIP/DON'T SHIP verdict.

## Stack

- **Backend**: Go (stdlib `net/http` + `chi` router + `pgx`), no framework magic.
- **Database**: PostgreSQL. Migrations in `backend/migrations/`, applied automatically on first boot via
  Postgres's own `docker-entrypoint-initdb.d`.
- **Frontend**: React + TypeScript + Vite, served by nginx in production.
- **Live updates**: Server-Sent Events over `fetch()` streaming (not `EventSource`, so an `Authorization`
  header can be sent — see design.md).
- **No cache layer.** There is no Redis/CDN/application cache anywhere in this system — a deliberate
  scope decision (see "Known limitations"). What's checked instead is that **nothing accidentally gets
  cached**: every protected API response sets `Cache-Control: no-store` (verified in
  `tests/isolation/isolation.test.mjs`).

## Quick start

```bash
cp .env.example .env   # optional — defaults work out of the box
docker compose up --build
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8080 (`/healthz`, `/readyz`)
- Postgres: localhost:5432 (user/pass/db: `tracker`/`tracker`/`tracker`)

First boot creates the schema and seeds two **local demo projects** automatically (see below). No manual
migration step is needed.

## Demo API keys (local only)

`backend/migrations/0002_seed_demo.sql` seeds two projects with fixed, publicly-known keys purely so you
have something to use immediately. They are clearly local-only — never do this in anything but a
throwaway dev database.

| Project               | API key                              |
|------------------------|---------------------------------------|
| Demo Project A (local) | `sk_demo_project_a_local_only_0000`  |
| Demo Project B (local) | `sk_demo_project_b_local_only_0000`  |

Paste either key into the "Connect with an existing API key" box on http://localhost:5173, or create your
own project from the same page (a project is just the isolation boundary — each one gets its own key).

## Demo scenario

1. Connect with the Project A demo key.
2. Create a run.
3. Open the run page, click **Start demo generator** — it posts a `loss`/`accuracy` batch once a second
   with an incrementing `step`, each with a fresh `batch_id`.
4. Watch the chart and table update live; the connection badge shows `Connected`.
5. Reload the page mid-stream — the client reconnects and replays from the exact point it left off
   (`Last-Event-ID`), with no gaps and no duplicates.
6. Connect a second browser (or incognito window) with the Project B demo key — it cannot see Project A's
   runs at all.

Or drive it from the API directly:

```bash
KEY=sk_demo_project_a_local_only_0000
RUN=$(curl -s -X POST localhost:8080/runs -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"name":"cli-demo"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST localhost:8080/runs/$RUN/metrics -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"batch_id":"'$(python3 -c 'import uuid;print(uuid.uuid4())')'","metrics":[{"name":"loss","step":1,"value":0.9}]}'
curl -N localhost:8080/runs/$RUN/stream -H "Authorization: Bearer $KEY"
```

## Running the tests

Everything below assumes `docker compose up` is already running (backend on :8080, Postgres on :5432,
frontend on :5173).

```bash
# Go unit tests (in-memory SSE hub: overflow eviction, per-run isolation)
cd backend && go test ./... -v

# Isolation + silent-failure checks (Node's built-in test runner, no browser)
cd tests/isolation && npm install && npm test

# E2E consistency test + a documented Playwright-offline-emulation finding (Playwright + Chromium)
cd tests/e2e && npm install && npx playwright install chromium && npm test

# Load test: 50 concurrent runs x 10 events/s
cd tests/load && go run . -runs 50 -rate 10 -duration 30s
```

Raw output from the last run of each of these is saved under `docs/test-logs/`.

## Architecture, briefly

- **Idempotent ingest**: `batch_id` is a client-supplied UUID, unique per run. A `batches` table with a
  `(run_id, batch_id)` primary key plus a content hash makes retries safe: same id + same content →
  no-op success; same id + different content → `409`, nothing written. One transaction per batch; metric
  rows and the batch row commit together or not at all.
- **Ordering**: delivery order (the SSE resumption cursor, `metrics.id`) is kept strictly separate from
  display order (`name, step, ts, id`). The UI always re-sorts by display order, so a late metric inserts
  at the right spot instead of appending at the end. See design.md for the "commit-order gap hazard" and
  why writes are serialized per run with a Postgres advisory lock.
- **Reconnect**: the SSE handler subscribes to an in-memory per-run broadcaster *before* running its
  catch-up query, so nothing committed during that query window is missed or double-delivered. The
  broadcaster is a latency optimization only — Postgres is the only durable source of truth, and a
  backend restart loses no data.
- **Isolation**: every data query is scoped `WHERE project_id = $ctx AND id = $resource` in one query, so
  a cross-project resource and a nonexistent one return an identical `404`. API keys are stored as SHA-256
  hashes only; rotation deactivates the old key immediately for new requests and force-closes any
  already-open stream within one heartbeat tick (~3s).

Full reasoning: `docs/design.md`. Evidence and a SHIP/DON'T SHIP verdict for 50×10 events/s:
`docs/submission-note.md`. Русское пошаговое объяснение: `docs/walkthrough-ru.md`.

## Known limitations

- **Single backend instance.** The live-delivery hub is in-process memory; running more than one backend
  replica would need each client pinned to one instance (sticky routing) or a shared pub/sub (e.g.
  Postgres `LISTEN/NOTIFY`, not implemented). Not needed at the target load; flagged as the first thing to
  change before scaling out.
- **No cache layer**, by design (see Stack above) — this is a scope decision, not an oversight.
- **No full user accounts.** Authorization is per-project API key, not per-human-user login. Creating a
  project is intentionally unauthenticated (there's no signup flow in scope) — see design.md.
- **MetricsTable** renders only the latest 50 rows for readability; the chart and the consistency
  comparisons use the full set.
- Frontend production bundle is a single ~570KB chunk (no code-splitting) — fine at this size, called out
  by Vite's own build warning, not addressed since it's cosmetic at this scale.
- Playwright's `context.setOffline()` does not interrupt an already-open SSE stream in Chromium (confirmed
  in `tests/e2e/debug-offline.spec.ts`); the consistency test instead disconnects by navigating the tab
  away and back. The `Last-Event-ID` partial-catch-up path is proven separately and more precisely at the
  protocol level in `tests/isolation/failures.test.mjs`.

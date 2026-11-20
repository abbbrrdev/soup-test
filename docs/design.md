# Design — Mini Experiment Tracker

Written before implementation. One page, as required by the task.

## Entities

- **Project** — tenant boundary. `id (uuid)`, `name`.
- **ApiKey** — `id (uuid)`, `project_id`, `key_hash (sha256, unique)`, `key_prefix` (first 8 chars, for display only), `is_active`, `created_at`, `revoked_at`. A key is never stored or logged in plaintext after creation; only the hash is persisted.
- **Run** — `id (uuid)`, `project_id`, `name`, `status`, `created_at`.
- **Batch** — one ingest attempt. `id (uuid, client-supplied)`, `run_id`, `content_hash (sha256 of canonicalized metrics)`, `metric_count`, `received_at`. `UNIQUE(run_id, id)`.
- **Metric** — one data point. `id (bigserial — server delivery cursor)`, `run_id`, `batch_id`, `seq_in_batch`, `name`, `step (bigint, required)`, `ts (timestamptz, defaults to received_at)`, `value (double precision)`. `UNIQUE(run_id, batch_id, seq_in_batch)`.

## Event format (POST /runs/{id}/metrics)

```json
{ "batch_id": "uuid-v4", "metrics": [
  { "name": "loss", "step": 10, "value": 0.432, "ts": "2026-11-19T10:00:00Z" }
]}
```
`batch_id` is generated client-side and **reused on retry** of the same logical send. `step` is required (monotonic counter the client controls, e.g. training step); `ts` is optional, defaults to server receive time. Max 500 metrics/batch, max body 256KB.

## Delivery cursor vs. display order (key invariant)

Two orderings are deliberately separate:

- **Delivery cursor** = `metrics.id` (bigserial). Used only for SSE resumption (`Last-Event-ID` / `?after_id=`) — "have I seen this row yet". It carries no semantic meaning about experiment progress.
- **Display order** = `ORDER BY name, step, ts, id`. The UI never trusts arrival order; every render (initial snapshot, live append, reconnect backfill) re-sorts the full known set by this tuple. A metric that arrives late with `step=5` after one with `step=20` is already on screen is inserted at the correct position, not appended at the end. `id` is the final tiebreak so equal `(name, step, ts)` is still deterministic.

**Commit-order gap hazard**: a bigserial `id` can be *allocated* to transaction A before transaction B, while B *commits* first. A client polling "id > last_seen" between those two commits would record B's id as the watermark and then permanently miss A's row once it finally commits. Fix: all metric-batch inserts for a given run take `pg_advisory_xact_lock(hashtext(run_id))` before insert, serializing writes **per run**. This makes commit order match id-allocation order within a run, so "id > watermark" is a safe, gap-free cursor. Trade-off: writes to the *same* run are serialized (fine — target load is 10 events/s per run, not concurrent writers to one run); writes across different runs are fully parallel.

## Resending the same batch

Within one transaction: `INSERT INTO batches(id, run_id, content_hash) ... ON CONFLICT (run_id, id) DO NOTHING`, then check:
- **No conflict** (first time) → insert all metric rows, commit, `201`.
- **Conflict, same `content_hash`** → genuine retry after a dropped response. No new rows written, return `200` with the original count (idempotent, visible to the client as success either way).
- **Conflict, different `content_hash`** → the client reused a `batch_id` with different content. Reject the whole batch, `409 Conflict`, no partial write. A batch_id names one immutable payload, not a mutable slot.
- **Concurrent identical sends** (two in-flight requests, same batch_id) → the unique constraint on `batches(run_id, id)` makes one `INSERT` win and the other hit a unique-violation; the loser re-checks `content_hash` under the same rule above instead of erroring. Net effect: concurrent retries converge on one outcome, never double-counted metrics.
- Invalid batch (bad metric, oversized, non-numeric value) → validated before any insert; transaction is never opened for a batch that fails validation, so partial writes are impossible by construction.

## Reconnect / replay (SSE)

Client connects to `GET /runs/{id}/stream` via `fetch()` with streaming body (not `EventSource`, so an `Authorization` header can be sent). Server, per connection:
1. Subscribe to the in-memory per-run broadcaster **first** (buffered channel), before touching the DB.
2. Query `SELECT ... WHERE run_id=$1 AND id > $after_id ORDER BY id` and stream those rows as the backfill/snapshot.
3. Drain anything the broadcaster buffered during step 2, filtering `id <= last_sent_id` (dedup against what step 2 already sent).
4. Switch to forwarding live broadcaster events.

This subscribe-before-query ordering closes the snapshot/subscribe race: any metric committed during the catch-up query is either included in the query result or captured in the buffer — never both, never neither. The in-memory broadcaster is a latency optimization only; it is never the sole source of an event; the DB table is. After a backend restart, all broadcaster state is gone but every committed metric is still fetchable because `after_id` replay always re-reads Postgres, not memory.

Each SSE frame carries `id: <metrics.id>`. On reconnect, the client resends `Last-Event-ID` (and `?after_id=` as a fallback the server also honors), so no missed event is dropped and already-seen ids aren't redelivered.

## Slow client

Each subscriber has a bounded channel (256 events). If the broadcaster can't push because the channel is full, the server does **not** block or grow memory — it closes that subscriber's connection immediately with a final `event: overflow` frame. The client's reconnect logic then replays via `after_id` from Postgres (durable), so the client eventually sees everything, just later — never silently missing it.

## Project isolation

Every request carries `Authorization: Bearer <key>`. Middleware hashes the key and looks up `api_keys WHERE key_hash=$1 AND is_active`, attaching `project_id` to the request context. Every data query is scoped `WHERE project_id=$ctx AND id=$resource` in a single query — a run that exists but belongs to another project returns the same `404` as a run that doesn't exist at all, so existence is never leaked. SSE auth is checked the same way at connect time, plus re-checked every 3s heartbeat tick so a key revoked mid-stream closes the connection within one heartbeat interval instead of living until natural disconnect. All API responses set `Cache-Control: no-store` to prevent any shared/browser cache from serving one project's response to another's request pattern.

**Key rotation**: rotating inserts a new `api_keys` row and sets `is_active=false` on the old one (never deletes, for audit). New requests with the old key are rejected the instant `is_active` flips. An SSE stream already open on the old key is force-closed at its next heartbeat check (≤3s window), then must reconnect with the new key.

## Transaction boundaries

Exactly one transaction per batch POST: validate in Go (no DB calls) → open tx → advisory lock → insert batch row → insert metric rows → commit. Reads (run list, run detail, metrics snapshot, SSE backfill) are single `SELECT`s, no explicit transaction needed (Postgres read committed is sufficient since nothing cross-row is being invariant-checked on read).

# Submission note

Design rationale lives in `docs/design.md` (written before implementation, referenced throughout —
not duplicated here). This note is evidence and a verdict.

## Key decisions

- **Idempotency via a `batches` table, not an in-memory cache.** `(run_id, batch_id)` is a real primary
  key; a content hash distinguishes "retry of the same batch" (no-op) from "batch_id reused for different
  content" (`409`, reject whole). Survives restarts and concurrent requests by construction, not by luck.
- **Delivery cursor ≠ display order.** `metrics.id` (bigserial) only means "have I seen this row," used
  for SSE resumption. What's rendered is always `ORDER BY name, step, ts, id`, recomputed from the full
  known set on every update — so a late metric lands in the right spot, never appended at the end.
- **Per-run advisory lock on write.** Closes a real race: a bigserial id can be *allocated* to a slower
  transaction before a faster one *commits*, which would let an "id > watermark" cursor silently skip a
  row. Serializing writes per run (not globally) makes commit order match id order, at the cost of
  capping per-run write concurrency — irrelevant at 10 events/s/run.
- **Subscribe-before-query on stream connect.** Closes the snapshot/live race from the other direction:
  anything committed while the catch-up query runs is either in the query result or buffered by the
  subscription made just before it started — never both, never neither.

## Consistency — proven

`tests/e2e/consistency.spec.ts` (Playwright, browser + real Postgres read): posts metrics out of order,
duplicates a batch, disconnects the client (tab navigated away — see note below), posts more metrics while
it's gone, reconnects, posts a late metric, then compares the **rendered DOM** against a **direct `pg`
query**, not a second API call. Result: `1 passed` (`docs/test-logs/e2e-consistency.log`). Final UI and DB
agreed on all 6 metrics — names, steps, and values, not just counts.

**What this test does NOT catch**: two independent tabs racing on the same run; a backend crash mid-batch
(a *started-but-never-committed* transaction — covered differently below, via atomicity, not via a crash
test harness we didn't build); clock skew between client-supplied `ts` and server `received_at`.

**Method note**: `context.setOffline()` turned out not to interrupt an already-open `fetch()` stream in
this Chromium build — confirmed empirically in `tests/e2e/debug-offline.spec.ts` (heartbeats kept flowing
straight through 15s of "offline"). This matches Playwright's own documented behavior (offline only
affects requests not yet in flight) — not a bug in our code, a property of the test tool. We switched the
E2E disconnect to a real tab navigation, and proved the `Last-Event-ID` *partial* catch-up path (non-zero
watermark, the harder case) separately and more precisely at the protocol level in
`tests/isolation/failures.test.mjs`, using Node's real connection abort.

## Isolation — proven

`tests/isolation/isolation.test.mjs`, 10 tests, all passing (`docs/test-logs/isolation.log`): project A
cannot read, write to, list, or subscribe to project B's run; a syntactically-valid guessed/random run id
gets byte-identical `404` to a real cross-project id (no existence oracle); every protected response sets
`Cache-Control: no-store`; an old key is rejected instantly on read/write/stream after rotation; a stream
opened *before* rotation is force-closed within ~3s (one heartbeat tick), not left open indefinitely.

**What's checked**: API-level read/write/list/subscribe/guess/cache/rotation. **What's not independently
checked**: timing side-channels (whether a 404-for-nonexistent and 404-for-cross-project differ in
response latency enough to be distinguishable) — plausible risk, not measured; application logs were
manually spot-checked to confirm no key or key-hash is ever logged, not covered by an automated assertion.

## Silent failures — checked, not assumed

| Failure | Check | Result |
|---|---|---|
| Events lost on reconnect | `failures.test.mjs`: abort connection, send 3 metrics while gone, reconnect with `Last-Event-ID`, assert exactly those 3, in order | pass |
| Duplicate batch | `failures.test.mjs` + E2E: resend identical batch, assert `200 duplicate`, DB row count unchanged | pass |
| Concurrent identical retries | 10 concurrent identical POSTs → exactly 1 `accepted`, 9 `duplicate`, exactly 1 DB row | pass |
| Concurrent same-id different-content | 2 concurrent conflicting POSTs → one `201`, one `409`, exactly 1 DB row | pass |
| Late events | E2E: step=0 posted after steps 1-5 already rendered → UI re-sorts correctly | pass |
| Slow-client queue overflow | Go unit test on the hub directly (not real TCP, see below): 257th event on a full 256-buffer subscriber evicts it, closes the channel, never blocks or grows unbounded | pass |
| Partial write | Batch with one invalid metric among valid ones → `400`, zero rows written | pass |
| Old key after rotation | `isolation.test.mjs`: old key rejected on read/write/stream; open stream force-closed ≤3s | pass |

Full raw output: `docs/test-logs/go-unit-tests.log`, `docs/test-logs/silent-failures.log`.

**Method note on overflow**: tested as a Go unit test against the hub directly, not by racing real TCP
backpressure from an external client. Real OS/TCP buffers are large enough (tens to hundreds of KB) that
reliably forcing backpressure from outside would need thousands of events and would be flaky on CI
hardware; the eviction logic itself is a pure, deterministic property of the hub and is exactly what's
under test. Not independently re-verified via an actual stalled HTTP client.

## Load — 50 runs × 10 events/s

`tests/load/main.go`, `docs/test-logs/load-test.log`. Event = one metric in one single-metric batch.
Duration: 30s. Batch size: 1. Live clients: 50 (one SSE subscriber per run). Environment: single laptop,
Docker Desktop, 8 CPUs / 7.75GiB allocated to the VM, Postgres + backend + 50 load-test clients all
co-located.

- Sent: 14,906 requests, **0 failures**. Achieved **496.7 events/s** (target 500).
- Latency: p50 18.4ms, p95 35.3ms, p99 86.0ms, max 280ms (this run shared the machine with the
  Playwright/Node test suites that had just finished — the p99/max tail is noticeably worse than an
  isolated run's 38.5ms/59.6ms p99/max; load-test numbers on a busy dev laptop should be read as
  directional, not a clean benchmark).
- Live delivery: 14,906 delivered across 50 subscribers = accepted count, exactly.
- DB: 14,906 rows stored = accepted count, exactly (independent `pg` query, not the API).

**Limitations of this test**: single-machine, loopback network (no real latency/packet loss), one backend
instance, one Postgres instance with default config, no concurrent writers to the *same* run (10
events/s/run is well under where the per-run advisory lock would start to bite), run once, not sustained
over hours, no concurrent read/list traffic mixed in.

## Verdict: **SHIP** for 50 concurrent runs at 10 events/s

Zero errors, latency comfortably low (p99 under 40ms), and all three independent views (API-accepted,
live-delivered, DB-stored) agree exactly. What to change first before trusting this further: (1) run the
load test against a non-loopback network and a separate DB host to see real latency, not a best case; (2)
add a second backend instance test to validate the documented single-instance limitation before any
horizontal scaling is attempted; (3) extend duration from 30s to something like 30 minutes to catch
connection-pool exhaustion or memory growth that a short run can't show.

## What surprised me and what still concerns me

What surprised me: `context.setOffline()` not touching an already-open stream — I expected Playwright's
network emulation to be a hard kill switch and had to go verify it empirically instead of trusting the
API name. It's a good reminder that a test tool's label ("offline") is not its actual behavior, and that
testing the *harder* reconnect case (non-zero `Last-Event-ID`) ended up needing a lower-level tool (raw
Node fetch with a real abort) than the higher-level one (Playwright) I reached for first. What still
concerns me: the overflow/slow-client path is proven at the unit level but not under real backpressure,
and the single in-memory hub means a backend crash doesn't just lose live-delivery (acceptable, replay
covers it) but also means every connected client reconnects simultaneously — I haven't measured whether a
thundering-herd of reconnects after a backend restart could itself cause a secondary load spike worth
protecting against before this goes near production traffic.

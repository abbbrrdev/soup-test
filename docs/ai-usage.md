# AI usage

Full transparency, as requested by the task: this entire submission — design, backend, frontend, all four
test suites, the load generator, debugging, and documentation — was produced by Claude Code (an AI coding
agent) in one session, working from the task PDF and acting on explicit instructions to make reasonable
engineering decisions independently and carry the work to a finished, verifiable state. The person
submitting this did not separately write or hand-review each file before this note was generated.
Said plainly, per the task's own request not to overstate human involvement: **no manual code review or
manual testing by a human has happened yet** — see "What you still need to verify" below.

## Where AI was used

Everywhere: reading the PDF and extracting requirements, writing `docs/design.md` before any code existed,
all Go backend code (schema, auth, ingest idempotency, SSE hub and handler), all frontend code (React
components, SSE client with reconnect/watchdog logic, API client), `docker-compose.yml` and both
Dockerfiles, all test code (Playwright E2E, Node isolation/failure tests, Go unit tests, the Go load
generator), and this documentation set.

## What was verified by actually running it (not just generated)

Every claim of "passes" or "works" in `docs/submission-note.md` corresponds to a command that was actually
executed against a real `docker compose up` stack, with raw output saved under `docs/test-logs/`:
`go build`/`go vet`/`go test`, `npx tsc --noEmit`, `npx vite build`, `docker compose build && up`, manual
`curl` smoke tests of auth/idempotency/isolation/rotation/SSE before writing the automated suites, the full
Playwright suite, the Node isolation+failure suite, and the load test. Nothing in the test-logs directory
is fabricated or hand-edited after the fact.

## Mistakes the AI made and caught by running things, not by inspection

- A load-test bug: `time.After(duration)` was shared across N goroutines as the stop signal, but a
  `time.After` channel only ever delivers once — only one of N sender goroutines would ever see it, so the
  test hung instead of stopping. Found by actually running it (it hung) and fixing it to a shared
  `context.WithTimeout`, whose `Done()` channel closes and broadcasts to every reader. Would not have been
  caught by reading the code carefully; the bug only manifests with more than one concurrent reader of the
  same channel.
- A Go unit test for the SSE hub's overflow eviction was first written with a logic error (reading one
  event out of the channel before "filling to capacity," which quietly left room and made the overflow
  condition never trigger) — it deadlocked. Fixed after running it and seeing the hang, not by re-reading
  the code and spotting the off-by-one.
- Assumed `context.setOffline()` in Playwright would interrupt an already-open SSE stream; it doesn't
  (documented Playwright behavior, confirmed empirically with a small debug test that logs stream chunks
  with timestamps across the offline window). The E2E test's disconnect mechanism was changed as a result.
- A type mismatch: `pg` (node-postgres) returns `bigint` columns as strings by default, which initially
  failed a strict `toEqual` comparison between UI-rendered steps (numbers) and DB-read steps (strings) in
  the consistency test. Caught by the test actually failing with a clear diff, fixed with an explicit
  `Number()` cast.

## What was NOT done

No separate "AI proposes, human reviews and edits" loop happened — this was a single agent executing the
whole task end to end in one sitting, per the instructions given to it. There was no second AI tool or
model consulted for a second opinion on any design decision.

## What you (the candidate) still need to verify before submitting this as your own work

- Read the actual code, not just this summary — in particular `backend/internal/api/metrics.go` (the
  idempotency transaction) and `backend/internal/api/stream.go` (the subscribe-before-query ordering),
  since those are the two places correctness most depends on.
- Run `docker compose up` yourself on your machine and click through the demo scenario in a real browser —
  this was tested from this environment only.
- Be ready to defend every tradeoff in `docs/design.md` in your own words — the live discussion in the
  original task was cancelled per the follow-up email, but the scoring rubric (consistency/isolation 30%,
  silent failures 20%, architecture 15%, live discussion 35%) suggests the reviewers may still probe your
  understanding by email or in a future round, and you should be able to explain *why* each decision was
  made, not just that it was made.
- Decide for yourself whether you agree with the SHIP verdict in `docs/submission-note.md` — it's an
  honest read of the evidence gathered, not a claim that should be taken on authority.
- Double-check nothing in this repo should stay private before it's sent anywhere (it shouldn't contain
  secrets — the demo keys are intentionally fake/local-only — but verify that yourself before emailing it).

// Silent-failure checks that aren't already covered by consistency.spec.ts
// (out-of-order/duplicate/late/disconnect) or isolation.test.mjs (stale key).
// Slow-client queue overflow is covered separately as a Go unit test
// (backend/internal/sse/hub_test.go) since it's a deterministic property of
// the in-memory hub, not something worth racing real TCP backpressure for.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";

const API_URL = process.env.API_URL ?? "http://localhost:8080";
const DB_URL = process.env.DATABASE_URL ?? "postgres://tracker:tracker@localhost:5432/tracker";

async function api(path, { apiKey, ...opts } = {}) {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  return fetch(`${API_URL}${path}`, { ...opts, headers });
}

async function createProject(name) {
  const res = await api("/projects", { method: "POST", body: JSON.stringify({ name }) });
  assert.equal(res.status, 201);
  return res.json();
}

async function createRun(apiKey, name) {
  const res = await api("/runs", { method: "POST", apiKey, body: JSON.stringify({ name }) });
  assert.equal(res.status, 201);
  return res.json();
}

async function dbCounts(runId) {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const metrics = await client.query("SELECT count(*)::int AS n FROM metrics WHERE run_id = $1", [runId]);
    const batches = await client.query("SELECT count(*)::int AS n FROM batches WHERE run_id = $1", [runId]);
    return { metrics: metrics.rows[0].n, batches: batches.rows[0].n };
  } finally {
    await client.end();
  }
}

function parseSSEBlocks(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      let id;
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("id: ")) id = Number(line.slice(4));
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      return { event, id, data: dataLines.join("\n") };
    });
}

let proj, run;

before(async () => {
  proj = await createProject(`failures-${Date.now()}`);
  run = await createRun(proj.api_key.key, "failures-run");
});

describe("partial write", () => {
  test("a batch with one invalid metric writes nothing at all", async () => {
    const before = await dbCounts(run.id);
    const res = await api(`/runs/${run.id}/metrics`, {
      method: "POST",
      apiKey: proj.api_key.key,
      body: JSON.stringify({
        batch_id: crypto.randomUUID(),
        metrics: [
          { name: "ok_metric", step: 1, value: 1.0 },
          { name: "bad metric name with spaces", step: 1, value: 1.0 }, // violates name regex
        ],
      }),
    });
    assert.equal(res.status, 400);
    const after = await dbCounts(run.id);
    assert.deepEqual(after, before, "an invalid batch must not insert the valid metrics either");
  });

  test("a batch exceeding the size limit is rejected entirely", async () => {
    const before = await dbCounts(run.id);
    const metrics = Array.from({ length: 501 }, (_, i) => ({ name: "m", step: i, value: i }));
    const res = await api(`/runs/${run.id}/metrics`, {
      method: "POST",
      apiKey: proj.api_key.key,
      body: JSON.stringify({ batch_id: crypto.randomUUID(), metrics }),
    });
    assert.equal(res.status, 400);
    const after = await dbCounts(run.id);
    assert.deepEqual(after, before);
  });
});

describe("concurrent identical retries", () => {
  test("10 concurrent POSTs with the same batch_id+content converge on exactly one accepted write", async () => {
    const batchId = crypto.randomUUID();
    const body = JSON.stringify({
      batch_id: batchId,
      metrics: [{ name: "race", step: 1, value: 7.0 }],
    });
    const before = await dbCounts(run.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api(`/runs/${run.id}/metrics`, { method: "POST", apiKey: proj.api_key.key, body }),
      ),
    );
    const bodies = await Promise.all(results.map((r) => r.json()));

    const accepted = bodies.filter((b) => b.status === "accepted");
    const duplicate = bodies.filter((b) => b.status === "duplicate");
    assert.equal(accepted.length, 1, `expected exactly 1 accepted, got ${JSON.stringify(bodies)}`);
    assert.equal(duplicate.length, 9);

    const after = await dbCounts(run.id);
    assert.equal(after.metrics, before.metrics + 1, "exactly one metric row must have been inserted");
    assert.equal(after.batches, before.batches + 1);
  });

  test("same batch_id, different content, concurrently: exactly one side wins, loser gets 409, no silent corruption", async () => {
    const batchId = crypto.randomUUID();
    const before = await dbCounts(run.id);

    const [resA, resB] = await Promise.all([
      api(`/runs/${run.id}/metrics`, {
        method: "POST",
        apiKey: proj.api_key.key,
        body: JSON.stringify({ batch_id: batchId, metrics: [{ name: "conflict", step: 1, value: 1 }] }),
      }),
      api(`/runs/${run.id}/metrics`, {
        method: "POST",
        apiKey: proj.api_key.key,
        body: JSON.stringify({ batch_id: batchId, metrics: [{ name: "conflict", step: 1, value: 2 }] }),
      }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    // One must succeed (201) and the other must see it as a conflicting
    // batch_id reuse (409) — never both succeeding, never both silently failing.
    assert.deepEqual(statuses, [201, 409]);

    const after = await dbCounts(run.id);
    assert.equal(after.metrics, before.metrics + 1);
    assert.equal(after.batches, before.batches + 1);
  });
});

describe("no events lost across a reconnect (Last-Event-ID partial catch-up)", () => {
  test("metrics sent while disconnected are delivered exactly once on reconnect, nothing missed, nothing duplicated", async () => {
    const run2 = await createRun(proj.api_key.key, "reconnect-run");

    // Seed one metric, then open a stream and capture its SSE resumption id.
    await api(`/runs/${run2.id}/metrics`, {
      method: "POST",
      apiKey: proj.api_key.key,
      body: JSON.stringify({ batch_id: crypto.randomUUID(), metrics: [{ name: "seed", step: 0, value: 0 }] }),
    });

    const ctrl1 = new AbortController();
    const res1 = await api(`/runs/${run2.id}/stream`, { apiKey: proj.api_key.key, signal: ctrl1.signal });
    assert.equal(res1.status, 200);
    const reader1 = res1.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastId = 0;
    // Read until we see the "ready" event marking end of initial backfill.
    for (;;) {
      const { value, done } = await reader1.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = parseSSEBlocks(buf);
      const ready = blocks.find((b) => b.event === "ready");
      if (ready) {
        lastId = Math.max(...blocks.filter((b) => b.id !== undefined).map((b) => b.id));
        break;
      }
    }
    assert.ok(lastId > 0, "expected a seeded metric id before disconnecting");

    // Real disconnect: Node's fetch (undici) actually tears down the TCP
    // connection on abort, unlike Chromium's context.setOffline() emulation
    // for an already-open stream (see tests/e2e/debug-offline.spec.ts).
    ctrl1.abort();

    // Send 3 more metrics "while the client is gone".
    const sentWhileGone = [
      { name: "missed", step: 1, value: 1.1 },
      { name: "missed", step: 2, value: 2.2 },
      { name: "missed", step: 3, value: 3.3 },
    ];
    for (const m of sentWhileGone) {
      const r = await api(`/runs/${run2.id}/metrics`, {
        method: "POST",
        apiKey: proj.api_key.key,
        body: JSON.stringify({ batch_id: crypto.randomUUID(), metrics: [m] }),
      });
      assert.equal(r.status, 201);
    }

    // Reconnect with Last-Event-ID = the watermark captured before disconnect.
    const ctrl2 = new AbortController();
    const res2 = await api(`/runs/${run2.id}/stream`, {
      apiKey: proj.api_key.key,
      headers: { "Last-Event-ID": String(lastId) },
      signal: ctrl2.signal,
    });
    const reader2 = res2.body.getReader();
    let buf2 = "";
    const received = [];
    for (;;) {
      const { value, done } = await reader2.read();
      if (done) break;
      buf2 += decoder.decode(value, { stream: true });
      const blocks = parseSSEBlocks(buf2);
      if (blocks.find((b) => b.event === "ready")) {
        for (const b of blocks) if (b.event === "metric") received.push(JSON.parse(b.data));
        break;
      }
    }
    ctrl2.abort();

    assert.equal(received.length, 3, `expected exactly the 3 missed metrics, got ${JSON.stringify(received)}`);
    assert.deepEqual(
      received.map((m) => m.name + ":" + m.step),
      sentWhileGone.map((m) => m.name + ":" + m.step),
    );
  });
});

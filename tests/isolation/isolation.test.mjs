// Automated isolation tests: project A must never read, write, subscribe to,
// or otherwise observe project B's data — not even by guessing a syntactically
// valid run id, not via a shared HTTP cache, not via a key that was just
// rotated out. Run with `npm test` (needs the stack from `docker compose up`).
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
  assert.equal(res.status, 201, `createProject(${name}) failed`);
  return res.json();
}

async function createRun(apiKey, name) {
  const res = await api("/runs", { method: "POST", apiKey, body: JSON.stringify({ name }) });
  assert.equal(res.status, 201, "createRun failed");
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

/** Reads SSE frames from a fetch Response body, calling onBlock(text) for each. Stops when aborted or body ends. */
async function readSSE(body, onBlock, { maxBlocks = 20 } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        onBlock(block);
        count += 1;
        if (count >= maxBlocks) return;
      }
    }
  } catch {
    // reader aborted/closed — expected when the caller cancels.
  }
}

let projA, projB, runA, runB;

before(async () => {
  projA = await createProject(`iso-A-${Date.now()}`);
  projB = await createProject(`iso-B-${Date.now()}`);
  runA = await createRun(projA.api_key.key, "run-a");
  runB = await createRun(projB.api_key.key, "run-b");
  // Seed B's run with one metric so "A can read B" checks would have
  // something to actually leak if isolation were broken.
  const res = await api(`/runs/${runB.id}/metrics`, {
    method: "POST",
    apiKey: projB.api_key.key,
    body: JSON.stringify({
      batch_id: crypto.randomUUID(),
      metrics: [{ name: "secret", step: 1, value: 42 }],
    }),
  });
  assert.equal(res.status, 201);
});

describe("project A cannot access project B's resources", () => {
  test("A cannot read B's run by id", async () => {
    const res = await api(`/runs/${runB.id}`, { apiKey: projA.api_key.key });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "not found"); // must not say "forbidden" (would leak existence)
  });

  test("A cannot write metrics into B's run, and the DB is unchanged", async () => {
    const before = await dbCounts(runB.id);
    const res = await api(`/runs/${runB.id}/metrics`, {
      method: "POST",
      apiKey: projA.api_key.key,
      body: JSON.stringify({
        batch_id: crypto.randomUUID(),
        metrics: [{ name: "injected", step: 1, value: 999 }],
      }),
    });
    assert.equal(res.status, 404);
    const after = await dbCounts(runB.id);
    assert.deepEqual(after, before, "forbidden write must not change B's row counts");
  });

  test("A cannot read B's metrics endpoint", async () => {
    const res = await api(`/runs/${runB.id}/metrics`, { apiKey: projA.api_key.key });
    assert.equal(res.status, 404);
  });

  test("A cannot subscribe to B's live stream — rejected before any data is sent", async () => {
    const res = await api(`/runs/${runB.id}/stream`, { apiKey: projA.api_key.key });
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.ok(!text.includes("secret"), "stream rejection must not leak B's metric payloads");
  });

  test("B's run does not appear in A's run list", async () => {
    const res = await api("/runs", { apiKey: projA.api_key.key });
    assert.equal(res.status, 200);
    const runs = await res.json();
    assert.ok(
      runs.every((r) => r.id !== runB.id),
      "A's run list must not contain B's run",
    );
  });

  test("guessing B's run id with no key at all is rejected before any ownership check", async () => {
    const res = await api(`/runs/${runB.id}`);
    assert.equal(res.status, 401);
  });

  test("a syntactically valid but nonexistent run id behaves identically to a real cross-project id (no existence oracle)", async () => {
    const fakeId = crypto.randomUUID();
    const resFake = await api(`/runs/${fakeId}`, { apiKey: projA.api_key.key });
    const resReal = await api(`/runs/${runB.id}`, { apiKey: projA.api_key.key });
    assert.equal(resFake.status, resReal.status);
    assert.deepEqual(await resFake.json(), await resReal.json());
  });
});

describe("no leakage via HTTP caching", () => {
  test("protected responses are marked no-store", async () => {
    const endpoints = [
      ["/runs", {}],
      [`/runs/${runA.id}`, {}],
      [`/runs/${runA.id}/metrics`, {}],
    ];
    for (const [path, opts] of endpoints) {
      const res = await api(path, { apiKey: projA.api_key.key, ...opts });
      assert.equal(
        res.headers.get("cache-control"),
        "no-store",
        `${path} must set Cache-Control: no-store`,
      );
    }
  });
});

describe("api key rotation", () => {
  test("old key stops working immediately for reads, writes, and new streams", async () => {
    const rotRes = await api("/projects/me/keys/rotate", { method: "POST", apiKey: projA.api_key.key });
    assert.equal(rotRes.status, 200);
    const newKey = (await rotRes.json()).key;
    const oldKey = projA.api_key.key;

    const readRes = await api(`/runs/${runA.id}`, { apiKey: oldKey });
    assert.equal(readRes.status, 401);

    const writeRes = await api(`/runs/${runA.id}/metrics`, {
      method: "POST",
      apiKey: oldKey,
      body: JSON.stringify({ batch_id: crypto.randomUUID(), metrics: [{ name: "x", step: 1, value: 1 }] }),
    });
    assert.equal(writeRes.status, 401);

    const streamRes = await api(`/runs/${runA.id}/stream`, { apiKey: oldKey });
    assert.equal(streamRes.status, 401);

    const newRes = await api(`/runs/${runA.id}`, { apiKey: newKey });
    assert.equal(newRes.status, 200);

    // Keep A's project usable for later tests in this file.
    projA.api_key.key = newKey;
  });

  test("a stream opened before rotation is force-closed within one heartbeat window, not left open indefinitely", async () => {
    const run = await createRun(projA.api_key.key, "rotation-stream-run");
    const keyBeforeRotation = projA.api_key.key;

    const streamRes = await api(`/runs/${run.id}/stream`, { apiKey: keyBeforeRotation });
    assert.equal(streamRes.status, 200);

    const blocks = [];
    const readDone = readSSE(streamRes.body, (b) => blocks.push(b), { maxBlocks: 8 });

    // Let the stream fully establish (it sends "ready" immediately) before rotating.
    await new Promise((r) => setTimeout(r, 300));

    const rotRes = await api("/projects/me/keys/rotate", { method: "POST", apiKey: keyBeforeRotation });
    assert.equal(rotRes.status, 200);
    projA.api_key.key = (await rotRes.json()).key;

    const t0 = Date.now();
    await Promise.race([readDone, new Promise((r) => setTimeout(r, 10_000))]);
    const elapsed = Date.now() - t0;

    assert.ok(
      blocks.some((b) => b.includes("event: revoked")),
      `expected a "revoked" frame before the stream closed, got: ${JSON.stringify(blocks)}`,
    );
    assert.ok(elapsed < 10_000, `stream on a rotated key stayed open for ${elapsed}ms, expected < 10s`);
  });
});

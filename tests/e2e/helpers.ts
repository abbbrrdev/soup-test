import { Client } from "pg";
import crypto from "node:crypto";

export const API_URL = process.env.API_URL ?? "http://localhost:8080";
export const DB_URL = process.env.DATABASE_URL ?? "postgres://tracker:tracker@localhost:5432/tracker";

export async function apiFetch(path: string, opts: RequestInit & { apiKey?: string } = {}) {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  if (opts.apiKey) headers.set("Authorization", `Bearer ${opts.apiKey}`);
  const res = await fetch(`${API_URL}${path}`, { ...opts, headers });
  return res;
}

export async function createProject(name: string) {
  const res = await apiFetch("/projects", { method: "POST", body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    project: { id: string; name: string };
    api_key: { key: string };
  };
}

export async function createRun(apiKey: string, name: string) {
  const res = await apiFetch("/runs", { method: "POST", apiKey, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`createRun failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; name: string };
}

export interface MetricIn {
  name: string;
  step: number;
  value: number;
}

export async function postBatch(apiKey: string, runId: string, batchId: string, metrics: MetricIn[]) {
  const res = await apiFetch(`/runs/${runId}/metrics`, {
    method: "POST",
    apiKey,
    body: JSON.stringify({ batch_id: batchId, metrics }),
  });
  return res;
}

export function newBatchId() {
  return crypto.randomUUID();
}

/** Independent ground truth — connects to Postgres directly, bypassing the API entirely. */
export async function dbMetricsForRun(runId: string) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT name, step, value FROM metrics WHERE run_id = $1 ORDER BY name, step, ts, id`,
      [runId],
    );
    return rows as { name: string; step: number; value: number }[];
  } finally {
    await client.end();
  }
}

export async function dbBatchCount(runId: string) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM batches WHERE run_id = $1`, [runId]);
    return rows[0].n as number;
  } finally {
    await client.end();
  }
}

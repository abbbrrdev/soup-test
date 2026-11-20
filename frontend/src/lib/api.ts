import type {
  ApiKeyCreated,
  BatchResult,
  Metric,
  MetricIn,
  Project,
  Run,
} from "./types";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, opts: RequestInit & { apiKey?: string } = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  if (opts.apiKey) headers.set("Authorization", `Bearer ${opts.apiKey}`);

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function createProject(name: string) {
  return request<{ project: Project; api_key: ApiKeyCreated }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getMe(apiKey: string) {
  return request<Project>("/projects/me", { apiKey });
}

export function rotateKey(apiKey: string) {
  return request<ApiKeyCreated>("/projects/me/keys/rotate", { method: "POST", apiKey });
}

export function listRuns(apiKey: string) {
  return request<Run[]>("/runs", { apiKey });
}

export function createRun(apiKey: string, name: string) {
  return request<Run>("/runs", { method: "POST", apiKey, body: JSON.stringify({ name }) });
}

export function getRun(apiKey: string, runId: string) {
  return request<Run>(`/runs/${runId}`, { apiKey });
}

export function getMetrics(apiKey: string, runId: string) {
  return request<Metric[]>(`/runs/${runId}/metrics`, { apiKey });
}

export function postMetricsBatch(apiKey: string, runId: string, batchId: string, metrics: MetricIn[]) {
  return request<BatchResult>(`/runs/${runId}/metrics`, {
    method: "POST",
    apiKey,
    body: JSON.stringify({ batch_id: batchId, metrics }),
  });
}

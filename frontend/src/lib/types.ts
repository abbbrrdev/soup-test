export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface ApiKeyCreated {
  id: string;
  key: string;
  prefix: string;
  created_at: string;
}

export interface Run {
  id: string;
  project_id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface Metric {
  id: number;
  run_id: string;
  batch_id: string;
  name: string;
  step: number;
  ts: string;
  value: number;
}

export interface MetricIn {
  name: string;
  step: number;
  value: number;
  ts?: string;
}

export interface BatchResult {
  batch_id: string;
  status: "accepted" | "duplicate";
  metric_count: number;
}

export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

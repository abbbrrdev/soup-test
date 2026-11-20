CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash    text NOT NULL UNIQUE,
    key_prefix  text NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);
CREATE INDEX idx_api_keys_project ON api_keys(project_id);
CREATE INDEX idx_api_keys_active_hash ON api_keys(key_hash) WHERE is_active;

CREATE TABLE runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        text NOT NULL,
    status      text NOT NULL DEFAULT 'running',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_project ON runs(project_id, created_at DESC);

CREATE TABLE batches (
    id            uuid NOT NULL,
    run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    content_hash  text NOT NULL,
    metric_count  integer NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, id)
);

CREATE TABLE metrics (
    id            bigserial PRIMARY KEY,
    run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    batch_id      uuid NOT NULL,
    seq_in_batch  integer NOT NULL,
    name          text NOT NULL,
    step          bigint NOT NULL,
    ts            timestamptz NOT NULL,
    value         double precision NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (run_id, batch_id) REFERENCES batches(run_id, id) ON DELETE CASCADE,
    UNIQUE (run_id, batch_id, seq_in_batch)
);
CREATE INDEX idx_metrics_run_id_cursor ON metrics(run_id, id);
CREATE INDEX idx_metrics_run_display ON metrics(run_id, name, step, ts, id);

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getRun, ApiError } from "../lib/api";
import { connectRunStream } from "../lib/stream";
import type { ConnState, Metric, Run } from "../lib/types";
import ConnectionBadge from "../components/ConnectionBadge";
import MetricsChart from "../components/MetricsChart";
import MetricsTable from "../components/MetricsTable";
import DemoGenerator from "../components/DemoGenerator";

type LoadState = "loading" | "ready" | "empty" | "error";

export default function RunDetailPage({
  apiKey,
  onRevoked,
}: {
  apiKey: string;
  onRevoked: () => void;
}) {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [metricsById, setMetricsById] = useState<Map<number, Metric>>(new Map());
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const snapshotReady = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadState("loading");
    setMetricsById(new Map());
    snapshotReady.current = false;

    getRun(apiKey, id)
      .then((r) => {
        if (!cancelled) setRun(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "failed to load run");
          setLoadState("error");
        }
      });

    const disconnect = connectRunStream(apiKey, id, {
      onStateChange: setConnState,
      onMetric: (m) => {
        setMetricsById((prev) => {
          const next = new Map(prev);
          next.set(m.id, m);
          return next;
        });
      },
      onReady: () => {
        snapshotReady.current = true;
        setLoadState((prev) => (prev === "error" ? prev : "ready"));
      },
      onRevoked: onRevoked,
    });

    return () => {
      cancelled = true;
      disconnect();
    };
  }, [apiKey, id, onRevoked]);

  const metrics = useMemo(() => {
    return Array.from(metricsById.values()).sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      if (a.step !== b.step) return a.step - b.step;
      if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
      return a.id - b.id;
    });
  }, [metricsById]);

  useEffect(() => {
    if (loadState === "ready" && metrics.length === 0 && snapshotReady.current) {
      setLoadState("empty");
    } else if (loadState === "empty" && metrics.length > 0) {
      setLoadState("ready");
    }
  }, [metrics.length, loadState]);

  if (loadState === "error") {
    return (
      <div className="container">
        <p className="error">{error}</p>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{run?.name ?? "…"}</h1>
        <ConnectionBadge state={connState} />
      </div>
      {id && <div style={{ marginBottom: 16 }}><DemoGenerator apiKey={apiKey} runId={id} /></div>}

      {loadState === "loading" && <p className="muted">Loading run…</p>}

      {(loadState === "ready" || loadState === "empty") && (
        <>
          <div className="card">
            {loadState === "empty" ? (
              <p className="muted">No metrics yet. Start the demo generator or POST to /runs/{id}/metrics.</p>
            ) : (
              <MetricsChart metrics={metrics} />
            )}
          </div>
          <div className="card">
            <h3 data-testid="metrics-count" data-count={metrics.length}>
              Latest metrics ({metrics.length} total)
            </h3>
            {metrics.length === 0 ? (
              <p className="muted">Nothing received yet.</p>
            ) : (
              <MetricsTable metrics={metrics} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

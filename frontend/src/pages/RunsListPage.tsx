import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createRun, listRuns, ApiError } from "../lib/api";
import type { Run } from "../lib/types";

type LoadState = "loading" | "ready" | "error";

export default function RunsListPage({ apiKey }: { apiKey: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [newRunName, setNewRunName] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    setState("loading");
    try {
      const data = await listRuns(apiKey);
      setRuns(data);
      setState("ready");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "failed to load runs");
      setState("error");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  async function handleCreateRun() {
    if (!newRunName.trim()) return;
    setCreating(true);
    try {
      const run = await createRun(apiKey, newRunName.trim());
      setNewRunName("");
      setRuns((prev) => [run, ...prev]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "failed to create run");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="container">
      <h1>Runs</h1>

      <div className="card">
        <div className="row">
          <input
            placeholder="New run name"
            value={newRunName}
            onChange={(e) => setNewRunName(e.target.value)}
          />
          <button onClick={handleCreateRun} disabled={creating || !newRunName.trim()}>
            Create run
          </button>
        </div>
      </div>

      {state === "loading" && <p className="muted">Loading…</p>}
      {state === "error" && <p className="error">{error}</p>}

      {state === "ready" && runs.length === 0 && (
        <div className="card">
          <p className="muted">No runs yet for this project. Create one above.</p>
        </div>
      )}

      {state === "ready" && runs.length > 0 && (
        <div className="card">
          {runs.map((run) => (
            <Link key={run.id} to={`/runs/${run.id}`} className="runlist-item">
              <span>{run.name}</span>
              <span className="muted">
                {run.status} · {new Date(run.created_at).toLocaleString()}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

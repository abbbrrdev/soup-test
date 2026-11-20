import { useState } from "react";
import { createProject, getMe, ApiError } from "../lib/api";
import { setStoredKey } from "../lib/storage";

export default function ConnectPage({ onConnected }: { onConnected: (key: string, projectName: string) => void }) {
  const [newProjectName, setNewProjectName] = useState("");
  const [existingKey, setExistingKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null);

  async function handleCreate() {
    setError(null);
    setBusy(true);
    try {
      const { project, api_key } = await createProject(newProjectName || "Demo project");
      setStoredKey(api_key.key, project.name);
      setCreatedKey({ key: api_key.key, name: project.name });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "failed to create project");
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectExisting() {
    setError(null);
    setBusy(true);
    try {
      const project = await getMe(existingKey.trim());
      setStoredKey(existingKey.trim(), project.name);
      onConnected(existingKey.trim(), project.name);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "invalid api key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 560 }}>
      <h1>Connect a project</h1>
      <p className="muted">
        A project is the isolation boundary: each project has its own API key, and keys only ever see
        their own runs and metrics.
      </p>

      <div className="card">
        <h3>Create a new demo project</h3>
        <div className="row">
          <input
            placeholder="Project name"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
          />
          <button onClick={handleCreate} disabled={busy}>
            Create
          </button>
        </div>
        {createdKey && (
          <div style={{ marginTop: 12 }}>
            <p className="muted">
              Local demo key for <b>{createdKey.name}</b> — shown once, store it yourself:
            </p>
            <code className="key">{createdKey.key}</code>
            <div style={{ marginTop: 10 }}>
              <button onClick={() => onConnected(createdKey.key, createdKey.name)}>Continue</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Connect with an existing API key</h3>
        <div className="row">
          <input
            placeholder="sk_live_..."
            value={existingKey}
            onChange={(e) => setExistingKey(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={handleConnectExisting} disabled={busy || !existingKey}>
            Connect
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

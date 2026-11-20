import { Navigate, Route, Routes, Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import ConnectPage from "./pages/ConnectPage";
import RunsListPage from "./pages/RunsListPage";
import RunDetailPage from "./pages/RunDetailPage";
import { clearStoredKey, getStoredKey, getStoredProjectName } from "./lib/storage";

export default function App() {
  const [apiKey, setApiKey] = useState<string | null>(getStoredKey());
  const [projectName, setProjectName] = useState<string | null>(getStoredProjectName());
  const navigate = useNavigate();

  useEffect(() => {
    setApiKey(getStoredKey());
    setProjectName(getStoredProjectName());
  }, []);

  function handleConnected(key: string, name: string) {
    setApiKey(key);
    setProjectName(name);
    navigate("/runs");
  }

  function handleDisconnect() {
    clearStoredKey();
    setApiKey(null);
    setProjectName(null);
    navigate("/");
  }

  return (
    <>
      <div className="topbar">
        <Link to="/" style={{ textDecoration: "none", color: "inherit", fontWeight: 600 }}>
          Experiment Tracker
        </Link>
        {apiKey && (
          <div className="row">
            <span className="muted">project: {projectName}</span>
            <button className="secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
        )}
      </div>
      <Routes>
        <Route path="/" element={<ConnectPage onConnected={handleConnected} />} />
        <Route
          path="/runs"
          element={apiKey ? <RunsListPage apiKey={apiKey} /> : <Navigate to="/" replace />}
        />
        <Route
          path="/runs/:id"
          element={
            apiKey ? (
              <RunDetailPage apiKey={apiKey} onRevoked={handleDisconnect} />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
      </Routes>
    </>
  );
}

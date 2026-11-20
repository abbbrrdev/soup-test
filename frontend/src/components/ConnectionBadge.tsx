import type { ConnState } from "../lib/types";

const LABEL: Record<ConnState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

export default function ConnectionBadge({ state }: { state: ConnState }) {
  return (
    <span className="badge" data-testid="conn-badge" data-state={state}>
      <span className={`dot ${state}`} />
      {LABEL[state]}
    </span>
  );
}

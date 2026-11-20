import { API_BASE } from "./api";
import type { ConnState, Metric } from "./types";

export interface StreamHandlers {
  onMetric: (m: Metric) => void;
  onStateChange: (s: ConnState) => void;
  onReady?: () => void;
  onRevoked?: () => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const STALE_TIMEOUT_MS = 8000;

export function connectRunStream(apiKey: string, runId: string, handlers: StreamHandlers) {
  let lastId = 0;
  let stopped = false;
  let attempt = 0;
  let abort: AbortController | null = null;

  async function loop() {
    while (!stopped) {
      handlers.onStateChange(attempt === 0 ? "connecting" : "reconnecting");
      abort = new AbortController();
      const currentAbort = abort;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const armWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => currentAbort.abort(), STALE_TIMEOUT_MS);
      };

      try {
        armWatchdog();
        const res = await fetch(`${API_BASE}/runs/${runId}/stream?after_id=${lastId}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Last-Event-ID": String(lastId),
          },
          signal: currentAbort.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 401 || res.status === 404) {
            handlers.onRevoked?.();
            handlers.onStateChange("disconnected");
            return;
          }
          throw new Error(`stream http ${res.status}`);
        }

        handlers.onStateChange("connected");
        attempt = 0;
        armWatchdog();
        await readEvents(res.body, (event, id, data) => {
          armWatchdog();
          if (id !== undefined) lastId = id;
          if (event === "metric") {
            handlers.onMetric(JSON.parse(data) as Metric);
          } else if (event === "revoked") {
            handlers.onRevoked?.();
          } else if (event === "ready") {
            handlers.onReady?.();
          }
        });
      } catch (err) {
        if (stopped) return;
        void err;
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }

      if (stopped) return;
      handlers.onStateChange("reconnecting");
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      await sleep(delay);
    }
  }

  loop();

  return () => {
    stopped = true;
    abort?.abort();
    handlers.onStateChange("disconnected");
  };
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, id: number | undefined, data: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      parseBlock(block, onEvent);
    }
  }
}

function parseBlock(block: string, onEvent: (event: string, id: number | undefined, data: string) => void) {
  let event = "message";
  let id: number | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (dataLines.length > 0) onEvent(event, id, dataLines.join("\n"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

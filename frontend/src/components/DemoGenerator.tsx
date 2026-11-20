import { useEffect, useRef, useState } from "react";
import { postMetricsBatch } from "../lib/api";

export default function DemoGenerator({ apiKey, runId }: { apiKey: string; runId: string }) {
  const [running, setRunning] = useState(false);
  const stepRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  function toggle() {
    if (running) {
      if (timerRef.current) window.clearInterval(timerRef.current);
      setRunning(false);
      return;
    }
    setRunning(true);
    timerRef.current = window.setInterval(async () => {
      stepRef.current += 1;
      const step = stepRef.current;
      const batchId = crypto.randomUUID();
      try {
        await postMetricsBatch(apiKey, runId, batchId, [
          { name: "loss", step, value: Number((2 / step + Math.random() * 0.1).toFixed(4)) },
          { name: "accuracy", step, value: Number((1 - 1 / step - Math.random() * 0.05).toFixed(4)) },
        ]);
      } catch {
      }
    }, 1000);
  }

  return (
    <button className="secondary" onClick={toggle}>
      {running ? "Stop demo generator" : "Start demo generator"}
    </button>
  );
}

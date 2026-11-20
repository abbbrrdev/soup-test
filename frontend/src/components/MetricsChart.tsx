import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import type { Metric } from "../lib/types";

const COLORS = ["#6ea8fe", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa", "#2dd4bf"];

export default function MetricsChart({ metrics }: { metrics: Metric[] }) {
  const names = Array.from(new Set(metrics.map((m) => m.name)));
  const steps = Array.from(new Set(metrics.map((m) => m.step))).sort((a, b) => a - b);

  const data = steps.map((step) => {
    const point: Record<string, number> = { step };
    for (const name of names) {
      const atStep = metrics.filter((m) => m.name === name && m.step === step);
      if (atStep.length > 0) point[name] = atStep[atStep.length - 1].value;
    }
    return point;
  });

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#22262f" />
        <XAxis dataKey="step" stroke="#9aa1ad" />
        <YAxis stroke="#9aa1ad" />
        <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #3a3f4b" }} />
        <Legend />
        {names.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={COLORS[i % COLORS.length]}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

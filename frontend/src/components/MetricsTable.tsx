import type { Metric } from "../lib/types";

export default function MetricsTable({ metrics }: { metrics: Metric[] }) {
  const latest = metrics.slice(-50).reverse();
  return (
    <table data-testid="metrics-table">
      <thead>
        <tr>
          <th>name</th>
          <th>step</th>
          <th>value</th>
          <th>ts</th>
          <th>cursor id</th>
        </tr>
      </thead>
      <tbody>
        {latest.map((m) => (
          <tr key={m.id} data-testid="metric-row" data-name={m.name} data-step={m.step} data-value={m.value}>
            <td>{m.name}</td>
            <td>{m.step}</td>
            <td>{m.value}</td>
            <td className="muted">{new Date(m.ts).toLocaleTimeString()}</td>
            <td className="muted">{m.id}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

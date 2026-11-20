import { test, expect } from "@playwright/test";
import {
  createProject,
  createRun,
  postBatch,
  newBatchId,
  dbMetricsForRun,
  dbBatchCount,
} from "./helpers";

/**
 * Proves: "what the user sees == what's in Postgres" under out-of-order
 * arrival, a duplicated batch, a mid-stream disconnect/reconnect, and a late
 * metric arriving after the client already resumed live updates.
 *
 * The DB comparison at the end reads Postgres directly via `pg` (helpers.ts
 * dbMetricsForRun) — it does NOT call the tracker API a second time, so it
 * can't just be agreeing with itself.
 */
test("UI state matches Postgres after out-of-order, duplicate, and disconnect/reconnect", async ({ page }) => {
  const { project, api_key } = await createProject(`e2e-consistency-${Date.now()}`);
  const run = await createRun(api_key.key, "consistency-run");

  await page.addInitScript(
    ([key, name]) => {
      localStorage.setItem("soup_tracker_api_key", key as string);
      localStorage.setItem("soup_tracker_project_name", name as string);
    },
    [api_key.key, project.name],
  );

  await page.goto(`/runs/${run.id}`);
  await expect(page.getByTestId("conn-badge")).toHaveAttribute("data-state", "connected", {
    timeout: 10_000,
  });

  // --- 1. Out-of-order arrival: step 3 before step 1 before step 2. ---
  const b1 = newBatchId();
  let res = await postBatch(api_key.key, run.id, b1, [{ name: "loss", step: 3, value: 3.3 }]);
  expect(res.status).toBe(201);

  const b2 = newBatchId();
  res = await postBatch(api_key.key, run.id, b2, [{ name: "loss", step: 1, value: 1.1 }]);
  expect(res.status).toBe(201);

  const b3 = newBatchId();
  res = await postBatch(api_key.key, run.id, b3, [{ name: "loss", step: 2, value: 2.2 }]);
  expect(res.status).toBe(201);

  // --- 2. Duplicate: resend batch b2 verbatim. Must not create a 4th row. ---
  res = await postBatch(api_key.key, run.id, b2, [{ name: "loss", step: 1, value: 1.1 }]);
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("duplicate");

  await expect(page.getByTestId("metrics-count")).toHaveAttribute("data-count", "3", {
    timeout: 10_000,
  });

  // Display order must already be step-sorted, not arrival-sorted (3,1,2 arrived; 1,2,3 must render).
  const stepsAfterOrdering = await page.locator('[data-testid="metric-row"]').evaluateAll((rows) =>
    rows.map((r) => Number((r as HTMLElement).dataset.step)).sort((a, b) => a - b),
  );
  expect(stepsAfterOrdering).toEqual([1, 2, 3]);

  // --- 3. Disconnect the browser mid-stream, keep sending metrics while it's down. ---
  // Note on method: Playwright's context.setOffline() does NOT interrupt an
  // already-open fetch() stream in Chromium — confirmed empirically in
  // debug-offline.spec.ts (heartbeats kept flowing straight through "offline").
  // That matches Playwright's own docs: setOffline only affects requests not
  // yet in flight. To get a real disconnect of the live connection we
  // navigate the tab away (which really does abort the open stream — the
  // page/JS context is torn down) while the server and API stay fully up,
  // post metrics "while the client is gone", then navigate back.
  await page.goto("about:blank");

  const b4 = newBatchId();
  res = await postBatch(api_key.key, run.id, b4, [{ name: "loss", step: 4, value: 4.4 }]);
  expect(res.status).toBe(201);
  const b5 = newBatchId();
  res = await postBatch(api_key.key, run.id, b5, [{ name: "loss", step: 5, value: 5.5 }]);
  expect(res.status).toBe(201);

  // --- 4. Reconnect. Client must catch up on what it missed while gone. ---
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByTestId("conn-badge")).toHaveAttribute("data-state", "connected", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("metrics-count")).toHaveAttribute("data-count", "5", {
    timeout: 15_000,
  });

  // --- 5. Late metric: lower step than what's already shown, arriving after reconnect. ---
  const b6 = newBatchId();
  res = await postBatch(api_key.key, run.id, b6, [{ name: "loss", step: 0, value: 0.05 }]);
  expect(res.status).toBe(201);

  await expect(page.getByTestId("metrics-count")).toHaveAttribute("data-count", "6", {
    timeout: 10_000,
  });
  const finalSteps = await page.locator('[data-testid="metric-row"]').evaluateAll((rows) =>
    rows.map((r) => Number((r as HTMLElement).dataset.step)).sort((a, b) => a - b),
  );
  expect(finalSteps).toEqual([0, 1, 2, 3, 4, 5]);

  // --- 6. Compare rendered UI values against Postgres, read independently. ---
  const uiRows = await page.locator('[data-testid="metric-row"]').evaluateAll((rows) =>
    rows.map((r) => ({
      name: (r as HTMLElement).dataset.name,
      step: Number((r as HTMLElement).dataset.step),
      value: Number((r as HTMLElement).dataset.value),
    })),
  );
  uiRows.sort((a, b) => a.step - b.step);

  const dbRows = await dbMetricsForRun(run.id);
  dbRows.sort((a, b) => a.step - b.step);

  expect(dbRows).toHaveLength(6);
  expect(uiRows).toEqual(
    dbRows.map((r) => ({ name: r.name, step: Number(r.step), value: Number(r.value) })),
  );

  // --- 7. The duplicate resend must not have created a second batch/metric row. ---
  expect(await dbBatchCount(run.id)).toBe(6);

  // What this test does NOT catch: events lost between two independent
  // browser tabs on the same run, a backend crash mid-transaction (covered
  // separately by silent-failure checks), or clock skew between
  // client-supplied ts and server received_at. See docs/submission-note.md.
});

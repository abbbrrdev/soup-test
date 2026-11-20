import { test } from "@playwright/test";
import { createProject, createRun } from "./helpers";

test("debug: does setOffline interrupt an open fetch stream?", async ({ page, context }) => {
  const { api_key } = await createProject(`debug-offline-${Date.now()}`);
  const run = await createRun(api_key.key, "debug-run");

  page.on("console", (msg) => console.log("[page]", msg.text()));

  await page.goto("/");
  await page.evaluate(
    async ([apiBase, apiKey, runId]) => {
      const res = await fetch(`${apiBase}/runs/${runId}/stream`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const t0 = Date.now();
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              console.log(`[stream] done at t=${Date.now() - t0}ms`);
              return;
            }
            console.log(`[stream] chunk at t=${Date.now() - t0}ms: ${decoder.decode(value).slice(0, 40)}`);
          }
        } catch (e) {
          console.log(`[stream] error at t=${Date.now() - t0}ms: ${e}`);
        }
      })();
    },
    ["http://localhost:8080", api_key.key, run.id],
  );

  await page.waitForTimeout(4000);
  console.log(">>> going offline");
  await context.setOffline(true);
  await page.waitForTimeout(12000);
  console.log(">>> going back online");
  await context.setOffline(false);
  await page.waitForTimeout(4000);
});

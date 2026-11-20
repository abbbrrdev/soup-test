import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: process.env.FRONTEND_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
});

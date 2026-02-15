import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/__tests__/browser",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});

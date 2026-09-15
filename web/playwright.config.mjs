import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: "*.spec.mjs", fullyParallel: true,
  outputDir: "../.runtime/browser-results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: { command: "node tests/browser/server.mjs", url: "http://127.0.0.1:4173", reuseExistingServer: false },
});

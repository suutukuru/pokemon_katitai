import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:4173" },
  // iPhone viewport (WebKit is not installed here, so the Chromium engine renders it)
  projects: [{ name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium" } }],
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});

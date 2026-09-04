import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_API_BASE_URL: "http://localhost:9999",
      // A pool that does not exist. Nothing here ever reaches Cognito: the
      // tests seed a session directly and never redirect, which is the point
      // -- driving Google's consent screen in CI is not a test of this app.
      VITE_COGNITO_AUTHORITY:
        "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
      VITE_COGNITO_CLIENT_ID: "test-client-id",
    },
  },
});

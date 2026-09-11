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
      // Not a real Yahoo app id. Tests either intercept the request to
      // api.login.yahoo.com before it leaves the browser, or skip the
      // button by seeding sessionStorage and driving the callback route
      // directly -- so nothing here ever reaches Yahoo.
      VITE_YAHOO_CLIENT_ID: "test-yahoo-client-id",
      // Not a real VAPID key -- every test that reaches the draft page fakes
      // navigator.serviceWorker.register itself rather than letting a real
      // PushManager.subscribe() try to reach a real push service. It does,
      // however, have to be a validly-shaped base64url string (length % 4 in
      // {0, 2, 3}, never 1): urlBase64ToUint8Array pads and feeds it to atob()
      // for real before the fake pushManager.subscribe() ever sees it, and a
      // string shaped like "test-vapid-public-key" (length % 4 == 1, which no
      // real base64 ever produces) throws there. Present here (unlike
      // Yahoo's client id above) means the "no VITE_VAPID_PUBLIC_KEY" build
      // behaviour -- the control disappearing entirely -- cannot be
      // exercised by this suite; see draft.spec.js's push section for why
      // that gap is reported rather than covered by a test that could not
      // fail.
      VITE_VAPID_PUBLIC_KEY: "test-vapid-public-key-not-a-real-key",
    },
  },
});

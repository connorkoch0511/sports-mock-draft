// Ask Chrome whether it considers this app installable. Do not assert it.
//
// Every test in tests/pwa.spec.js can pass while the app is NOT installable:
// they check that a manifest exists, parses, names icons, and that those icons
// are served. Chrome decides installability by its own criteria, and the one
// that is easy to get wrong is invisible from the page -- whether an active
// service worker exists at all. Registration used to happen only behind the
// notification opt-in, so for most users there was none.
//
// Page.getInstallabilityErrors is Chrome's OWN check, the same one behind
// DevTools -> Application -> Manifest. An empty array is the browser saying
// yes; anything in it names exactly what is missing, including a fetch handler
// if one is ever required again.
//
// Usage:
//   cd frontend && npx vite build && npx vite preview --port 4173 &
//   node scripts/check-installable.js [http://localhost:4173/]
import { chromium } from "@playwright/test";

const url = process.argv[2] || "http://localhost:4173/";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "load" });
// The worker registers after render; Chrome needs it active before it will
// call the app installable.
await page.waitForTimeout(4000);

const cdp = await page.context().newCDPSession(page);
const manifest = await cdp.send("Page.getAppManifest");
const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");

const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  const w = r && (r.active || r.installing);
  return w ? w.scriptURL : null;
});

console.log(`url                  ${url}`);
console.log(`manifest             ${manifest.url || "NOT FOUND"}`);
console.log(`manifest errors      ${JSON.stringify(manifest.errors || [])}`);
console.log(`service worker       ${reg || "NONE"}`);
console.log(`installability       ${JSON.stringify(installabilityErrors)}`);

await browser.close();

const ok = installabilityErrors.length === 0 && (manifest.errors || []).length === 0;
console.log(ok ? "\nINSTALLABLE — Chrome reports no errors." : "\nNOT INSTALLABLE — see above.");
process.exit(ok ? 0 : 1);

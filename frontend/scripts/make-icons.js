// Generates every app icon from one SVG source.
//
// The SCRIPT is the deliverable, not the PNGs. A binary nobody can regenerate
// rots the first time the palette changes.
//
// Node cannot write a PNG on its own and this project has no image library --
// its dependencies are React, dnd-kit, oidc-client-ts and the build toolchain.
// Rather than add sharp or canvas for five files, this rasterizes with
// Playwright's Chromium, which is already a devDependency and is the same
// engine the test suite runs.
//
// Usage: cd frontend && node scripts/make-icons.js
import { chromium } from "@playwright/test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

const GROUND = "#070A0F"; // index.css's own background
const ACCENT = "#67E8F9"; // the app's cyan

/**
 * The mark: a cyan chevron over the app's own ground, echoing the live-draft
 * dot the header already uses. `inset` is the maskable safe zone -- Android
 * crops to whatever shape the launcher wants, so a maskable icon must keep its
 * content inside the inner 80% circle or lose its edges.
 */
function svg({ inset = 0, rounded = true } = {}) {
  const s = 512;
  const pad = s * inset;
  const r = rounded ? 96 : 0;
  // Chevron geometry, scaled into the safe area.
  const box = s - pad * 2;
  const cx = pad + box / 2;
  const top = pad + box * 0.26;
  const bot = pad + box * 0.74;
  const half = box * 0.22;
  const w = box * 0.115;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${r}" fill="${GROUND}"/>
  <path d="M ${cx - half} ${top} L ${cx} ${top + (bot - top) * 0.5} L ${cx - half} ${bot}"
        fill="none" stroke="${ACCENT}" stroke-width="${w}"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${cx + half * 0.72}" cy="${(top + bot) / 2}" r="${w * 0.62}" fill="${ACCENT}"/>
</svg>`;
}

async function render(browser, svgText, size, out) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<body style="margin:0;background:${GROUND}">${svgText.replace(
      /width="512" height="512"/,
      `width="${size}" height="${size}"`
    )}</body>`
  );
  await page.screenshot({ path: out, omitBackground: false });
  await page.close();
  console.log(`wrote ${out}`);
}

const browser = await chromium.launch();

const plain = svg({ inset: 0, rounded: true });
writeFileSync(resolve(PUBLIC, "icon.svg"), plain);
console.log(`wrote ${resolve(PUBLIC, "icon.svg")}`);

await render(browser, plain, 192, resolve(PUBLIC, "icon-192.png"));
await render(browser, plain, 512, resolve(PUBLIC, "icon-512.png"));
await render(browser, plain, 180, resolve(PUBLIC, "apple-touch-icon.png"));

// Maskable: square (the launcher supplies the shape) with the content pulled
// into the inner 80%.
await render(
  browser,
  svg({ inset: 0.1, rounded: false }),
  512,
  resolve(PUBLIC, "icon-512-maskable.png")
);

await browser.close();

const vite = resolve(PUBLIC, "vite.svg");
if (existsSync(vite)) {
  unlinkSync(vite);
  console.log(`deleted ${vite}`);
}

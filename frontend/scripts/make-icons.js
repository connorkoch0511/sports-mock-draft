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
const PANEL = "#1E2A38"; // the unlit cells, the panel colour the UI already uses

/**
 * The mark: the Draft Board itself — a grid of picks with one of them lit.
 *
 * Nine rounded cells in the dim panel colour, the centre one in the accent.
 * That is the app's main surface reduced to its smallest honest form: a board
 * of picks, and yours. It says "mock draft" rather than "sports app", which is
 * the part that is actually distinctive.
 *
 * `span` is the grid's width as a fraction of the canvas, and it is the whole
 * maskable story. Android crops to whatever shape the launcher uses, and the
 * guaranteed-safe region is the INNER 80% CIRCLE — radius 0.4 * size. A square
 * grid's corners sit at (span/2) * sqrt(2) * size from the centre, so the
 * maskable variant uses a smaller span to keep those corners inside that
 * radius. Fitting the inner 80% *square* is not the same thing and is the easy
 * mistake: at span 0.8 the corners land at 0.566 * size, well outside.
 */
function svg({ span = 0.56, rounded = true } = {}) {
  const s = 512;
  const r = rounded ? 96 : 0;
  const n = 3;
  const width = s * span;
  const gap = width * 0.085;
  const cell = (width - gap * (n - 1)) / n;
  const originX = (s - width) / 2;
  const originY = (s - width) / 2;

  let cells = "";
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const mine = row === 1 && col === 1;
      const x = originX + col * (cell + gap);
      const y = originY + row * (cell + gap);
      cells += `\n  <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="${(cell * 0.22).toFixed(1)}" fill="${mine ? ACCENT : PANEL}"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${r}" fill="${GROUND}"/>${cells}
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

const plain = svg({ span: 0.56, rounded: true });
writeFileSync(resolve(PUBLIC, "icon.svg"), plain);
console.log(`wrote ${resolve(PUBLIC, "icon.svg")}`);

await render(browser, plain, 192, resolve(PUBLIC, "icon-192.png"));
await render(browser, plain, 512, resolve(PUBLIC, "icon-512.png"));
await render(browser, plain, 180, resolve(PUBLIC, "apple-touch-icon.png"));

// Maskable: square (the launcher supplies the shape) with the content pulled
// into the inner 80%.
await render(
  browser,
  // Smaller span so the grid's CORNERS clear the inner-80% circle, not
  // merely the inner-80% square.
  svg({ span: 0.48, rounded: false }),
  512,
  resolve(PUBLIC, "icon-512-maskable.png")
);

await browser.close();

const vite = resolve(PUBLIC, "vite.svg");
if (existsSync(vite)) {
  unlinkSync(vite);
  console.log(`deleted ${vite}`);
}

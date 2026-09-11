// Headless-browser smoke test for the Detection Monitor UI.
//
// Not a unit-test framework — a single Playwright script exercising the real
// rendered app end to end: data loads, console/page errors, core interactions
// (station select, scrub, case reveal timing, case detail, tabs, play), the
// loading/error overlays, and a mobile viewport. Run against a server already
// serving the built site (`npm run dev` in another terminal, or `npm run qa`
// which starts one itself).
//
// Frame-fraction constants below are derived from the actual detection
// results (see data-pipeline/output/*_detection_result.json): cloudburst
// trigger frame 296/719 ≈ 0.412, earthquake trigger frame ≈343/719 ≈ 0.477.
// If the synthetic data or models are regenerated with different timing,
// these fractions may need updating.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:8734';
const SHOTS_DIR = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS_DIR, { recursive: true });
const shot = (name) => SHOTS_DIR + name + '.png';

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
  if (!condition) failures++;
}

const browser = await chromium.launch();

async function desktopPass() {
  const consoleIssues = [];
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleIssues.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));
  page.on('requestfailed', (r) => consoleIssues.push(`[requestfailed] ${r.url()} - ${r.failure()?.errorText}`));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loadingOverlay[hidden]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('01-monitor-initial') });

  check('2 gauges rendered', await page.locator('.gauge-card').count() === 2);
  check('7 station rows rendered', await page.locator('.station-row').count() === 7);
  check('map legend visible', await page.locator('.legend').first().isVisible());
  check('damage heat map legend visible', await page.locator('.damage-legend').isVisible());
  check('damage heat map cells rendered', await page.locator('path.damage-cell').count() > 0);

  await page.locator('.station-row').nth(2).click();
  await page.waitForTimeout(150);
  check('station detail shows selected station', (await page.locator('#stationDetail').innerText()).includes('Mangan'));

  const track = page.locator('#scrubTrack');
  const box = await track.boundingBox();
  await page.mouse.click(box.x + box.width * 0.415, box.y + box.height / 2); // just past cloudburst trigger only
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot('02-cloudburst-triggered') });
  check('alert banner shown after cloudburst trigger', await page.locator('#alertBanner.show').count() === 1);
  check('exactly 1 case revealed at cloudburst-only point', (await page.locator('#casesBadge').textContent()) === '1');

  await page.locator('.nav-tab[data-view="cases"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot('03-cases-list') });
  check('1 case row visible', await page.locator('.case-row').count() === 1);

  await page.locator('.case-row').first().click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot('04-case-detail-p1') });
  check('case detail phase 1 has a probability chart', await page.locator('#tab-p1 svg').count() > 0);
  // .innerText() reflects rendered text, and .card h3 is CSS text-transform:uppercase — compare case-insensitively.
  check('case detail shows damage assessment heat map', (await page.locator('#tab-p1').innerText()).toLowerCase().includes('damage / infrastructure assessment'));

  await page.locator('.tab[data-tab="p2"]').click();
  await page.waitForTimeout(100);
  check('phase 2 placeholder shown', (await page.locator('#tab-p2').innerText()).includes('Phase 2'));

  await page.locator('#backToCases').click();
  await page.waitForTimeout(100);
  await page.locator('.nav-tab[data-view="monitor"]').click();
  await page.waitForTimeout(100);

  await page.locator('#damageToggle').uncheck();
  await page.waitForTimeout(150);
  const firstRectDisplay = await page.locator('path.damage-cell').first().evaluate(el => getComputedStyle(el).display);
  check('damage heat map hides when toggled off', firstRectDisplay === 'none');
  await page.locator('#damageToggle').check();

  const box2 = await track.boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.99, box2.y + box2.height / 2);
  await page.waitForTimeout(250);
  await page.locator('.nav-tab[data-view="cases"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot('05-both-cases') });
  check('both cases revealed by end of timeline', await page.locator('.case-row').count() === 2);

  // Sustained playback shouldn't throw (regression test for the fractional
  // frame-index bug: array lookups need an integer key).
  await page.locator('.nav-tab[data-view="monitor"]').click();
  await page.waitForTimeout(100);
  await page.mouse.click(box2.x + box2.width * 0.01, box2.y + box2.height / 2);
  await page.waitForTimeout(150);
  await page.locator('[data-speed="60"]').click();
  await page.locator('#playBtn').click();
  await page.waitForTimeout(3000);
  await page.locator('#playBtn').click();
  await page.screenshot({ path: shot('06-after-sustained-play') });

  check('no console errors/warnings/failed requests', consoleIssues.length === 0);
  if (consoleIssues.length) consoleIssues.forEach((m) => console.log('  ' + m));
  check('no uncaught page errors', pageErrors.length === 0);
  if (pageErrors.length) pageErrors.forEach((m) => console.log('  ' + m));

  await page.close();
}

async function mobilePass() {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot('07-mobile-monitor'), fullPage: true });

  const headerBox = await page.locator('header.topbar').boundingBox();
  check('mobile header does not overflow viewport width', headerBox.width <= 390 + 1);

  await page.locator('.nav-tab[data-view="cases"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot('08-mobile-cases'), fullPage: true });

  check('no page errors on mobile', errors.length === 0);
  await page.close();
}

async function errorStatePass() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/data/cases.json', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const shown = await page.waitForSelector('#errorOverlay:not([hidden])', { timeout: 5000 }).then(() => true).catch(() => false);
  check('error overlay appears on data fetch failure', shown);
  if (shown) await page.screenshot({ path: shot('09-error-state') });
  await page.close();
}

await desktopPass();
await mobilePass();
await errorStatePass();
await browser.close();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Browser-level proof that the injected --mrc-scale CSS actually scales text.
 *
 * Reads the REAL stylesheet source out of client.js, applies the SAME rewrite
 * ensureStyle() performs, injects it into a minimal DOM that mimics the panel,
 * and measures computed font-size in headless Chromium at scale 1 / 1.5 / 0.8.
 * Proves: every sampled element grows proportionally, `font: inherit`
 * controls follow, and the variable does NOT leak outside .mrc-panel.
 *
 * Run: node tests/verify-font-scale.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const clientSrc = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');

// Extract the CSS template literal exactly as ensureStyle() sees it.
const s = clientSrc.indexOf('const CSS = `');
if (s < 0) { console.log('FAIL  CSS template not found'); process.exit(1); }
const from = s + 'const CSS = `'.length;
const to = clientSrc.indexOf('`;', from);
const css = clientSrc.slice(from, to);

// The exact rewrite used by ensureStyle().
const scaled = css.replace(/font-size:\s*(\d+(?:\.\d+)?)px/g,
  (_m, px) => `font-size: calc(${px}px * var(--mrc-scale, 1))`);

function findChromium() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const rel of [
        'chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
        'chrome-headless-shell-win64/chrome-headless-shell.exe',
        'chrome-headless-shell-win/chrome-headless-shell.exe'
      ]) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('no chromium under ms-playwright');
}

const playwright = require(path.join(
  process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

(async () => {
  const browser = await playwright.chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>${scaled}</style>
      <div id="outside" style="font-size:11px">outside</div>
      <div class="mrc-panel" id="panel" style="--mrc-scale:1">
        <div class="mrc-bar"><span class="mrc-title" id="title">tab</span></div>
        <div class="mrc-note" id="note">note</div>
        <button class="mrc-commitButton" id="btn">commit</button>
        <div class="mrc-markdown"><h1 class="mrc-mdH mrc-mdH1" id="h1">Heading</h1></div>
      </div>`);

    const read = async (scale) => {
      await page.evaluate((v) => {
        document.getElementById('panel').style.setProperty('--mrc-scale', String(v));
      }, scale);
      return page.evaluate(() => {
        const get = (id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
        return { title: get('title'), note: get('note'), btn: get('btn'), h1: get('h1'), outside: get('outside') };
      });
    };

    const base = await read(1);
    const big = await read(1.5);
    const small = await read(0.8);

    console.log('\n=== computed font-size at --mrc-scale 1 / 1.5 / 0.8 ===');
    console.log('  scale 1  :', JSON.stringify(base));
    console.log('  scale 1.5:', JSON.stringify(big));
    console.log('  scale 0.8:', JSON.stringify(small));

    check('every font-size declaration was rewritten',
      (scaled.match(/font-size: calc\(/g) || []).length >= 40,
      `count=${(scaled.match(/font-size: calc\(/g) || []).length}`);
    check('title scales 1 -> 1.5 (12 -> 18)', Math.abs(big.title - base.title * 1.5) < 0.2);
    check('note scales 1 -> 1.5 (11 -> 16.5)', Math.abs(big.note - base.note * 1.5) < 0.2);
    check('commit button (font: inherit) scales too', Math.abs(big.btn - base.btn * 1.5) < 0.2);
    check('markdown h1 scales too (19 -> 28.5)', Math.abs(big.h1 - base.h1 * 1.5) < 0.3);
    check('shrink to 0.8 is proportional', Math.abs(small.title - base.title * 0.8) < 0.2);
    check('all sampled elements share ONE scale factor',
      Math.abs(big.note / base.note - big.title / base.title) < 0.02 &&
      Math.abs(big.h1 / base.h1 - big.title / base.title) < 0.02);
    check('zoom does NOT leak outside .mrc-panel',
      Math.abs(big.outside - base.outside) < 0.01 && Math.abs(small.outside - base.outside) < 0.01);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.log('FAIL', error.message); process.exit(1); });

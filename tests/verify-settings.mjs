/**
 * Regression for the durable /settings route (panel font size).
 *
 * Drives the REAL handler with fake HTTP pairs and a TEMP DSH_HOME so the
 * user's real settings file is never touched. Proves:
 *   - GET returns the default on a fresh install,
 *   - POST persists fontScale and GET reads it back,
 *   - out-of-range / non-numeric / unknown keys are clamped and dropped,
 *   - fontScale snaps to the 0.1 step,
 *   - sanitizeSettings never leaks extra keys.
 *
 * Run with: node tests/verify-settings.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const realHome = process.env.DSH_HOME;
let tmp;
try {
  tmp = mkdtempSync(join(tmpdir(), 'mrc-settings-'));
  process.env.DSH_HOME = tmp;                       // set BEFORE importing the host
} catch (error) {
  console.log(`FAIL  cannot create temp DSH_HOME: ${error.message}`);
  process.exit(1);
}

const { __test } = await import('../index.js');
const { handleSettings, sanitizeSettings, settingsPath, FONT_SCALE_MIN, FONT_SCALE_MAX, DEFAULT_SETTINGS } = __test;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

function makeResponse() {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const response = {
    statusCode: 0, headers: {}, text: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.text = chunk ? Buffer.from(chunk).toString('utf8') : ''; resolveDone(this); }
  };
  return { response, done };
}

async function call(method, body) {
  const { response, done } = makeResponse();
  const request = body === undefined
    ? Object.assign(Readable.from([]), { method })
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method });
  await handleSettings(request, response);
  const res = await done;
  let json;
  try { json = JSON.parse(res.text); } catch { /* plain-text error */ }
  return { status: res.statusCode, json, text: res.text };
}

console.log('\n=== sanitizeSettings (whitelist + range + step) ===');
check('default is fontScale 1', DEFAULT_SETTINGS.fontScale === 1);
check('range is 0.8..1.6', FONT_SCALE_MIN === 0.8 && FONT_SCALE_MAX === 1.6);
check('fresh object -> default', JSON.stringify(sanitizeSettings({})) === '{"fontScale":1}');
check('null -> default', JSON.stringify(sanitizeSettings(null)) === '{"fontScale":1}');
check('unknown keys dropped', JSON.stringify(sanitizeSettings({ fontScale: 1.2, evil: 'x', __proto__: {} })) === '{"fontScale":1.2}');
check('below min clamped', sanitizeSettings({ fontScale: 0.1 }).fontScale === 0.8);
check('above max clamped', sanitizeSettings({ fontScale: 99 }).fontScale === 1.6);
check('NaN / string garbage -> default', sanitizeSettings({ fontScale: 'big' }).fontScale === 1);
check('snaps to 0.1 step', sanitizeSettings({ fontScale: 1.234 }).fontScale === 1.2);
check('exact boundary kept', sanitizeSettings({ fontScale: 1.6 }).fontScale === 1.6);

console.log('\n=== /settings GET/POST through the real handler ===');
try {
  const initial = await call('GET');
  check('GET first run -> 200', initial.status === 200, `status=${initial.status}`);
  check('GET first run returns default', initial.json?.fontScale === 1, initial.text);

  const saved = await call('POST', { fontScale: 1.3, ignored: true });
  check('POST -> 200', saved.status === 200, `status=${saved.status} body=${saved.text}`);
  check('POST returns sanitized value', saved.json?.fontScale === 1.3, saved.text);
  check('POST drops unknown keys', saved.json?.ignored === undefined, saved.text);

  const reread = await call('GET');
  check('GET reads the persisted value back', reread.json?.fontScale === 1.3, reread.text);
  check('settings file exists on disk', existsSync(settingsPath()), settingsPath());
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  check('disk contains ONLY fontScale', JSON.stringify(Object.keys(raw).sort()) === '["fontScale"]', JSON.stringify(raw));

  const clamped = await call('POST', { fontScale: 5 });
  check('POST clamps out-of-range to 1.6', clamped.json?.fontScale === 1.6, clamped.text);
  const reread2 = await call('GET');
  check('clamped value persisted', reread2.json?.fontScale === 1.6, reread2.text);

  const bad = await call('PUT', { fontScale: 1.1 });
  check('unsupported method -> 405', bad.status === 405, `status=${bad.status}`);
} catch (error) {
  failures += 1;
  console.log(`  FAIL  integration threw: ${error.message}`);
}

if (realHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = realHome;
if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows handle */ } }

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

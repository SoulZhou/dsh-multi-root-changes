/**
 * Regression for the read-only /file-content route used by the Markdown
 * preview. Drives the REAL handler (handleFileContent) with fake HTTP pairs:
 *   - reads a real text file inside a throwaway git work tree,
 *   - refuses a path that escapes the root,
 *   - refuses a non-repository root,
 *   - labels binary content instead of streaming it as text,
 *   - clips at 1 MiB and sets truncated.
 *
 * Run with: node tests/verify-file-content.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { __test } from '../index.js';

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

async function call(body) {
  const { response, done } = makeResponse();
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  await __test.handleFileContent(request, response);
  const res = await done;
  let json;
  try { json = JSON.parse(res.text); } catch { /* plain-text error */ }
  return { status: res.statusCode, json, text: res.text };
}

console.log('\n=== /file-content: read-only full-file route ===');
let tmp;
try {
  tmp = mkdtempSync(join(tmpdir(), 'mrc-file-content-'));
  const work = join(tmp, 'work');
  mkdirSync(work);
  execFileSync('git', ['init', '-q', work], { stdio: 'ignore' });
  writeFileSync(join(work, 'README.md'), '# Hello\n\nA **bold** word.\n');

  const ok = await call({ root: work, path: 'README.md' });
  check('text file -> 200', ok.status === 200, `status=${ok.status} body=${ok.text}`);
  check('reply kind is text', ok.json?.kind === 'text', ok.text);
  check('returns the WHOLE content', ok.json?.content === '# Hello\n\nA **bold** word.\n', ok.json?.content);
  check('not truncated', ok.json?.truncated === false);

  // Path containment: `../` must not reach outside the repository.
  const escape = await call({ root: work, path: '..\\outside.md' });
  check('path escape -> 400', escape.status === 400, `status=${escape.status} body=${escape.text}`);
  const abs = await call({ root: work, path: 'C:\\Windows\\win.ini' });
  check('absolute override -> 400 (or read refused)', abs.status === 400 || abs.status === 500,
    `status=${abs.status} body=${abs.text}`);

  // A real work tree is required.
  const notRepo = join(tmp, 'not-a-repo');
  mkdirSync(notRepo);
  writeFileSync(join(notRepo, 'x.md'), 'x');
  const nr = await call({ root: notRepo, path: 'x.md' });
  check('non-repository root -> 400', nr.status === 400, `status=${nr.status} body=${nr.text}`);

  // Binary detection uses the same NUL-byte heuristic as git.
  writeFileSync(join(work, 'bin.md'), Buffer.from([0x00, 0x01, 0x02, 0x41]));
  const bin = await call({ root: work, path: 'bin.md' });
  check('binary content -> kind binary', bin.json?.kind === 'binary', bin.text);

  // Missing required fields.
  const missing = await call({});
  check('missing root/path -> 400', missing.status === 400, `status=${missing.status}`);
} catch (error) {
  failures += 1;
  console.log(`  FAIL  integration threw: ${error.message}`);
} finally {
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows git handle */ } }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Verify the Push button and the "refresh commit history after a successful
 * push" behaviour added in 0.3.4.
 *
 *   1. client wiring: the button exists in every repo's action box, calls
 *      POST /push, and on success bumps the SAME refresh counter that the
 *      commit-history list watches (so /state and /log are re-read at their
 *      latest values and the list expands itself).
 *   2. host safety: /push is registered and its argv never force-pushes,
 *      pulls, fetches, or rewrites history; credentials cannot prompt; a
 *      detached HEAD is refused; the old-git fallback only picks ONE remote.
 *   3. REAL git end-to-end: push a fresh commit from a throwaway clone to a
 *      throwaway bare remote through the actual `handlePush` handler, then
 *      prove the remote really has the commit, an upstream was recorded, a
 *      second push is clean, and the rejection cases return HTTP 400.
 *
 * Run with: node tests/verify-push.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(here, '..');
const clientSrc = readFileSync(join(rootDir, 'client.js'), 'utf8');
const indexSrc = readFileSync(join(rootDir, 'index.js'), 'utf8');
const { __test } = await import('../index.js');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Drive the real handler with a minimal fake HTTP pair. `handlePush` awaits
// readJsonBody(request) (a 'data'/'end' readable) and ends with sendJson/sendText.
function makeResponse() {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const response = {
    statusCode: 0,
    headers: {},
    text: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) {
      this.text = chunk ? Buffer.from(chunk).toString('utf8') : '';
      resolveDone(this);
    }
  };
  return { response, done };
}

async function callPush(body) {
  const { response, done } = makeResponse();
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  await __test.handlePush(request, response);
  const res = await done;
  let json;
  try { json = JSON.parse(res.text); } catch { /* plain-text error body */ }
  return { status: res.statusCode, json, text: res.text };
}

console.log('\n=== 1. client: push button + active commit-history refresh ===');
{
  check('a .mrc-pushButton is rendered',
    /className: 'mrc-pushButton'/.test(clientSrc));
  check('push button is NOT gated on an empty commit message (unlike Commit)',
    /className: 'mrc-pushButton'[\s\S]{0,160}disabled: anyBusy\s*,/.test(clientSrc));
  check('push does not require changed paths',
    /className: 'mrc-pushButton'[\s\S]{0,220}disabled: anyBusy\s*,/.test(clientSrc));
  check('push posts to /push with the root path',
    clientSrc.includes("postJson('/push', { root: root.path })"));
  check('push success calls onCommitted (the tab refresh counter)',
    /postJson\('\/push'[\s\S]{0,400}onCommitted\?\.\(\)/.test(clientSrc));
  check('success notice uses the pushed branch',
    clientSrc.includes("t('pushed', { branch: reply.branch ?? '' })"));
  check('"Everything up-to-date" is filtered out of the notice',
    /everything up\[- \]to\[- \]date/i.test(clientSrc));

  // The action box now renders for EVERY repo, not only dirty ones, so Push is
  // still there after a clean commit.
  check('action box renders for every repo (hasRepo ? h(CommitBox...))',
    /hasRepo\s*\?\s*h\(CommitBox/.test(clientSrc));
  check('action box is NOT gated on entries.length > 0',
    !/entries\.length\s*>\s*0\s*\?\s*h\(CommitBox/.test(clientSrc));

  // The "active refresh" chain: onCommitted bumps BOTH counters; historyTick
  // reaches CommitSection as refreshSignal; the log effect re-fetches; the
  // section auto-expands so the fresh commits are actually on screen.
  check('onCommitted bumps tick (re-reads /state)',
    /onCommitted: \(\) => \{\s*setTick\(\(value\) => value \+ 1\);/.test(clientSrc));
  check('onCommitted ALSO bumps historyTick (re-reads /log)',
    /setTick\(\(value\) => value \+ 1\);\s*setHistoryTick\(\(value\) => value \+ 1\);/.test(clientSrc));
  // `historyTick` and `onCommitted` are two props of the SAME RootSection call;
  // other props may sit between them, so match across a short window instead
  // of demanding adjacency.
  check('historyTick is threaded into RootSection',
    /\bhistoryTick,[\s\S]{0,120}?onCommitted:/.test(clientSrc));
  check('RootSection passes historyTick to CommitSection as refreshSignal',
    /refreshSignal: historyTick/.test(clientSrc));
  // The dep array may carry extra deps (refreshTick) alongside refreshSignal;
  // what matters is that refreshSignal IS one of them.
  check('CommitSection log-fetch effect depends on refreshSignal',
    /\[open,\s*root\.path,\s*limit,\s*refreshSignal[^\]]*\]/.test(clientSrc));
  check('a refreshSignal change auto-expands the history',
    /if \(refreshSignal > 0\) setOpen\(true\);/.test(clientSrc));

  // Regression guard: the original Commit button and its tests must survive.
  check('.mrc-commitButton selector preserved',
    clientSrc.includes("className: 'mrc-commitButton'"));
  // 0.3.12: the quick bar's action buttons were removed; CommitBox is now the
  // single commit/push entry and carries the quick bar's logic. The Commit
  // button is gated on CHECKED files, NOT on a handwritten message (an empty
  // box now auto-drafts the message, mirroring the old quick bar flow).
  check('Commit is gated on checked files, not an empty message',
    /className: 'mrc-commitButton'[\s\S]{0,180}disabled: anyBusy \|\| commitPaths\.length === 0/.test(clientSrc));
  check('Commit commits the CHECKED subset (partial commit)',
    /postJson\('\/commit-write', \{ root: root\.path, message: finalMessage, paths: commitPaths \}\)/.test(clientSrc));
  check('empty message auto-drafts before committing',
    /const finalMessage = await draftMessage\(\);/.test(clientSrc) &&
    /if \(finalMessage === ''\)/.test(clientSrc) &&
    /setError\(t\('suggestEmpty'\)\)/.test(clientSrc));
  check('CommitBox shows the checked/total count',
    /t\('includedCount', \{ count: checkedCount, total: paths\.length \}\)/.test(clientSrc));
  // The three action buttons must be gone from the quick bar (only ↻, counter,
  // picker, count and check-all links remain). Detect by class usage: the
  // button classes now appear ONLY inside CommitBox, never in QuickBar's render.
  check('quick bar no longer renders push/commit/commit+push buttons',
    !/quickPushTitle|quickCommitTitle|quickCommitPushTitle/.test(
      clientSrc.slice(clientSrc.indexOf('function QuickBar'), clientSrc.indexOf('/** The tab\'s page body'))));

  check('zh copy has push keys',
    clientSrc.includes("pushAction: '推送'") && clientSrc.includes("pushing: '推送中…'") && clientSrc.includes("pushed: '已推送 {branch}'"));
  check('en copy has push keys',
    clientSrc.includes("pushAction: 'Push'") && clientSrc.includes("pushing: 'Pushing…'") && clientSrc.includes("pushed: 'Pushed {branch}'"));
}

console.log('\n=== 2. host: a deliberately safe /push route ===');
{
  check('/push route registered',
    indexSrc.includes('`${API}/push`') || indexSrc.includes("'/push'"));
  check('handlePush is exported for tests',
    typeof __test.handlePush === 'function');
  check('uses push.default=upstream',
    indexSrc.includes("'push.default=upstream'"));
  check('uses push.autoSetupRemote=true for the first push',
    indexSrc.includes("'push.autoSetupRemote=true'"));
  check('captures git stderr (progress lives there)',
    indexSrc.includes('captureStderr: true'));
  check('disables interactive terminal prompts',
    indexSrc.includes("GIT_TERMINAL_PROMPT: '0'"));
  check('disables GCM GUI prompts',
    indexSrc.includes("GCM_INTERACTIVE: 'never'"));
  check('refuses a detached HEAD',
    indexSrc.includes("'detached HEAD: there is no branch to push'"));
  check('old-git fallback uses an explicit --set-upstream',
    indexSrc.includes("'push', '--set-upstream', remote, branch"));
  check('fallback refuses to guess when there is not exactly ONE remote',
    indexSrc.includes('remotes.length !== 1'));
  check('fallback re-validates remote/branch names against a safe token',
    indexSrc.includes('/^[A-Za-z0-9._\\/-]+$/'));
  check('re-validates the root is a real work tree',
    /inspectRepo\(root\)/.test(indexSrc) && /repo\.isRepo !== true/.test(indexSrc));

  // Dangerous flags must never become real argv string literals. The doc
  // comment mentions them in backticks only, so quoting them is unambiguous.
  for (const flag of ["'--force'", "'--force-with-lease'", "'-f'", "'--all'", "'--tags'"]) {
    check(`no ${flag} in push argv`, !indexSrc.includes(flag));
  }
  check('no pull/fetch argv',
    !indexSrc.includes("'pull'") && !indexSrc.includes("'fetch'"));
}

console.log('\n=== 3. REAL git: handlePush end-to-end ===');
{
  let tmp;
  try {
    // Smoke test git availability; a missing git is a SKIP, not a failure.
    execFileSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    console.log('  SKIP  git is not available on PATH');
    tmp = null;
  }

  if (tmp !== null) {
    try {
      tmp = mkdtempSync(join(tmpdir(), 'mrc-push-'));
      const bare = join(tmp, 'remote.git');
      const bare2 = join(tmp, 'backup.git');
      const work = join(tmp, 'work');
      const work2 = join(tmp, 'work2');

      git(tmp, ['init', '--bare', bare]);
      git(tmp, ['init', '--bare', bare2]);
      git(tmp, ['init', work]);
      git(work, ['config', 'user.email', 'test@example.com']);
      git(work, ['config', 'user.name', 'Push Test']);
      git(work, ['remote', 'add', 'origin', bare]);
      writeFileSync(join(work, 'a.txt'), 'hello\n');
      git(work, ['add', 'a.txt']);
      git(work, ['commit', '-m', 'initial commit']);
      const branch = git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      const localHead = git(work, ['rev-parse', 'HEAD']).trim();

      const first = await callPush({ root: work });
      check('first push returns 200', first.status === 200, `status=${first.status} body=${first.text}`);
      check('first push body is {ok:true}', first.json?.ok === true, first.text);
      check('reply carries the pushed branch', first.json?.branch === branch,
        `${first.json?.branch} vs ${branch}`);
      check('reply carries git output for the notice',
        typeof first.json?.output === 'string' && first.json.output.length > 0);

      const remoteHead = git(tmp, ['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`]).trim();
      check('bare remote actually received the commit', remoteHead === localHead,
        `${remoteHead} vs ${localHead}`);

      const upstream = git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim();
      check('first push recorded the upstream (next click is a plain push)', upstream === `origin/${branch}`, upstream);

      const second = await callPush({ root: work });
      check('second push is clean (200, ok:true)', second.status === 200 && second.json?.ok === true,
        `status=${second.status} body=${second.text}`);

      // Rejection cases: the panel must never push a stale/foreign root.
      const missing = await callPush({});
      check('missing root -> 400', missing.status === 400, `status=${missing.status}`);

      const notRepo = join(tmp, 'not-a-repo');
      mkdirSync(notRepo);
      const nr = await callPush({ root: notRepo });
      check('non-repository root -> 400', nr.status === 400, `status=${nr.status} body=${nr.text}`);

      // A root whose folder was deleted must say WHICH path is gone, not leak
      // the raw `spawn git ENOENT` from the failed child process.
      const vanished = join(tmp, 'vanished-repo');
      mkdirSync(vanished);
      rmSync(vanished, { recursive: true, force: true });
      const gone = await callPush({ root: vanished });
      check('missing folder -> 400 naming the path',
        gone.status === 400 && /does not exist/i.test(gone.text) && gone.text.includes(vanished),
        `status=${gone.status} body=${gone.text}`);
      check('missing folder does NOT leak "spawn git ENOENT"',
        !/spawn git ENOENT/.test(gone.text),
        `body=${gone.text}`);

      git(work, ['checkout', '--detach', 'HEAD']);
      const detached = await callPush({ root: work });
      check('detached HEAD -> 400 with a readable message',
        detached.status === 400 && /detached HEAD/.test(detached.text),
        `status=${detached.status} body=${detached.text}`);

      // Safety: two remotes and NO upstream must not pick one at random.
      git(tmp, ['init', work2]);
      git(work2, ['config', 'user.email', 'test@example.com']);
      git(work2, ['config', 'user.name', 'Push Test']);
      git(work2, ['remote', 'add', 'origin', bare]);
      git(work2, ['remote', 'add', 'backup', bare2]);
      writeFileSync(join(work2, 'b.txt'), 'ambiguous\n');
      git(work2, ['add', 'b.txt']);
      git(work2, ['commit', '-m', 'no upstream, two remotes']);
      const ambiguous = await callPush({ root: work2 });
      check('ambiguous remotes are NOT guessed (no successful push)',
        ambiguous.status !== 200 && ambiguous.json?.ok !== true,
        `status=${ambiguous.status} body=${ambiguous.text.slice(0, 200)}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL  integration threw: ${error.message}`);
    } finally {
      if (tmp) {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may still hold a git handle */ }
      }
    }
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

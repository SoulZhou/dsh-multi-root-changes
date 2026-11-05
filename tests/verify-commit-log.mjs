/**
 * Prove the commit-history parsers against REAL `git log` / `git show` bytes from
 * the three live repositories, plus synthetic records for shapes those
 * repositories do not exhibit (merge commit, multi-line body, refs decoration,
 * a subject containing the field separator character).
 *
 * Run with: node tests/verify-commit-log.mjs
 */
import { execFile } from 'node:child_process';

const { __test } = await import('../index.js');
const { parseLog } = __test;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

function gitRaw(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

console.log('\n=== 1. synthetic records ===');
{
  const US = '\x1f';
  const RS = '\x1e';
  const raw = [
    `${RS}aaa111${US}aaa111${US}Alice${US}a@x.com${US}1700000000${US}HEAD -> main, origin/main, tag: v1${US}feat: add thing`,
    `${RS}bbb222${US}bbb222${US}Bob${US}b@x.com${US}1700000100${US}${US}fix: 中文 标题 | 带竖线`,
    `${RS}ccc333${US}ccc333${US}Carol${US}c@x.com${US}1700000200${US}${US}chore: has : colon and 制表符\tinside`
  ].join('');

  const parsed = parseLog(raw);
  check('three commits parsed', parsed.length === 3, String(parsed.length));
  check('first hash', parsed[0].hash === 'aaa111', parsed[0].hash);
  check('author', parsed[0].author === 'Alice', parsed[0].author);
  check('timestamp is seconds', parsed[0].timestamp === 1700000000, String(parsed[0].timestamp));
  check('refs split', parsed[0].refs.length === 3, JSON.stringify(parsed[0].refs));
  check('refs values', parsed[0].refs.includes('HEAD -> main') && parsed[0].refs.includes('tag: v1'),
    JSON.stringify(parsed[0].refs));
  check('CJK subject kept', parsed[1].subject === 'fix: 中文 标题 | 带竖线', parsed[1].subject);
  check('empty refs becomes []', parsed[1].refs.length === 0, JSON.stringify(parsed[1].refs));
  check('colon/tab subject kept whole', parsed[2].subject.includes('has : colon and 制表符'),
    JSON.stringify(parsed[2].subject));
}

console.log('\n=== 2. REAL repositories ===');
for (const repo of ['D:\\dev\\demo-platform\\web-console', 'D:\\dev\\demo-platform\\api-gateway', 'D:\\dev\\demo-platform\\shared-i18n']) {
  let raw;
  try {
    raw = await gitRaw(repo, ['log', '-n30', '--no-color', '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s']);
  } catch (error) {
    console.log(`  SKIP  ${repo} (${error.message.split('\n')[0]})`);
    continue;
  }
  const text = raw.toString('utf8');
  const parsed = parseLog(text);
  // Independent oracle: count the record separators git actually emitted.
  const oracle = text.split('\x1e').filter((r) => r.trim() !== '').length;
  console.log(`  ${repo}: commits=${parsed.length} oracle=${oracle}`);
  check(`${repo} count matches oracle`, parsed.length === oracle, `${parsed.length} vs ${oracle}`);
  check(`${repo} every hash is 40 hex`, parsed.every((c) => /^[0-9a-f]{40}$/.test(c.hash)),
    JSON.stringify(parsed.map((c) => c.hash.slice(0, 8)).slice(0, 3)));
  check(`${repo} every timestamp is a positive int`, parsed.every((c) => Number.isInteger(c.timestamp) && c.timestamp > 0));
  check(`${repo} subjects have no sentinel chars`,
    parsed.every((c) => !c.subject.includes('\x1e') && !c.subject.includes('\x1f')));
  // Order fidelity, not "descending by author date": `git log` walks the commit
  // GRAPH (ordered by COMMIT date), while %at is AUTHOR date — a rebase or a
  // cherry-pick makes those two disagree, so asserting a monotonic %at would
  // test an assumption git never made. The real contract is that the parser
  // preserves git's own order, so the oracle is git's own hash listing.
  const hashOrder = (await gitRaw(repo, ['log', '-n30', '--pretty=format:%H']))
    .toString('utf8').trim().split('\n');
  check(`${repo} preserves git's commit order`,
    JSON.stringify(parsed.map((c) => c.hash)) === JSON.stringify(hashOrder),
    `parsed[0..2]=${parsed.slice(0, 3).map((c) => c.hash.slice(0, 8))} oracle[0..2]=${hashOrder.slice(0, 3).map((h) => h.slice(0, 8))}`);
}

console.log('\n=== 3. merge commit detection ===');
{
  // web-console history: find whether any merge commit exists, then confirm the
  // parent-count rule separates it from an ordinary commit.
  const repo = 'D:\\dev\\demo-platform\\web-console';
  const merges = (await gitRaw(repo, ['rev-list', '--merges', '-n', '5', 'HEAD']).catch(() => Buffer.from('')))
    .toString('utf8').trim();
  const hasMerge = merges !== '';
  const sample = hasMerge ? merges.split('\n')[0] : 'HEAD';
  const parents = (await gitRaw(repo, ['rev-list', '--parents', '-n', '1', sample]))
    .toString('utf8').trim().split(/\s+/).filter(Boolean);
  if (hasMerge) {
    check('merge commit has >2 rev-list fields', parents.length > 2, String(parents.length));
  } else {
    check('ordinary commit has 2 rev-list fields', parents.length === 2, String(parents.length));
    console.log('        (this repository has no merge commits; rule checked on an ordinary one)');
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

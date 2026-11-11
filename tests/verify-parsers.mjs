/**
 * Parser proof against REAL `git status --porcelain=v2 --branch -z` bytes taken
 * from the three live repositories, plus synthetic records for the shapes those
 * repositories do not currently exhibit (rename, conflict, detached HEAD, CJK
 * and spaces in paths).
 *
 * Run with: node tests/verify-parsers.mjs
 */
import { execFile } from 'node:child_process';

const { __test } = await import('../index.js');
const { parsePorcelainV2, parseNumstat, splitFixed } = __test;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

/** Run one git command and return raw stdout as a Buffer. */
function gitRaw(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

console.log('\n=== 1. splitFixed keeps spaced paths whole ===');
{
  const path = 'a b/new name.java';
  const fields = splitFixed(`.M N... 100644 100644 100644 aaa bbb ${path}`, 7);
  check('seven fixed fields then the whole path', fields.length === 8 && fields[7] === path, JSON.stringify(fields));
}

console.log('\n=== 2. synthetic porcelain v2 records ===');
{
  const NUL = '\0';
  // A rename's original path is its OWN NUL field, immediately after the record.
  const renamed = [
    '# branch.oid abc123',
    '# branch.head master',
    '# branch.upstream origin/master',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 111 222 src/modified.java',
    '2 R. N... 100644 100644 100644 333 444 R100 中文 目录/新 名字.txt',
    'a b/old name.txt',
    '? libs/shared-i18n-1.9.0.aar',
    'u AA N... 000000 100644 100644 100644 555 666 777 src/conflict.txt',
    ''
  ].join(NUL);

  const parsed = parsePorcelainV2(renamed);
  check('branch name', parsed.branch === 'master', parsed.branch);
  check('ahead/behind', parsed.ahead === 2 && parsed.behind === 3, `${parsed.ahead}/${parsed.behind}`);
  // Four ENTRIES: modified, rename, untracked, conflict. The rename's origPath
  // is a field of the rename, not an entry of its own — that is the whole point
  // of the state machine.
  check('four entries (origPath is not an entry)', parsed.entries.length === 4, String(parsed.entries.length));

  const modified = parsed.entries.find((e) => e.path === 'src/modified.java');
  check('modified path is not a hash', modified !== undefined && modified.x === '.' && modified.y === 'M',
    JSON.stringify(modified));

  const rename = parsed.entries.find((e) => e.origPath === 'a b/old name.txt');
  check('rename keeps CJK + spaces, origPath consumed', rename !== undefined && rename.path === '中文 目录/新 名字.txt',
    JSON.stringify(rename));
  check('rename is ONE entry, not two', parsed.entries.filter((e) => e.path.includes('名字')).length === 1);

  const untracked = parsed.entries.find((e) => e.untracked === true);
  check('untracked file-level path', untracked !== undefined && untracked.path === 'libs/shared-i18n-1.9.0.aar',
    JSON.stringify(untracked));

  const conflict = parsed.entries.find((e) => e.conflict === true);
  check('conflict path', conflict !== undefined && conflict.path === 'src/conflict.txt', JSON.stringify(conflict));
}

console.log('\n=== 3. numstat including binary ===');
{
  const counts = parseNumstat('12\t3\tsrc/a.java\n-\t-\tres/logo.png\n0\t0\tsrc/crlf.txt\n');
  check('text counts', counts.get('src/a.java')?.additions === 12 && counts.get('src/a.java')?.deletions === 3);
  check('binary flagged with 0/0', counts.get('res/logo.png')?.binary === true);
  check('0/0 recorded as-is', counts.get('src/crlf.txt')?.additions === 0);
}

console.log('\n=== 4. REAL repositories ===');
// The live repositories to exercise are supplied by the caller, so this script
// never carries anyone's project layout. `MRC_TEST_REPOS` is a
// path-separator-separated list; an unset value simply skips the section.
const testRepos = (process.env.MRC_TEST_REPOS ?? '')
  .split(/[;]/)
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '');
for (const repo of testRepos) {
  let raw;
  try {
    raw = await gitRaw(repo, ['-c', 'core.quotepath=false', '--no-pager', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  } catch (error) {
    console.log(`  SKIP  ${repo} (${error.message.split('\n')[0]})`);
    continue;
  }

  // Independent oracle: count records the same way git emits them.
  const text = raw.toString('utf8');
  const oracleEntries = text.split('\0').filter((r) => r !== '' && r[0] !== '#').length
    // Each rename's origPath is a field of its own, so subtract those.
    - (text.split('\0').filter((r) => r.startsWith('2 ')).length);

  const parsed = parsePorcelainV2(text);
  console.log(`  ${repo}: branch=${parsed.branch} entries=${parsed.entries.length} oracle=${oracleEntries} truncated=${parsed.truncated}`);
  check(`${repo} entry count matches oracle`, parsed.entries.length === oracleEntries,
    `parsed=${parsed.entries.length} oracle=${oracleEntries}`);
  check(`${repo} has a branch name`, typeof parsed.branch === 'string' && parsed.branch.length > 0, parsed.branch);
  check(`${repo} no entry path looks like a hash`, parsed.entries.every((e) => !/^[0-9a-f]{40}$/.test(e.path)),
    JSON.stringify(parsed.entries.slice(0, 3)));
  check(`${repo} no path contains a NUL or newline`, parsed.entries.every((e) => !e.path.includes('\0') && !e.path.includes('\n')));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

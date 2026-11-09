/**
 * Host half of dsh-multi-root-changes.
 *
 * Why this plugin exists: DSH's built-in "Changes / Git" panel (and the one
 * dsh-better-sidebar draws) resolves repositories by scanning DOWNWARD from the
 * session's working directory. A very common layout — several sibling checkouts
 * (`F:\demo-platform\api-gateway`, `F:\demo-platform\shared-i18n`, …) beside the primary
 * project — is therefore invisible: those repositories are not under the
 * session cwd, so the panel can only ever show the primary project's changes.
 *
 * This host half answers the question the panel could not: "for the session's
 * primary root AND every additional root registered through
 * @dsh-electron/dsh-plugin-multi-root-workspace, what has changed?" It runs one
 * `git status` per root and hands the client half a grouped, per-root view, plus
 * a per-file diff route so the change itself is readable without depending on
 * another plugin's git routes (those are pinned to the session cwd and would
 * resolve a sibling root to the wrong repository).
 *
 * Reads (`status` / `rev-parse` / `log` / `show` / `diff`) never touch the
 * repository. There are two explicit write paths: `/commit-write` stages a named
 * file list and creates a commit (the only `git add` / `git commit`), and
 * `/push` sends the current branch to its remote (the only network write). Push
 * never force-pushes, pulls, fetches or rewrites history; a first push records
 * the upstream tracking branch so later pushes are one click.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const API = '/dsh-multi-root-changes/api';

/** Per-root ceiling on reported entries (git itself is also asked to stop). */
const MAX_ENTRIES = 3000;
/** One git invocation's budget. A stalled mount must not hold the panel. */
const GIT_TIMEOUT_MS = 20_000;
/** A network push gets a longer leash, but still cannot hang the panel forever. */
const PUSH_TIMEOUT_MS = 120_000;
/** `git status` stdout ceiling (untracked-heavy trees can be large). */
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
/** `git diff` stdout ceiling. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** Untracked-file content ceiling (the "all added" rendering). */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** Additional roots one slot may report (matches the multi-root plugin's cap). */
const MAX_ADDITIONAL_ROOTS = 64;
/** Diff characters fed to the model when drafting a commit message. */
const SUGGEST_DIFF_LIMIT = 12_000;
/** Output budget of one commit-message draft. */
const SUGGEST_MAX_TOKENS = 512;
/**
 * Ceiling for one draft when the route cannot be pinned to a cheap reasoning
 * effort. `maxTokens` caps thinking AND visible text TOGETHER, so a model whose
 * only advertised effort is `high` (WorkBuddy's `hy4free`, for one) can spend
 * the entire 512-token budget deliberating and emit no text at all — surfacing
 * as "chunks seen: block-start, reasoning-delta". A reasoning model needs room
 * for both, so this budget applies only when such an effort was requested.
 */
const SUGGEST_MAX_TOKENS_REASONING = 4096;
/** Hard deadline of one draft (a stalled provider must not hang the panel). */
const SUGGEST_TIMEOUT_MS = 30_000;
/**
 * Deadline for a draft that has to reserve room for thinking. A reasoning
 * route can legitimately spend far longer before the first TEXT token arrives,
 * so keeping the 30-second deadline would convert the empty-message failure
 * into a timeout instead of fixing it.
 */
const SUGGEST_TIMEOUT_MS_REASONING = 120_000;
/** A commit message longer than this is almost certainly not a message. */
const MAX_COMMIT_MESSAGE_BYTES = 8 * 1024;

/**
 * Canonical reasoning-effort ordering, cheapest first. Only used to pick the
 * LOWEST effort a model advertises; ids outside this list cannot be ordered
 * against known ones, so they never outrank them. `max` is included because
 * some adapters (the WorkBuddy connector, for one) advertise it above `xhigh`.
 */
const REASONING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

function registryPath() {
  return join(dshHome(), 'storages', 'multi_root_workspace.json');
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(body);
}

function sendText(response, status, text) {
  const body = Buffer.from(text);
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  response.end(body);
}

function readBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('body too large');
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJsonBody(request, limit = 256 * 1024) {
  const raw = await readBody(request, limit);
  if (raw.length === 0) return {};
  const parsed = JSON.parse(raw.toString('utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** Platform-aware identity used only for comparing absolute roots. */
function pathIdentity(path) {
  const absolute = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/**
 * Resolve the `root` field of a write request into a real git work tree.
 *
 * A stale row in the registry (the folder was moved, renamed or deleted) must
 * produce a message the reader can act on. Spawning git in a missing directory
 * fails with the raw `spawn git ENOENT`, which says nothing about WHICH root
 * vanished — so the existence check comes first and names the path.
 *
 * Returns `{ ok: true, root }` or `{ ok: false, status, message }`.
 */
async function resolveWritableRoot(body) {
  const raw = typeof body.root === 'string' && body.root !== '' ? body.root : '';
  if (raw === '') return { ok: false, status: 400, message: 'root is required' };
  const root = resolve(raw);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return { ok: false, status: 400, message: `not a folder: ${root}` };
    }
  } catch {
    return { ok: false, status: 400, message: `folder does not exist: ${root}` };
  }
  const repo = await inspectRepo(root);
  if (repo.isRepo !== true) {
    return {
      ok: false,
      status: 400,
      message: repo.nestedIn !== undefined
        ? `this folder belongs to another repository: ${repo.nestedIn}`
        : (repo.error ?? 'not a git repository')
    };
  }
  return { ok: true, root };
}

/** The last path segment of either separator style. */
function baseName(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * Run one git command and resolve its stdout.
 *
 * Rejects with a message that names the command, so the panel can show WHY a
 * root produced nothing instead of silently dropping it — a missing git binary,
 * a directory that is not a repository and a locked index are three very
 * different things to the reader.
 */
function runGit(cwd, args, options = {}) {
  const { timeoutMs = GIT_TIMEOUT_MS, maxBytes = MAX_STATUS_BYTES, env, captureStderr } = options;
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '--no-pager', ...args],
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: maxBytes,
        encoding: 'buffer',
        // A push must never pop an interactive credential dialog: the panel has
        // no terminal to answer it, so git must fail fast with a readable error.
        ...(env !== undefined ? { env } : {})
      },
      (error, stdout, stderr) => {
        const stderrText = stderr && stderr.length > 0 ? stderr.toString('utf8') : '';
        if (error) {
          const detail = (stderrText !== '' ? stderrText : error.message).trim();
          const wrapped = new Error(detail || 'git failed');
          wrapped.gitArgs = args;
          wrapped.code = error.code;
          rejectRun(wrapped);
          return;
        }
        const stdoutText = stdout.toString('utf8');
        // `git push` writes its progress/reference lines to STDERR, not stdout.
        // Only the push route opts in, so every other caller keeps its string.
        resolveRun(captureStderr === true ? { stdout: stdoutText, stderr: stderrText } : stdoutText);
      }
    );
    child.on('error', rejectRun);
  });
}

/**
 * Split a porcelain-v2 record into its fixed leading fields plus the trailing
 * path. `count` is the number of leading fields to take; everything after them
 * is the path (which may itself contain spaces, so it is never re-split).
 */
function splitFixed(text, count) {
  const fields = [];
  let index = 0;
  for (let took = 0; took < count; took += 1) {
    const space = text.indexOf(' ', index);
    if (space === -1) {
      fields.push(text.slice(index));
      return fields;
    }
    fields.push(text.slice(index, space));
    index = space + 1;
  }
  fields.push(text.slice(index));
  return fields;
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * Records are NUL-terminated and paths are NOT quoted under `-z`, so a path
 * with spaces, CJK characters or backslashes arrives verbatim. A rename (`2`)
 * carries its original path as a SEPARATE NUL-terminated field immediately
 * after the record — that is why this walks an index instead of mapping each
 * chunk on its own.
 */
function parsePorcelainV2(raw) {
  const chunks = raw.split('\0');
  // The trailing NUL produces one empty tail chunk.
  if (chunks.length > 0 && chunks[chunks.length - 1] === '') chunks.pop();

  const entries = [];
  let branch;
  let oid;
  let upstream;
  let ahead = 0;
  let behind = 0;
  let truncated = false;

  for (let index = 0; index < chunks.length; index += 1) {
    const record = chunks[index];
    if (record === '') continue;
    const kind = record[0];

    if (kind === '#') {
      // `# branch.oid <sha>` / `# branch.head <name>` / `# branch.upstream <ref>`
      // / `# branch.ab +<ahead> -<behind>`
      const rest = record.slice(2);
      const space = rest.indexOf(' ');
      const key = space === -1 ? rest : rest.slice(0, space);
      const value = space === -1 ? '' : rest.slice(space + 1);
      if (key === 'branch.oid') oid = value;
      else if (key === 'branch.head') branch = value;
      else if (key === 'branch.upstream') upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    if (kind === '?') {
      if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
      entries.push({ path: record.slice(2), x: '?', y: '?', untracked: true });
      continue;
    }

    if (kind === '!') {
      // Ignored entries are not reported: `--ignored` is never passed, so this
      // branch only fires on a future flag change. Kept so the shape is total.
      continue;
    }

    if (kind === '1') {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — seven fixed fields, so
      // the path is the LAST element `splitFixed` returns. The last field is
      // taken positionally rather than by hand-counting destructuring slots:
      // one miscounted elision silently returns a hash as if it were a file
      // name.
      const fields = splitFixed(record.slice(2), 7);
      const path = fields[fields.length - 1];
      const xy = fields[0];
      if (path === undefined || xy === undefined || path === '') continue;
      if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
      entries.push({ path, x: xy[0], y: xy[1] });
      continue;
    }

    if (kind === '2') {
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` — eight fixed
      // fields (the rename score sits where `1` has its last hash).
      const fields = splitFixed(record.slice(2), 8);
      const path = fields[fields.length - 1];
      const xy = fields[0];
      if (path === undefined || xy === undefined || path === '') continue;
      // The original path of a rename/copy is the NEXT NUL field.
      const origPath = chunks[index + 1];
      if (origPath !== undefined) index += 1;
      if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
      entries.push({ path, origPath, x: xy[0], y: xy[1] });
      continue;
    }

    if (kind === 'u') {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — nine fixed
      // fields (a conflict carries THREE stage hashes).
      const fields = splitFixed(record.slice(2), 9);
      const path = fields[fields.length - 1];
      const xy = fields[0];
      if (path === undefined || xy === undefined || path === '') continue;
      if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
      entries.push({ path, x: xy[0], y: xy[1], conflict: true });
      continue;
    }
    // Unknown record kinds (future git) are skipped rather than guessed at.
  }

  return { entries, branch, oid, upstream, ahead, behind, truncated };
}

/**
 * Parse `git diff --numstat` output into a path → {additions, deletions} map.
 *
 * Binary files report `-` for both counts; they are recorded with 0/0 and a
 * `binary` flag so the client can label them instead of printing "+0 −0".
 */
function parseNumstat(text) {
  const counts = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const added = line.slice(0, firstTab);
    const deleted = line.slice(firstTab + 1, secondTab);
    const path = line.slice(secondTab + 1);
    if (path === '') continue;
    const binary = added === '-' || deleted === '-';
    counts.set(path, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary
    });
  }
  return counts;
}

/**
 * Read the multi-root registry and return the additional roots registered for
 * one primary root.
 *
 * The file is the plugin's own durable store (`$DSH_HOME/storages/
 * multi_root_workspace.json`), keyed by the PRIMARY root's absolute path. A
 * missing or unreadable file is not an error: it means "no additional roots",
 * which is exactly how DSH behaves without that plugin.
 */
async function readAdditionalRoots(primaryRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(registryPath(), 'utf8'));
  } catch {
    return { roots: [], registryFound: false };
  }
  const table = parsed?.tables?.roots;
  if (!table || typeof table !== 'object') return { roots: [], registryFound: false };

  const wanted = pathIdentity(primaryRoot);
  let bucket;
  for (const [key, value] of Object.entries(table)) {
    if (pathIdentity(key) === wanted) { bucket = value; break; }
  }
  if (!bucket || !Array.isArray(bucket.roots)) return { roots: [], registryFound: true };

  const roots = [];
  for (const row of bucket.roots) {
    if (roots.length >= MAX_ADDITIONAL_ROOTS) break;
    const path = typeof row?.path === 'string' && row.path !== '' ? row.path : row?.recordedPath;
    if (typeof path !== 'string' || path === '') continue;
    roots.push({
      path,
      aliasId: typeof row.aliasId === 'string' ? row.aliasId : undefined,
      // v0.1.13 stores the grant under `access` / `grant` depending on the
      // record's age; both spellings are surfaced as `access` and the client
      // only ever displays it.
      access: typeof row.access === 'string' ? row.access : (typeof row.grant === 'string' ? row.grant : undefined)
    });
  }
  return { roots, registryFound: true };
}

/**
 * Whether one root is a git work tree, and its real top level.
 *
 * `git rev-parse --show-toplevel` reports FORWARD slashes with an uppercased
 * drive letter (`D:/dev/demo-platform/api-gateway`), while the registry stores backslashes
 * (`F:\demo-platform\api-gateway`) — so the comparison goes through {@link pathIdentity}
 * (slash-normalized, case-insensitive on Windows), never string equality.
 */
async function inspectRepo(root) {
  try {
    const toplevel = (await runGit(root, ['rev-parse', '--show-toplevel'], { maxBytes: 64 * 1024 })).trim();
    if (toplevel === '') return { isRepo: false };
    if (pathIdentity(toplevel) !== pathIdentity(root)) {
      // `root` sits INSIDE another repository instead of being its own
      // checkout. Reporting the parent's status here would attribute one
      // repository's changes to a root that is not that repository.
      return { isRepo: false, nestedIn: toplevel };
    }
    return { isRepo: true, toplevel };
  } catch (error) {
    // "Not a repository" is an ordinary state a folder can be in, not a
    // failure: only a real problem (missing git, a locked index) keeps an
    // `error` the panel must surface verbatim.
    const message = error.message || '';
    if (/not a git repository|not a git work tree/i.test(message)) return { isRepo: false };
    return { isRepo: false, error: message };
  }
}

/** One root's complete read-only status reading. */
async function readRootStatus(root) {
  const repo = await inspectRepo(root);
  if (repo.isRepo !== true) {
    return {
      ...repo,
      entries: [],
      counts: {},
      branch: undefined,
      ahead: 0,
      behind: 0,
      truncated: false
    };
  }

  let raw;
  try {
    raw = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  } catch (error) {
    return {
      isRepo: true,
      toplevel: repo.toplevel,
      error: error.message,
      entries: [],
      counts: {},
      truncated: false
    };
  }

  const parsed = parsePorcelainV2(raw);

  // Line counts are a nicety: a numstat failure must cost only the numbers,
  // never the status answer itself.
  let staged = new Map();
  let unstaged = new Map();
  if (parsed.entries.length > 0) {
    try {
      const [unstagedText, stagedText] = await Promise.all([
        runGit(root, ['diff', '--numstat']).catch(() => ''),
        runGit(root, ['diff', '--cached', '--numstat']).catch(() => '')
      ]);
      unstaged = parseNumstat(unstagedText);
      staged = parseNumstat(stagedText);
    } catch { /* counts stay empty */ }
  }

  // Fold the two numstat readings onto the entries: each side keeps its own
  // numbers (a path changed on both sides is not one summed count).
  const counts = {};
  for (const entry of parsed.entries) {
    const stagedCount = staged.get(entry.path);
    const unstagedCount = unstaged.get(entry.path);
    if (stagedCount !== undefined || unstagedCount !== undefined) {
      counts[entry.path] = {
        ...(stagedCount !== undefined ? { staged: stagedCount } : {}),
        ...(unstagedCount !== undefined ? { unstaged: unstagedCount } : {})
      };
    }
  }

  return {
    isRepo: true,
    toplevel: repo.toplevel,
    // A detached HEAD reports the literal string `HEAD`; there is no branch to
    // name, and presenting "HEAD" as a branch would read as one.
    branch: parsed.branch === '(detached)' || parsed.branch === 'HEAD' ? undefined : parsed.branch,
    detached: parsed.branch === '(detached)' || parsed.branch === 'HEAD',
    oid: parsed.oid,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    entries: parsed.entries,
    counts,
    truncated: parsed.truncated
  };
}

/** The label a root is drawn under: its own directory name. */
function labelOf(path) {
  return baseName(path);
}

/**
 * Resolve the authoritative working directory for one request.
 *
 * The client's `scope.cwd` is the session-list summary captured when the
 * session STARTED; the host can follow the agent into a different directory
 * (and the multi-root plugin's scope follows the same value). The host is the
 * authority, so a `sessionId` is resolved here and the client hint is only a
 * fallback for a composition without the working-directory service.
 */
function resolveSessionCwd(ctx, sessionId, clientCwd) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId);
      if (session !== undefined) {
        const live = ctx.get('workingDirectory')?.get?.(session);
        if (typeof live === 'string' && live !== '') return live;
        if (typeof session.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd;
      }
    } catch { /* fall through to the client hint */ }
  }
  return typeof clientCwd === 'string' && clientCwd !== '' ? clientCwd : '';
}

/**
 * Build the complete state answer: the primary root plus every registered
 * additional root, each with its own git reading.
 *
 * A root that fails is still reported (with `error`), never dropped — "this
 * folder has no changes I can read" and "this folder is not on the list" are
 * different messages and only one of them is true.
 */
async function handleState(ctx, request, response) {
  const body = await readJsonBody(request);
  const resolvedCwd = resolveSessionCwd(ctx, body.sessionId, body.cwd);
  if (resolvedCwd === '') {
    sendJson(response, 400, { error: 'cwd or sessionId is required' });
    return;
  }
  const primaryRoot = resolve(resolvedCwd);
  const registry = await readAdditionalRoots(primaryRoot);

  const targets = [
    { path: primaryRoot, kind: 'primary', label: labelOf(primaryRoot) },
    ...registry.roots
      // A registration that canonicalizes onto the primary root adds nothing.
      .filter((row) => pathIdentity(row.path) !== pathIdentity(primaryRoot))
      .map((row) => ({
        path: row.path,
        kind: 'additional',
        label: labelOf(row.path),
        aliasId: row.aliasId,
        access: row.access
      }))
  ];

  const readings = await Promise.all(targets.map(async (target) => {
    try {
      const status = await readRootStatus(target.path);
      return { ...target, status };
    } catch (error) {
      return {
        ...target,
        status: { isRepo: false, error: error.message, entries: [], counts: {}, truncated: false }
      };
    }
  }));

  sendJson(response, 200, {
    primaryRoot,
    registryFound: registry.registryFound,
    roots: readings
  });
}

/**
 * Whether a byte buffer looks like binary content.
 *
 * A NUL byte in the first stretch is the same heuristic git itself uses: an
 * untracked `.aar`/`.jar`/image has no diff AND no meaningful text, so decoding
 * it as UTF-8 would render megabytes of replacement characters.
 */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * Resolve one requested revision against a root's actual history.
 *
 * A commit id from the client is untrusted input that reaches a command line,
 * so it is first narrowed to plain hex (which cannot be read as a flag or a rev
 * expression) and then resolved to the FULL id git reports. The client's own
 * short hash is never trusted as the identity of anything.
 */
async function resolveRevision(root, hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{4,64}$/i.test(hash)) {
    const error = new Error('hash must be a hex object id');
    error.status = 400;
    throw error;
  }
  const out = (await runGit(root, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`], { maxBytes: 16 * 1024 })).trim();
  if (out === '') {
    const error = new Error('unknown revision');
    error.status = 404;
    throw error;
  }
  return out;
}

/**
 * The cheapest reasoning effort a model advertises, or undefined when it
 * advertises none (passing an effort to a non-reasoning model is rejected).
 *
 * An unknown effort id never outranks a known one; when every id is unknown
 * the adapter's own first entry wins, since its declared order is the only
 * signal available.
 */
function lowestReasoningEffortOf(efforts) {
  if (!Array.isArray(efforts)) return undefined;
  const ids = [];
  for (const entry of efforts) {
    const id = entry !== null && typeof entry === 'object' ? entry.id : undefined;
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  let best;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const rank = REASONING_LEVEL_ORDER.indexOf(id);
    if (rank < 0) continue;
    if (rank < bestRank) {
      best = id;
      bestRank = rank;
    }
  }
  return best ?? ids[0];
}

/**
 * The reasoning effort to request for one route: the LOWEST the model
 * advertises, or undefined when it advertises none.
 *
 * A one-line commit message needs no deliberation, while a high default (the
 * DeepSeek adapter defaults to `high` unless the connection says otherwise)
 * both delays the answer and can spend the whole output budget on thinking,
 * returning reasoning chunks and NO text at all — reported as
 * "the model returned no text (chunks seen: block-start, reasoning-delta…)".
 */
async function draftReasoningEffort(llm, route) {
  if (typeof llm.resolveModelInfo !== 'function') return undefined;
  const info = await Promise.resolve(llm.resolveModelInfo(route.provider, route.model)).catch(() => undefined);
  return lowestReasoningEffortOf(info?.reasoning?.efforts);
}

/**
 * Draft a commit message from the staged/unstaged changes of ONE root.
 *
 * The model route is resolved the same way the harness resolves it for a
 * conversation: the session's own route first (so the draft matches the model
 * the user is already talking to), then the harness default. The plugin holds
 * no credential — `ctx.llm` resolves provider endpoints and keys.
 */
async function draftCommitMessage(ctx, root, sessionId, language, focus) {
  const llm = ctx.get('llm');
  if (llm === undefined || typeof llm.stream !== 'function') {
    const error = new Error('the harness LLM service is unavailable');
    error.status = 503;
    throw error;
  }

  const route = conversationRouteOf(ctx, sessionId) ?? defaultRouteOf(ctx);
  if (route === undefined) {
    const error = new Error('cannot resolve a model route for this conversation');
    error.status = 503;
    throw error;
  }

  // The focus is what the user is about to commit: the staged set when there is
  // one, otherwise the worktree set. Sending the OTHER side's diff would ask the
  // model to describe changes that are not in the commit.
  const args = ['diff', '--no-color', '-M', '-U2'];
  if (focus === 'staged') args.push('--cached');
  const diffText = await runGit(root, args, { maxBytes: MAX_DIFF_BYTES }).catch(() => '');
  const changedPaths = await runGit(root, focus === 'staged'
    ? ['diff', '--cached', '--name-only']
    : ['status', '--porcelain=v1', '--untracked-files=all'], { maxBytes: 512 * 1024 })
    .catch(() => '');

  const clipped = diffText.length > SUGGEST_DIFF_LIMIT
    ? `${diffText.slice(0, SUGGEST_DIFF_LIMIT)}\n...(diff truncated)`
    : diffText;

  const zh = language === 'zh';
  const system = zh
    ? '你是一个 Git 提交信息生成器。根据给定的改动，输出一条简洁的中文提交信息。'
      + '第一行是摘要（不超过 50 个字符，不要句号），如果改动较多可以空一行后补充几条要点。'
      + '只输出提交信息本身，不要解释、不要代码块、不要引号。'
    : 'You are a Git commit message generator. Given the changes, output a concise commit message. '
      + 'The first line is a subject (max 50 characters, no trailing period); if the change is large, '
      + 'add bullets after a blank line. Output ONLY the message — no explanation, no code fence, no quotes.';
  const user = zh
    ? `仓库改动如下：\n\n文件：\n${changedPaths}\n\n差异：\n${clipped || '(无文本差异)'}`
    : `Changes in this repository:\n\nFiles:\n${changedPaths}\n\nDiff:\n${clipped || '(no textual diff)'}`;

  // Assemble the stream WITHOUT importing `@deepseek-ai/dsh-llm`: that package
  // is a peer the harness resolves inside its own runtime, and a static import
  // of it would make this plugin fail to load on a profile where it is not on
  // the resolution path. The chunks are plain text deltas, so concatenating them
  // is the whole assembly step.
  const pieces = [];
  const shapes = [];
  let failureReason;
  const reasoningEffort = await draftReasoningEffort(llm, route);
  // A route we could pin to a cheap effort needs the usual small budget. A
  // route that keeps thinking regardless (or one we could not interrogate)
  // gets the larger one, because thinking is billed against `maxTokens` too.
  const reserveForThinking = reasoningEffort !== undefined && reasoningEffort !== 'off';
  const maxTokens = reserveForThinking ? SUGGEST_MAX_TOKENS_REASONING : SUGGEST_MAX_TOKENS;
  const timeoutMs = reserveForThinking ? SUGGEST_TIMEOUT_MS_REASONING : SUGGEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system,
      maxTokens,
      // Omitted entirely when the model advertises no efforts: the harness
      // rejects an effort on a non-reasoning model.
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      signal: controller.signal
    })) {
      // A `finish` chunk carries the provider's verdict. A failed one (no API
      // key, an unsupported model, a refused request) must be reported as THAT
      // failure, not as the "empty message" it would otherwise look like.
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        const failure = chunk.reason.failure;
        failureReason = typeof failure?.message === 'string' && failure.message !== ''
          ? failure.message
          : 'the model route failed';
        continue;
      }
      if (shapes.length < 3) shapes.push(String(chunk?.type ?? '(untyped)'));
      const text = textOfChunk(chunk);
      if (text !== '') pieces.push(text);
    }
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      const timeout = new Error(`the model did not answer within ${Math.round(timeoutMs / 1000)}s`);
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (failureReason !== undefined) {
    const error = new Error(failureReason);
    error.status = 502;
    throw error;
  }

  const message = pieces.join('').trim();
  if (message === '') {
    const error = new Error(`the model returned no text (chunks seen: ${shapes.join(', ') || 'none'})`);
    error.status = 502;
    throw error;
  }
  return { message, provider: route.provider, model: route.model };
}

/**
 * The text carried by one streaming chunk.
 *
 * The harness's own union (verified against the shipped type declarations, not
 * guessed):
 *
 *   { type: 'text-delta',      index, text }
 *   { type: 'reasoning-delta', index, text }
 *   { type: 'tool-call-delta', index, id, name?, argumentsDelta }
 *   { type: 'block-start' | 'block-end' | 'usage' | 'finish' }
 *
 * Only `text-delta` is assistant PROSE — a `reasoning-delta` is the model
 * thinking and a `tool-call-delta` is arguments, so folding those in would put
 * the model's scratchpad into a commit message. Any chunk that is not a
 * `text-delta` contributes nothing.
 */
function textOfChunk(chunk) {
  if (chunk === null || chunk === undefined) return '';
  if (typeof chunk === 'string') return chunk;
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text;
  return '';
}

/** The provider/model the given session last ran on, if it ever ran. */
function conversationRouteOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  try {
    const agents = ctx.get('agents');
    const options = agents?.get?.(sessionId)?.options;
    if (typeof options?.provider === 'string' && options.provider !== ''
      && typeof options?.model === 'string' && options.model !== '') {
      return { provider: options.provider, model: options.model };
    }
    const events = ctx.get('sessions')?.get?.(sessionId)?.snapshotEvents?.() ?? [];
    // Newest `request/header` wins: that is the route the user is talking on.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const data = events[index]?.data;
      const provider = data?.provider ?? data?.model?.provider;
      const model = data?.model?.model ?? data?.model;
      if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
        return { provider, model };
      }
    }
  } catch { /* fall through to the harness default */ }
  return undefined;
}

/** The harness's own default route (`agentDefaultModel`), when present. */
function defaultRouteOf(ctx) {
  try {
    const service = ctx.get('agentDefaultModel');
    const selection = service?.currentSelection?.();
    const provider = selection?.provider ?? selection?.model?.provider;
    const model = selection?.model?.model ?? selection?.model;
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      return { provider, model };
    }
  } catch { /* no default route in this deployment */ }
  return undefined;
}

/**
 * Stage and commit an EXPLICIT file list in one root.
 *
 * Caller names the files, and the staging is `git add -- <paths>` (never `-A`):
 * a background commit that silently swallowed an unrelated in-flight edit would
 * be the worst thing this panel could do. `git commit -- <paths>` then commits
 * exactly those paths, so anything already staged by someone else is left alone.
 */
async function handleCommitWrite(request, response) {
  const body = await readJsonBody(request);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string' && p !== '') : [];

  if (message === '') { sendText(response, 400, 'a commit message is required'); return; }
  if (Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    sendText(response, 400, 'commit message is too long');
    return;
  }
  if (paths.length === 0) { sendText(response, 400, 'no files to commit'); return; }

  // The root is checked AFTER the message and the file list: a stale registry
  // row must not be reported as "the commit message is empty".
  const target = await resolveWritableRoot(body);
  if (target.ok !== true) {
    sendText(response, target.status, target.message);
    return;
  }
  const root = target.root;

  try {
    await runGit(root, ['add', '--', ...paths], { maxBytes: 256 * 1024 });
    // `--literal-pathspecs` keeps a file whose name looks like pathspec magic
    // from being reinterpreted here.
    const out = await runGit(root, ['--literal-pathspecs', 'commit', '-m', message, '--', ...paths], { maxBytes: 1024 * 1024 });
    const head = (await runGit(root, ['rev-parse', '--short', 'HEAD'], { maxBytes: 16 * 1024 })).trim();
    sendJson(response, 200, { ok: true, hash: head, output: out.trim() });
  } catch (error) {
    // Surface git's own words: "nothing to commit", a hook rejection and a
    // missing identity are three different things the user must be able to tell
    // apart.
    sendText(response, error.status ?? 500, error.message || 'commit failed');
  }
}

/**
 * Push ONE root's current branch to its remote.
 *
 * The button is a one-click "send this repo's commits upstream", not a git
 * workbench. To keep that promise safe and predictable:
 *
 *   - `push.default=upstream` + no refspec: an existing tracking branch decides
 *     exactly where commits go, and a branch with NO upstream is refused with an
 *     "upstream not set" error instead of guessing (the default `simple` would
 *     also refuse, but `current` would silently create a remote branch).
 *   - `-c push.autoSetupRemote=true` on a first push: when git >= 2.37 has a
 *     single remote, this records the upstream so the NEXT click is a plain
 *     `git push`. It never overrides an existing upstream. Older git silently
 *     ignores the key, so a "no upstream" failure falls back ONCE to an
 *     explicit `push --set-upstream <only-remote> <branch>` (see below).
 *   - `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never`: a missing credential
 *     fails fast with git's own readable message instead of hanging the panel
 *     on an invisible terminal/graphical login prompt.
 *   - No `--force`, no `--all`, no `--tags`, no pull/fetch: the panel never
 *     rewrites remote history and never moves local refs. A non-fast-forward
 *     rejection is surfaced verbatim for the user to resolve.
 *
 * Root is re-validated as a real work tree (and not a subfolder of some other
 * repo) so a stale row in the registry cannot push a different repository.
 */
async function handlePush(request, response) {
  const body = await readJsonBody(request);
  const target = await resolveWritableRoot(body);
  if (target.ok !== true) {
    sendText(response, target.status, target.message);
    return;
  }
  const root = target.root;

  try {
    // `symbolic-ref` fails on a detached HEAD. A detached commit has no branch
    // to push, so say so instead of letting `git push` emit a cryptic error.
    const branch = (await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { maxBytes: 16 * 1024 })
      .catch(() => '')).trim();
    if (branch === '') {
      sendText(response, 400, 'detached HEAD: there is no branch to push');
      return;
    }

    // `git push` writes its progress/reference lines to STDERR, not stdout;
    // capture both so the notice can include git's own "-> origin/main" line.
    const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    const pushOpts = { timeoutMs: PUSH_TIMEOUT_MS, maxBytes: 256 * 1024, env: pushEnv, captureStderr: true };
    let result;
    try {
      result = await runGit(root, [
        '-c', 'push.default=upstream',
        '-c', 'push.autoSetupRemote=true',
        'push'
      ], pushOpts);
    } catch (firstError) {
      // git < 2.37 ignores the unknown `push.autoSetupRemote` key, so a branch
      // with NO upstream fails here instead of setting one. Retry ONCE with the
      // classic explicit `--set-upstream`, but only when there is exactly ONE
      // remote (we refuse to guess which remote owns the branch) and both the
      // remote and branch names are plain, safe tokens.
      const message = String(firstError.message || '');
      if (!/no upstream branch|has no upstream/i.test(message)) throw firstError;
      const remotes = (await runGit(root, ['remote'], { maxBytes: 16 * 1024 }))
        .trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
      if (remotes.length !== 1) throw firstError;
      const remote = remotes[0];
      const safeName = /^[A-Za-z0-9._\/-]+$/;
      if (!safeName.test(remote) || !safeName.test(branch)) throw firstError;
      result = await runGit(root, [
        '-c', 'push.default=current',
        'push', '--set-upstream', remote, branch
      ], pushOpts);
    }

    const output = `${result.stdout}${result.stderr}`.trim();
    sendJson(response, 200, { ok: true, branch, output });
  } catch (error) {
    // Surface git's own words verbatim: a non-fast-forward, an auth failure, a
    // missing remote and a hook rejection are four different things to fix.
    sendText(response, error.status ?? 500, error.message || 'push failed');
  }
}

/**
 * Parse `git log` output written with a RECORD SEPARATOR framing.
 *
 * A commit subject can contain almost anything — including `|`, tabs and
 * newlines after the subject line — so the fields are read by POSITION between
 * two sentinels rather than by splitting on a character that might also occur
 * inside a value. `%x1e` / `%x1f` are chosen because a commit message cannot
 * contain them: git refuses control characters in object content.
 */
function parseLog(raw) {
  const commits = [];
  for (const record of raw.split('\x1e')) {
    const text = record.trim();
    if (text === '') continue;
    const [hash, shortHash, author, authorMail, timestamp, refs, subject] = text.split('\x1f');
    if (hash === undefined || hash === '') continue;
    commits.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      author: author ?? '',
      authorMail: authorMail ?? '',
      // A unix timestamp in SECONDS; the client formats it in the local zone.
      timestamp: Number(timestamp) || 0,
      refs: (refs ?? '').split(',').map((ref) => ref.trim()).filter((ref) => ref !== ''),
      subject: subject ?? ''
    });
  }
  return commits;
}

/**
 * One root's recent commit history.
 *
 * `HEAD` may not exist yet (a repository with no commits). That is an ordinary
 * state, not a failure — the answer is an empty list with `hasCommits: false`,
 * so the panel can say so instead of showing an error.
 */
async function readRootLog(root, limit) {
  const count = Math.min(Math.max(1, limit), 200);
  try {
    const raw = await runGit(root, [
      'log',
      `-n${count}`,
      '--no-color',
      // Sentinels: RS before each commit, US between fields.
      '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s'
    ], { maxBytes: 1024 * 1024 });
    return { hasCommits: true, commits: parseLog(raw) };
  } catch (error) {
    const message = error.message || '';
    // `git log` on an unborn branch exits non-zero with this phrasing.
    if (/does not have any commits yet|unknown revision|bad revision|ambiguous argument 'HEAD'|your current branch .* does not have any commits/i.test(message)) {
      return { hasCommits: false, commits: [] };
    }
    throw error;
  }
}

/**
 * One commit's own patch, read from the root that owns it.
 *
 * A merge commit has no single diff worth showing (git prints nothing for it
 * without `-m`), so the answer says `merge: true` and the client renders the
 * commit's metadata alone rather than an empty patch that looks like a failure.
 */
async function handleCommit(request, response) {
  const body = await readJsonBody(request);
  const root = typeof body.root === 'string' && body.root !== '' ? resolve(body.root) : '';
  const hash = typeof body.hash === 'string' && body.hash !== '' ? body.hash : '';
  if (root === '' || hash === '') {
    sendText(response, 400, 'root and hash are required');
    return;
  }
  // A revision is user input: only plain hex object ids reach the command line,
  // so nothing here can be read as a flag or a rev expression.
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) {
    sendText(response, 400, 'hash must be a hex object id');
    return;
  }

  try {
    const raw = await runGit(root, [
      'show',
      '--no-color',
      '--date=unix',
      '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%cI%x1f%D%x1f%s%x1f%b',
      '-U3',
      hash
    ], { maxBytes: MAX_DIFF_BYTES });

    const separator = raw.indexOf('\x1f');
    if (separator === -1) {
      sendJson(response, 200, { kind: 'empty', hash });
      return;
    }
    // Split the header from the patch at the first `diff --git` (or the end).
    const bodyStart = raw.search(/\ndiff --git |\n--\n/);
    const headerText = bodyStart === -1 ? raw : raw.slice(0, bodyStart + 1);
    const patch = bodyStart === -1 ? '' : raw.slice(bodyStart + 1);

    const fields = headerText.replace(/^\x1e/, '').split('\x1f');
    const meta = {
      hash: fields[0] ?? hash,
      shortHash: fields[1] ?? hash.slice(0, 7),
      author: fields[2] ?? '',
      authorMail: fields[3] ?? '',
      timestamp: Number(fields[4]) || 0,
      committedIso: fields[5] ?? '',
      refs: (fields[6] ?? '').split(',').map((ref) => ref.trim()).filter((ref) => ref !== ''),
      subject: fields[7] ?? '',
      body: (fields[8] ?? '').trim()
    };

    const parents = (await runGit(root, ['rev-list', '--parents', '-n', '1', hash], { maxBytes: 16 * 1024 }))
      .trim().split(/\s+/).filter((part) => part !== '');
    const isMerge = parents.length > 2;

    sendJson(response, 200, {
      kind: 'commit',
      meta,
      merge: isMerge,
      parentCount: Math.max(0, parents.length - 1),
      patch: isMerge ? '' : patch,
      truncated: Buffer.byteLength(patch, 'utf8') >= MAX_DIFF_BYTES
    });
  } catch (error) {
    sendText(response, error.status ?? 500, error.message || 'commit failed');
  }
}

/** Recent history for every root, asked for in one request. */
async function handleLog(request, response) {
  const body = await readJsonBody(request);
  const roots = Array.isArray(body.roots) ? body.roots.filter((root) => typeof root === 'string' && root !== '') : [];
  if (roots.length === 0) {
    sendJson(response, 200, { roots: [] });
    return;
  }
  const limit = Number.isInteger(body.limit) ? body.limit : 30;
  const readings = await Promise.all(roots.slice(0, MAX_ADDITIONAL_ROOTS + 1).map(async (root) => {
    try {
      const log = await readRootLog(root, limit);
      return { path: root, isRepo: true, ...log };
    } catch (error) {
      return { path: root, isRepo: false, hasCommits: false, commits: [], error: error.message };
    }
  }));
  sendJson(response, 200, { roots: readings });
}

/**
 * One file's diff, read from the root the file actually belongs to.
 *
 * `staged` selects index-vs-HEAD; the default is worktree-vs-index. An untracked
 * file has no diff at all, so its CONTENT is returned with an all-added flag and
 * the client renders it as a fresh file — the same thing git would show.
 */
async function handleDiff(request, response) {
  const body = await readJsonBody(request);
  const root = typeof body.root === 'string' && body.root !== '' ? resolve(body.root) : '';
  const path = typeof body.path === 'string' ? body.path : '';
  if (root === '' || path === '') {
    sendText(response, 400, 'root and path are required');
    return;
  }

  const staged = body.staged === true;
  const untracked = body.untracked === true;
  const origPath = typeof body.origPath === 'string' && body.origPath !== '' ? body.origPath : undefined;

  try {
    if (untracked) {
      const content = await readFile(join(root, path));
      // A binary file has nothing a text pane can show; say so instead of
      // streaming replacement characters into the reader.
      if (looksBinary(content)) {
        sendJson(response, 200, { kind: 'binary', size: content.length });
        return;
      }
      const clipped = content.length > MAX_UNTRACKED_BYTES ? content.subarray(0, MAX_UNTRACKED_BYTES) : content;
      sendJson(response, 200, {
        kind: 'untracked',
        content: clipped.toString('utf8'),
        size: content.length,
        truncated: content.length > MAX_UNTRACKED_BYTES
      });
      return;
    }

    const args = ['diff', '--no-color', '-M', '-U3'];
    if (staged) args.push('--cached');
    // Both sides of a rename are named so the pathspec matches whichever
    // spelling git recorded the change under.
    const paths = origPath !== undefined && origPath !== path ? [origPath, path] : [path];
    args.push('--', ...paths);

    const text = await runGit(root, args, { maxBytes: MAX_DIFF_BYTES });
    sendJson(response, 200, {
      kind: 'diff',
      patch: text,
      truncated: Buffer.byteLength(text, 'utf8') >= MAX_DIFF_BYTES
    });
  } catch (error) {
    sendText(response, error.status ?? 500, error.message || 'diff failed');
  }
}

/** Draft a commit message for one root and hand it back. */
async function handleSuggestMessage(ctx, request, response) {
  const body = await readJsonBody(request);
  const root = typeof body.root === 'string' && body.root !== '' ? resolve(body.root) : '';
  if (root === '') { sendText(response, 400, 'root is required'); return; }
  const language = body.language === 'zh' ? 'zh' : 'en';
  const focus = body.focus === 'staged' ? 'staged' : 'worktree';
  try {
    const draft = await draftCommitMessage(ctx, root, body.sessionId, language, focus);
    sendJson(response, 200, draft);
  } catch (error) {
    sendText(response, error.status ?? 500, error.message || 'suggestion failed');
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const routes = [
        {
          path: `${API}/state`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handleState(host, request, response);
          }
        },
        {
          path: `${API}/diff`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handleDiff(request, response);
          }
        },
        {
          path: `${API}/log`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handleLog(request, response);
          }
        },
        {
          path: `${API}/commit`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handleCommit(request, response);
          }
        },
        {
          path: `${API}/commit-write`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handleCommitWrite(request, response);
          }
        },
        {
          path: `${API}/push`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handlePush(request, response);
          }
        },
        {
          path: `${API}/suggest-message`,
          handler: (request, response) => {
            if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
            return handleSuggestMessage(host, request, response);
          }
        }
      ];

      const disposers = routes.map((route) => host.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (request, response) => {
          Promise.resolve()
            .then(() => route.handler(request, response))
            .catch((error) => {
              const status = Number.isInteger(error?.status) ? error.status : 500;
              if (!response.headersSent) sendText(response, status, status === 413 ? 'body too large' : 'internal error');
              else response.end();
            });
        }
      }));

      return () => { for (const dispose of disposers) { try { dispose?.(); } catch { /* already gone */ } } };
    }, 'multi-root-changes: routes');
  });
}

export const __test = { parsePorcelainV2, parseNumstat, splitFixed, pathIdentity, parseLog, handlePush };

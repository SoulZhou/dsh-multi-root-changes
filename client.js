/**
 * Browser half of dsh-multi-root-changes.
 *
 * Registers ONE sidebar tab ("多根改动") through dsh-better-sidebar's
 * `ctx.betterSidebar.registerTab`, which every registered tab type shares — so
 * the page lands in DSH's own right column next to Files / Git / Tasks instead
 * of becoming a second, parallel panel.
 *
 * The page is a per-root accordion: the session's primary root first, then every
 * additional root the multi-root plugin registers for it. Each root shows its
 * branch, ahead/behind, and its changed files folded into a directory tree; a
 * click reads that file's diff from the SAME route the host half exposes, so a
 * sibling checkout never gets resolved against the wrong repository (which is
 * exactly what a cwd-pinned git route would do).
 *
 * Every repo section carries a commit box (message + AI draft + Commit + Push).
 * Both write actions refresh the whole state on success: commit so the new entry
 * appears in that repo's history, and push so the ahead/behind counter and the
 * commit-history list are re-read from git at their latest values.
 *
 * Dependency-free by design: React comes from the shell, no bundler, no imports.
 */

window.__ModuleLoader__.load({
  id: 'dsh-multi-root-changes',
  factory(require) {
    'use strict';

    const React = require('react');
    const {
      createElement: h,
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState
    } = React;

    const API_BASE = '/dsh-multi-root-changes/api';
    const TAB_ID = 'multi-root-changes';
    /** How often the panel re-reads status while it is on screen. */
    const POLL_MS = 8000;
    /** Commits fetched per root when a history section is expanded. */
    const COMMIT_LIMIT = 30;

    const COPY = {
      zh: {
        tab: '多根改动',
        tabDesc: '会话主目录与所有附加工作目录的 Git 改动',
        refresh: '刷新',
        loading: '正在读取…',
        empty: '没有改动',
        emptyRoot: '这个目录没有改动',
        notRepo: '不是 git 仓库',
        nestedIn: '该目录属于另一个仓库',
        readFailed: '读取失败',
        primary: '主目录',
        additional: '附加目录',
        files: '{count} 个文件',
        truncated: '改动过多，只显示了一部分',
        registryMissing: '未检测到附加工作目录登记（multi-root-workspace 未登记或未安装）',
        diffEmpty: '没有可显示的差异',
        diffFailed: '差异读取失败',
        untracked: '新文件',
        binary: '二进制文件',
        conflict: '冲突',
        staged: '已暂存',
        selectRoot: '选择目录',
        detached: '游离 HEAD',
        tooLarge: '文件过大，仅显示前一部分',
        commits: '提交历史',
        noCommits: '这个仓库还没有提交',
        mergeCommit: '合并提交（{count} 个父提交），无单一差异',
        commitPlaceholder: '提交信息（Ctrl+Enter 提交）',
        commitAction: '提交',
        committing: '提交中…',
        commitTitle: '提交：把改动写成本地提交（存进本机仓库，不联网）',
        pushAction: '推送',
        pushing: '推送中…',
        pushed: '已推送 {branch}',
        pushUpToDate: '远端已是最新：没有需要推送的本地提交（未提交的改动不会随推送上传）',
        pushTitle: '推送：把本地提交上传到远端仓库（需要网络）',
        flowHint: '提交 = 存进本地仓库　·　推送 = 上传到远端仓库',
        aheadTitle: '↑ {count} 个本地提交还没推送',
        behindTitle: '↓ {count} 个远端提交还没拉取',
        aiGenerate: 'AI 生成',
        generating: '生成中…',
        committed: '已提交 {hash}'
      },
      en: {
        tab: 'Multi-root changes',
        tabDesc: 'Git changes across the session root and every additional workspace root',
        refresh: 'Refresh',
        loading: 'Reading…',
        empty: 'No changes',
        emptyRoot: 'No changes in this folder',
        notRepo: 'Not a git repository',
        nestedIn: 'This folder belongs to another repository',
        readFailed: 'Read failed',
        primary: 'Primary',
        additional: 'Additional',
        files: '{count} files',
        truncated: 'Too many changes; showing a part of them',
        registryMissing: 'No additional workspace roots registered (multi-root-workspace absent or not configured)',
        diffEmpty: 'No diff to show',
        diffFailed: 'Could not read the diff',
        untracked: 'New file',
        binary: 'Binary file',
        conflict: 'Conflict',
        staged: 'Staged',
        selectRoot: 'Choose a folder',
        detached: 'Detached HEAD',
        tooLarge: 'File too large; showing the beginning only',
        commits: 'Commit history',
        noCommits: 'This repository has no commits yet',
        mergeCommit: 'Merge commit ({count} parents) — no single diff to show',
        commitPlaceholder: 'Commit message (Ctrl+Enter to commit)',
        commitAction: 'Commit',
        committing: 'Committing…',
        commitTitle: 'Commit: write the changes as a local commit (stays on this machine, no network)',
        pushAction: 'Push',
        pushing: 'Pushing…',
        pushed: 'Pushed {branch}',
        pushUpToDate: 'Remote is already up to date: nothing to push (uncommitted changes are NOT uploaded by push)',
        pushTitle: 'Push: upload the local commits to the remote repository (needs network)',
        flowHint: 'Commit = save locally · Push = upload to remote',
        aheadTitle: '↑ {count} local commit(s) not pushed yet',
        behindTitle: '↓ {count} remote commit(s) not fetched yet',
        aiGenerate: 'AI draft',
        generating: 'Drafting…',
        committed: 'Committed {hash}'
      }
    };

    function isZh() {
      const language = (navigator.language || '').toLowerCase();
      return language.startsWith('zh');
    }

    function useCopy() {
      const [zh, setZh] = useState(isZh);
      useEffect(() => {
        // A locale switch is a DOM lang change DSH makes on <html>; following it
        // keeps the panel in the user's language without polling a service.
        const read = () => setZh(isZh());
        const observer = new MutationObserver(read);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        window.addEventListener('focus', read);
        return () => { observer.disconnect(); window.removeEventListener('focus', read); };
      }, []);
      return useCallback((key, vars) => {
        const table = zh ? COPY.zh : COPY.en;
        let text = table[key] ?? COPY.en[key] ?? key;
        if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
        return text;
      }, [zh]);
    }

    /** POST one JSON body to this plugin's own same-origin route. */
    async function postJson(path, body) {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {})
      });
      if (!response.ok) {
        let detail = `${response.status}`;
        try { detail = (await response.text()) || detail; } catch { /* keep the status */ }
        throw new Error(detail);
      }
      return response.json();
    }

    /**
     * The status letter for one entry, following git's own porcelain readings.
     *
     * The letters are git's: `?` untracked, `U` conflict (git prints `UU`/`AA`
     * for an unmerged path, and a single `U` is the badge's shorthand for it),
     * `M`/`A`/`D`/`R`/`C` otherwise. The worktree side wins when both sides
     * changed, because that is the state the reader can still act on.
     */
    function statusLetter(entry) {
      if (entry.conflict === true) return { letter: 'U' };
      if (entry.untracked === true) return { letter: '?' };
      const x = entry.x ?? ' ';
      const y = entry.y ?? ' ';
      if (x === 'R') return { letter: 'R' };
      if (x === 'C') return { letter: 'C' };
      if (y === 'M') return { letter: 'M' };
      if (y === 'D') return { letter: 'D' };
      if (x === 'M' || x === 'A' || x === 'D') return { letter: x, staged: true };
      if (y === 'A') return { letter: 'A' };
      return { letter: '?' };
    }

    /** The last path segment of either separator style. */
    function baseName(path) {
      const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      return at === -1 ? path : path.slice(at + 1);
    }

    /**
     * A commit timestamp (unix SECONDS, as `%at` prints it) in the reader's own
     * zone and locale. Recent commits read as an hour/day count because that is
     * what a history list is scanned for; older ones fall back to a date.
     */
    function formatTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '';
      const then = new Date(seconds * 1000);
      const diffMs = Date.now() - then.getTime();
      const minutes = Math.floor(diffMs / 60000);
      if (minutes < 1) return isZh() ? '刚刚' : 'just now';
      if (minutes < 60) return isZh() ? `${minutes} 分钟前` : `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return isZh() ? `${hours} 小时前` : `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 30) return isZh() ? `${days} 天前` : `${days}d ago`;
      const pad = (value) => String(value).padStart(2, '0');
      return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
    }

    /**
     * Fold one root's flat porcelain paths into a directory tree.
     *
     * Single-child directory chains are compressed into one row (`a/b/c`), so a
     * deep path does not cost one row per segment — the same shape VS Code's
     * SCM tree uses.
     */
    function buildTree(entries) {
      const root = { dirs: new Map(), files: [] };
      for (const entry of entries) {
        const segments = entry.path.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
        if (segments.length === 0) continue;
        let at = root;
        for (let index = 0; index < segments.length - 1; index += 1) {
          const name = segments[index];
          let next = at.dirs.get(name);
          if (next === undefined) {
            next = { name, dirs: new Map(), files: [] };
            at.dirs.set(name, next);
          }
          at = next;
        }
        at.files.push({ ...entry, name: segments[segments.length - 1] });
      }

      const finish = (node) => {
        let name = node.name ?? '';
        let current = node;
        while (current.files.length === 0 && current.dirs.size === 1) {
          const only = [...current.dirs.values()][0];
          name = name === '' ? only.name : `${name}/${only.name}`;
          current = only;
        }
        const dirs = [...current.dirs.values()].map(finish);
        const files = current.files.slice().sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
        dirs.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
        return { kind: 'dir', name, children: [...dirs, ...files], count: countOf(dirs) + files.length };
      };
      const countOf = (dirs) => dirs.reduce((sum, dir) => sum + dir.count, 0);

      return [...root.dirs.values()].map(finish)
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
        .concat(root.files.slice()
          .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
          .map((file) => ({ kind: 'file', ...file })));
    }

    /** One changed-file row. */
    function FileRow(props) {
      const { entry, counts, selected, onSelect, depth } = props;
      const badge = statusLetter(entry);
      const reading = counts?.[entry.path];
      const stagedSide = reading?.staged;
      const unstagedSide = reading?.unstaged;
      const side = unstagedSide ?? stagedSide;
      const isBinary = side?.binary === true;
      return h('button', {
        type: 'button',
        className: selected ? 'mrc-row mrc-rowActive' : 'mrc-row',
        style: { paddingLeft: `${8 + depth * 12}px` },
        title: entry.origPath !== undefined ? `${entry.origPath} → ${entry.path}` : entry.path,
        onClick: () => onSelect(entry)
      },
      h('span', { className: `mrc-badge mrc-badge-${badge.letter}`, 'data-letter': badge.letter }, badge.letter),
      h('span', { className: 'mrc-name' }, baseName(entry.path)),
      !isBinary && side !== undefined && (side.additions > 0 || side.deletions > 0)
        ? h('span', { className: 'mrc-counts' },
          side.additions > 0 ? h('span', { className: 'mrc-add' }, `+${side.additions}`) : null,
          side.deletions > 0 ? h('span', { className: 'mrc-del' }, `−${side.deletions}`) : null)
        : null);
    }

    /** One directory row plus its children. */
    function DirRow(props) {
      const { node, depth, render } = props;
      const [open, setOpen] = useState(true);
      return h('div', null,
        h('button', {
          type: 'button',
          className: 'mrc-row mrc-dirRow',
          style: { paddingLeft: `${8 + depth * 12}px` },
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open
        },
        h('span', { className: open ? 'mrc-caret mrc-caretOpen' : 'mrc-caret' }, '▸'),
        h('span', { className: 'mrc-dirName' }, node.name),
        h('span', { className: 'mrc-dirCount' }, node.count)),
        open ? h('div', null, node.children.map((child, index) => render(child, depth + 1, `${node.name}:${index}`))) : null);
    }

    /**
     * Render a unified patch by KEEPING git's own hunk structure: header lines
     * start a new section, `+`/`-` lines are the content, everything else is
     * context. Nothing is recomputed or re-numbered — the numbers git printed
     * are the numbers shown.
     *
     * Shared by the working-tree diff and a commit's patch: both are the same
     * format, and two renderers would drift apart on the first fix.
     */
    function DiffBody(props) {
      const { patch, note } = props;
      const rows = [];
      let oldNo = 0;
      let newNo = 0;
      for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (match) { oldNo = Number(match[1]); newNo = Number(match[2]); }
          rows.push(h('div', { key: rows.length, className: 'mrc-hunk' }, line));
          continue;
        }
        if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ')
          || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file')
          || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('old mode')
          || line.startsWith('new mode') || line.startsWith('Binary files')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-fileHead' }, line));
          continue;
        }
        if (line.startsWith('+')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-line mrc-lineAdd' },
            h('span', { className: 'mrc-lineNo' }, String(newNo)),
            h('span', { className: 'mrc-sign' }, '+'),
            h('span', { className: 'mrc-lineText' }, line.slice(1))));
          newNo += 1;
          continue;
        }
        if (line.startsWith('-')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-line mrc-lineDel' },
            h('span', { className: 'mrc-lineNo' }, String(oldNo)),
            h('span', { className: 'mrc-sign' }, '−'),
            h('span', { className: 'mrc-lineText' }, line.slice(1))));
          oldNo += 1;
          continue;
        }
        if (line.startsWith('\\')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-fileHead' }, line));
          continue;
        }
        rows.push(h('div', { key: rows.length, className: 'mrc-line' },
          h('span', { className: 'mrc-lineNo' }, String(oldNo)),
          h('span', { className: 'mrc-sign' }, ' '),
          h('span', { className: 'mrc-lineText' }, line.slice(1))));
        oldNo += 1;
        newNo += 1;
      }
      return h('div', { className: 'mrc-diff' },
        note !== undefined ? h('div', { className: 'mrc-diffNote' }, note) : null,
        rows);
    }

    /** The diff reader: a unified patch, or a new file's whole content. */
    function DiffView(props) {
      const { root, entry, t, refreshTick } = props;
      const [state, setState] = useState({ loading: true, error: null, data: null });

      useEffect(() => {
        let live = true;
        setState({ loading: true, error: null, data: null });
        postJson('/diff', {
          root,
          path: entry.path,
          origPath: entry.origPath,
          staged: entry.untracked === true ? false : (entry.y === ' ' && entry.x !== ' '),
          untracked: entry.untracked === true
        }).then((data) => {
          if (live) setState({ loading: false, error: null, data });
        }).catch((error) => {
          if (live) setState({ loading: false, error: error.message, data: null });
        });
        return () => { live = false; };
      }, [root, entry.path, entry.origPath, entry.x, entry.y, entry.untracked, refreshTick]);

      if (state.loading) return h('div', { className: 'mrc-diffNote' }, t('loading'));
      if (state.error !== null) return h('div', { className: 'mrc-diffNote mrc-error' }, `${t('diffFailed')}: ${state.error}`);
      const data = state.data;
      if (data === null) return h('div', { className: 'mrc-diffNote' }, t('diffEmpty'));

      if (data.kind === 'binary') {
        const kb = Math.max(1, Math.round((data.size ?? 0) / 1024));
        return h('div', { className: 'mrc-diffNote' }, `${t('binary')} · ${kb} KB`);
      }

      if (data.kind === 'untracked') {
        const lines = String(data.content ?? '').split('\n');
        return h('div', { className: 'mrc-diff' },
          data.truncated ? h('div', { className: 'mrc-diffNote' }, t('tooLarge')) : null,
          h('div', { className: 'mrc-diffHead' }, `${t('untracked')} · ${entry.path}`),
          lines.map((line, index) => h('div', { key: index, className: 'mrc-line mrc-lineAdd' },
            h('span', { className: 'mrc-lineNo' }, String(index + 1)),
            // A whole new file is all additions, so every row carries the same
            // `+` the diff rows do — the gutter lines up across both views.
            h('span', { className: 'mrc-sign' }, '+'),
            h('span', { className: 'mrc-lineText' }, line))));
      }

      const patch = String(data.patch ?? '');
      if (patch.trim() === '') return h('div', { className: 'mrc-diffNote' }, t('diffEmpty'));

      return h(DiffBody, { patch });
    }

    /** A commit's own diff, read from the root that owns it. */
    function CommitView(props) {
      const { root, hash, t } = props;
      const [state, setState] = useState({ loading: true, error: null, data: null });

      useEffect(() => {
        let live = true;
        setState({ loading: true, error: null, data: null });
        postJson('/commit', { root, hash })
          .then((data) => { if (live) setState({ loading: false, error: null, data }); })
          .catch((error) => { if (live) setState({ loading: false, error: error.message, data: null }); });
        return () => { live = false; };
      }, [root, hash]);

      if (state.loading) return h('div', { className: 'mrc-diffNote' }, t('loading'));
      if (state.error !== null) return h('div', { className: 'mrc-diffNote mrc-error' }, `${t('diffFailed')}: ${state.error}`);
      const data = state.data;
      if (data === null || data.kind !== 'commit') return h('div', { className: 'mrc-diffNote' }, t('diffEmpty'));

      const meta = data.meta ?? {};
      const rows = [];
      rows.push(h('div', { key: 'meta', className: 'mrc-commitMeta' },
        h('div', { className: 'mrc-commitHash' }, meta.shortHash ?? hash),
        h('div', { className: 'mrc-commitAuthor' }, `${meta.author ?? ''} · ${formatTime(meta.timestamp)}`),
        data.merge === true
          ? h('div', { className: 'mrc-diffNote' }, t('mergeCommit', { count: data.parentCount ?? 0 }))
          : null,
        meta.body !== undefined && meta.body !== ''
          ? h('div', { className: 'mrc-commitBody' }, meta.body)
          : null));

      if (data.merge !== true && typeof data.patch === 'string' && data.patch !== '') {
        rows.push(h(DiffBody, { key: 'patch', patch: data.patch, t }));
      }
      return h('div', { className: 'mrc-diff' }, rows);
    }

    /** One root's collapsible commit history. */
    function CommitSection(props) {
      const { root, t, selected, onSelectCommit, limit, refreshSignal, refreshTick } = props;
      const [open, setOpen] = useState(false);
      const [state, setState] = useState({ loading: false, error: null, commits: [], hasCommits: true });

      // A commit or a successful push bumps refreshSignal in the tab. The history
      // must re-read from git even when the parent passes a fresh `root` object,
      // because the fetch effect only depends on the primitive root.path/limit.
      // Auto-expanding on that signal makes the refreshed latest commits visible
      // instead of hiding them behind a still-collapsed toggle.
      useEffect(() => {
        if (refreshSignal > 0) setOpen(true);
      }, [refreshSignal]);

      useEffect(() => {
        if (!open) return undefined;
        let live = true;
        setState((prev) => ({ ...prev, loading: true, error: null }));
        postJson('/log', { roots: [root.path], limit })
          .then((data) => {
            if (!live) return;
            const reading = Array.isArray(data.roots) && data.roots.length > 0 ? data.roots[0] : null;
            if (reading === null || reading.isRepo !== true) {
              setState({ loading: false, error: reading?.error ?? null, commits: [], hasCommits: false });
              return;
            }
            setState({ loading: false, error: null, commits: reading.commits ?? [], hasCommits: reading.hasCommits !== false });
          })
          .catch((error) => { if (live) setState({ loading: false, error: error.message, commits: [], hasCommits: false }); });
        return () => { live = false; };
      }, [open, root.path, limit, refreshSignal, refreshTick]);

      return h('div', { className: 'mrc-commits' },
        h('button', {
          type: 'button',
          className: 'mrc-commitToggle',
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open
        },
        h('span', { className: open ? 'mrc-caret mrc-caretOpen' : 'mrc-caret' }, '▸'),
        h('span', null, t('commits'))),
        open ? h('div', { className: 'mrc-commitList' },
          state.loading ? h('div', { className: 'mrc-note' }, t('loading')) : null,
          state.error !== null ? h('div', { className: 'mrc-note mrc-error' }, `${t('readFailed')}: ${state.error}`) : null,
          !state.loading && state.error === null && state.hasCommits === false
            ? h('div', { className: 'mrc-note' }, t('noCommits'))
            : null,
          state.commits.map((commit) => {
            const isSelected = selected !== null && selected.root === root.path && selected.hash === commit.hash;
            return h('button', {
              key: commit.hash,
              type: 'button',
              className: isSelected ? 'mrc-commitRow mrc-rowActive' : 'mrc-commitRow',
              title: `${commit.hash}\n${commit.author} · ${formatTime(commit.timestamp)}`,
              onClick: () => onSelectCommit(root.path, commit)
            },
            h('span', { className: 'mrc-commitDot' }, '●'),
            h('span', { className: 'mrc-commitSubject' }, commit.subject),
            commit.refs.length > 0 ? h('span', { className: 'mrc-ref' }, commit.refs[0]) : null,
            h('span', { className: 'mrc-commitWhen' }, formatTime(commit.timestamp)));
          }))
          : null);
    }

    /** One root's action box: message, AI draft, Commit and Push. */
    function CommitBox(props) {
      const { root, t, onCommitted, sessionId, refreshTick } = props;
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState(false);
      const [suggesting, setSuggesting] = useState(false);
      const [pushing, setPushing] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);

      // A manual refresh means "show me the repo as it is now"; a stale failure
      // or success notice from an earlier action no longer describes that state.
      useEffect(() => {
        if (refreshTick > 0) {
          setError(null);
          setNotice(null);
        }
      }, [refreshTick]);

      const entries = root.status?.entries ?? [];
      // The box commits the WORKING TREE set: every changed path the panel is
      // showing. Explicitly named, never `git add -A`.
      const paths = entries.map((entry) => entry.path);

      const suggest = async () => {
        if (suggesting || busy || pushing || paths.length === 0) return;
        setSuggesting(true);
        setError(null);
        setNotice(null);
        try {
          const reply = await postJson('/suggest-message', {
            root: root.path,
            sessionId,
            language: isZh() ? 'zh' : 'en',
            focus: 'worktree'
          });
          setMessage(reply.message ?? '');
        } catch (failure) {
          setError(String(failure.message || failure));
        } finally {
          setSuggesting(false);
        }
      };

      const commit = async () => {
        if (busy || suggesting || pushing) return;
        if (message.trim() === '' || paths.length === 0) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const reply = await postJson('/commit-write', { root: root.path, message, paths });
          setNotice(t('committed', { hash: reply.hash ?? '' }));
          setMessage('');
          onCommitted?.();
        } catch (failure) {
          setError(String(failure.message || failure));
        } finally {
          setBusy(false);
        }
      };

      // Push never commits and never needs a message: it sends whatever the
      // current branch's upstream is tracking. On success the tab bumps its
      // refresh counter, which re-reads /state (ahead/behind, branch) and makes
      // the commit-history list re-fetch the latest log from git.
      const push = async () => {
        if (busy || suggesting || pushing) return;
        setPushing(true);
        setError(null);
        setNotice(null);
        try {
          const reply = await postJson('/push', { root: root.path });
          const output = (reply.output ?? '').trim();
          // "Everything up-to-date" is not a transfer: nothing new reached the remote.
          if (/everything up[- ]to[- ]date/i.test(output)) {
            setNotice(t('pushUpToDate'));
            onCommitted?.();
            return;
          }
          let text = t('pushed', { branch: reply.branch ?? '' });
          if (output !== '') {
            text += ` · ${output.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-1)[0]?.slice(0, 80)}`;
          }
          setNotice(text);
          onCommitted?.();
        } catch (failure) {
          setError(String(failure.message || failure));
        } finally {
          setPushing(false);
        }
      };

      const anyBusy = busy || suggesting || pushing;

      return h('div', { className: 'mrc-commitBox' },
        h('div', { className: 'mrc-flowHint', title: t('flowHint') }, t('flowHint')),
        h('textarea', {
          className: 'mrc-commitInput',
          value: message,
          rows: 2,
          placeholder: t('commitPlaceholder'),
          spellCheck: false,
          disabled: anyBusy,
          onChange: (event) => setMessage(event.currentTarget.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void commit();
            }
          }
        }),
        h('div', { className: 'mrc-commitActions' },
          h('button', {
            type: 'button',
            className: 'mrc-aiButton',
            disabled: anyBusy || paths.length === 0,
            title: t('aiGenerate'),
            onClick: () => { void suggest() }
          }, suggesting ? t('generating') : `✦ ${t('aiGenerate')}`),
          h('span', { className: 'mrc-commitCount' }, t('files', { count: paths.length })),
          // Push does not commit and does not depend on the changed-path set,
          // so the only gate is whether another write is already in flight.
          h('button', {
            type: 'button',
            className: 'mrc-pushButton',
            disabled: anyBusy,
            title: t('pushTitle'),
            onClick: () => { void push() }
          }, pushing ? t('pushing') : t('pushAction')),
          h('button', {
            type: 'button',
            className: 'mrc-commitButton',
            disabled: anyBusy || message.trim() === '' || paths.length === 0,
            title: t('commitTitle'),
            onClick: () => { void commit() }
          }, busy ? t('committing') : t('commitAction'))),
        error !== null ? h('div', { className: 'mrc-note mrc-error' }, error) : null,
        notice !== null ? h('div', { className: 'mrc-note mrc-ok' }, notice) : null);
    }

    /** One root's collapsible section: header, counters, tree. */
    function RootSection(props) {
      const { root, t, selected, onSelectEntry, selectedCommit, onSelectCommit, commitLimit, onCommitted, sessionId, historyTick, refreshTick } = props;
      const status = root.status ?? {};
      const entries = Array.isArray(status.entries) ? status.entries : [];
      const [open, setOpen] = useState(true);
      const tree = useMemo(() => buildTree(entries), [entries]);
      const hasRepo = status.isRepo === true;
      const changed = status.counts ?? {};
      const added = entries.reduce((sum, entry) => sum + (changed[entry.path]?.unstaged?.additions ?? changed[entry.path]?.staged?.additions ?? 0), 0);
      const removed = entries.reduce((sum, entry) => sum + (changed[entry.path]?.unstaged?.deletions ?? changed[entry.path]?.staged?.deletions ?? 0), 0);

      const renderNode = useCallback((node, depth, key) => {
        if (node.kind === 'dir') {
          return h(DirRow, { key, node, depth, render: renderNode });
        }
        const isSelected = selected !== null && selected.root === root.path && selected.entry.path === node.path;
        return h(FileRow, {
          key,
          entry: node,
          counts: changed,
          depth,
          selected: isSelected,
          onSelect: (entry) => onSelectEntry(root.path, entry)
        });
      }, [root.path, changed, selected, onSelectEntry]);

      return h('section', { className: 'mrc-root' },
        h('button', {
          type: 'button',
          className: 'mrc-rootHead',
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open
        },
        h('span', { className: open ? 'mrc-caret mrc-caretOpen' : 'mrc-caret' }, '▸'),
        h('span', { className: 'mrc-rootLabel', title: root.path }, root.label),
        root.kind === 'primary'
          ? h('span', { className: 'mrc-tag' }, t('primary'))
          : h('span', { className: 'mrc-tag mrc-tagAlt' }, t('additional')),
        hasRepo && status.branch !== undefined
          ? h('span', { className: 'mrc-branch', title: status.upstream ?? '' }, status.branch)
          : null,
        hasRepo && status.detached === true ? h('span', { className: 'mrc-branch' }, t('detached')) : null,
        hasRepo && (status.ahead > 0 || status.behind > 0)
          ? h('span', {
            className: 'mrc-aheadBehind',
            // The arrows are the least self-explanatory thing in the header:
            // spell out which side each count belongs to, so "↑3" reads as
            // "3 commits still to push" and not "3 commits downloaded".
            title: [
              status.ahead > 0 ? t('aheadTitle', { count: status.ahead }) : '',
              status.behind > 0 ? t('behindTitle', { count: status.behind }) : ''
            ].filter((line) => line !== '').join('\n')
          },
          status.ahead > 0 ? `↑${status.ahead}` : '',
          status.behind > 0 ? `↓${status.behind}` : '')
          : null,
        hasRepo
          ? h('span', { className: 'mrc-rootCount', title: root.path },
            added > 0 ? h('span', { className: 'mrc-add' }, `+${added}`) : null,
            removed > 0 ? h('span', { className: 'mrc-del' }, `−${removed}`) : null,
            h('span', { className: 'mrc-files' }, t('files', { count: entries.length })))
          : null),

        open ? h('div', { className: 'mrc-rootBody' },
          hasRepo === false
            ? h('div', { className: 'mrc-note' },
              status.nestedIn !== undefined
                ? `${t('nestedIn')}: ${status.nestedIn}`
                : (status.error !== undefined ? `${t('readFailed')}: ${status.error}` : t('notRepo')))
            : null,
          hasRepo && entries.length === 0 ? h('div', { className: 'mrc-note' }, t('emptyRoot')) : null,
          hasRepo && status.truncated === true ? h('div', { className: 'mrc-note' }, t('truncated')) : null,
          hasRepo && tree.length > 0 ? h('div', { className: 'mrc-tree' }, tree.map((node, index) => renderNode(node, 0, `${root.path}:${index}`))) : null,
          // Every REPO gets the action box, not only repos with pending
          // changes: after a clean commit (or on an already-clean repo) the
          // user still needs the Push button to send that commit upstream.
          hasRepo
            ? h(CommitBox, { root, t, sessionId, onCommitted, refreshTick })
            : null,
          hasRepo
            ? h(CommitSection, {
              root,
              t,
              limit: commitLimit,
              selected: selectedCommit,
              onSelectCommit,
              refreshSignal: historyTick,
              refreshTick
            })
            : null)
          : null);
    }

    /** The tab's page body. */
    function MultiRootChangesTab(props) {
      const { scope, visible } = props;
      const t = useCopy();
      const sessionId = scope?.sessionId;
      const cwd = scope?.cwd;
      const [state, setState] = useState({ loading: true, error: null, data: null });
      const [selected, setSelected] = useState(null);
      const [selectedCommit, setSelectedCommit] = useState(null);
      const [tick, setTick] = useState(0);
      // Bumped on every successful commit AND push. `tick` re-reads /state;
      // `historyTick` travels to each CommitSection, which re-fetches /log and
      // expands itself so the freshly-pushed history is actually on screen.
      const [historyTick, setHistoryTick] = useState(0);
      // Bumped by both refresh buttons: the toolbar one re-reads the open diff
      // along with /state, the preview one re-reads that diff alone.
      const [diffTick, setDiffTick] = useState(0);
      // Bumped ONLY by the toolbar refresh button. It re-reads each root's
      // commit history and clears stale commit/push messages, so an external
      // commit becomes visible without a commit action inside this panel.
      const [manualTick, setManualTick] = useState(0);
      // A parked tab body polls nothing; the host keeps every visited tab body
      // mounted, so an ungated timer would run panels nobody can see.
      const onScreen = visible !== false;

      useEffect(() => {
        if (!onScreen || sessionId === undefined) return undefined;
        let live = true;
        const load = () => {
          postJson('/state', { sessionId, cwd })
            .then((data) => { if (live) setState({ loading: false, error: null, data }); })
            .catch((error) => { if (live) setState((prev) => ({ loading: false, error: error.message, data: prev.data })); });
        };
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => { live = false; window.clearInterval(timer); };
      }, [onScreen, sessionId, cwd, tick]);

      const onSelectEntry = useCallback((root, entry) => {
        // A file and a commit share the ONE preview pane: opening either retires
        // the other, so the pane never claims to show two things at once.
        setSelectedCommit(null);
        setSelected((prev) => {
          if (prev !== null && prev.root === root && prev.entry.path === entry.path) return null;
          return { root, entry };
        });
      }, []);

      const onSelectCommit = useCallback((root, commit) => {
        setSelected(null);
        setSelectedCommit((prev) => {
          if (prev !== null && prev.root === root && prev.hash === commit.hash) return null;
          return { root, hash: commit.hash, commit };
        });
      }, []);

      const roots = state.data?.roots ?? [];
      const totalFiles = roots.reduce((sum, root) => sum + (root.status?.entries?.length ?? 0), 0);

      return h('div', {
        className: 'mrc-panel',
        // Drives the left/right split: the stylesheet switches on this one
        // attribute instead of two different component trees.
        'data-preview': selected !== null || selectedCommit !== null ? 'true' : undefined
      },
        h('div', { className: 'mrc-bar' },
          h('span', { className: 'mrc-title' }, t('tab')),
          h('span', { className: 'mrc-total' }, state.loading ? t('loading') : t('files', { count: totalFiles })),
          h('button', {
            type: 'button',
            className: 'mrc-iconButton',
            title: t('refresh'),
            'aria-label': t('refresh'),
            onClick: () => {
              setTick((value) => value + 1);
              setDiffTick((value) => value + 1);
              setManualTick((value) => value + 1);
            }
          }, '↻')),

        state.error !== null
          ? h('div', { className: 'mrc-note mrc-error' }, `${t('readFailed')}: ${state.error}`)
          : null,

        state.data !== null && state.data.registryFound === false && roots.length <= 1
          ? h('div', { className: 'mrc-note' }, t('registryMissing'))
          : null,

        roots.length === 0 && state.loading ? h('div', { className: 'mrc-note' }, t('loading')) : null,
        roots.length === 0 && !state.loading ? h('div', { className: 'mrc-note' }, t('empty')) : null,

        // One row: the root list and the preview side by side (see .mrc-body).
        h('div', { className: 'mrc-body' },
          h('div', { className: 'mrc-rootsWrap' },
            h('div', { className: 'mrc-roots' }, roots.map((root) => h(RootSection, {
              key: root.path,
              root,
              t,
              selected,
              onSelectEntry,
              selectedCommit,
              onSelectCommit,
              commitLimit: COMMIT_LIMIT,
              sessionId,
              historyTick,
              refreshTick: manualTick,
              onCommitted: () => {
                setTick((value) => value + 1);
                setHistoryTick((value) => value + 1);
              }
            })))),

          selected !== null
            ? h('div', { className: 'mrc-diffPane' },
              h('div', { className: 'mrc-diffBar' },
                h('span', { className: 'mrc-diffTitle', title: selected.entry.path },
                  `${selected.entry.origPath !== undefined ? `${selected.entry.origPath} → ` : ''}${selected.entry.path}`),
                h('button', {
                  type: 'button',
                  className: 'mrc-iconButton',
                  title: t('refresh'),
                  'aria-label': t('refresh'),
                  onClick: () => setDiffTick((value) => value + 1)
                }, '↻'),
                h('button', {
                  type: 'button',
                  className: 'mrc-iconButton',
                  title: 'Close',
                  'aria-label': 'Close',
                  onClick: () => setSelected(null)
                }, '×')),
              h(DiffView, { key: `${selected.root}:${selected.entry.path}`, root: selected.root, entry: selected.entry, t, refreshTick: diffTick }))
            : null,

          selectedCommit !== null
            ? h('div', { className: 'mrc-diffPane' },
              h('div', { className: 'mrc-diffBar' },
                h('span', { className: 'mrc-diffTitle', title: selectedCommit.hash },
                  `${selectedCommit.commit.shortHash ?? selectedCommit.hash.slice(0, 7)} · ${selectedCommit.commit.subject}`),
                h('button', {
                  type: 'button',
                  className: 'mrc-iconButton',
                  title: 'Close',
                  'aria-label': 'Close',
                  onClick: () => setSelectedCommit(null)
                }, '×')),
              h(CommitView, { key: `${selectedCommit.root}:${selectedCommit.hash}`, root: selectedCommit.root, hash: selectedCommit.hash, t }))
            : null));
    }

    /** The panel's stylesheet, injected once. */
    const STYLE_ID = 'dsh-multi-root-changes-style';
    const CSS = `
/* A SOLID surface, not a translucent one.
   Theme plugins (dsh-background-studio's glass mode, for one) rewrite the
   --dsw-alias-bg-base alias to transparent on #root so wallpapers show through
   the shell. A panel that paints transparent on top of that inherits the hole:
   the conversation behind it becomes visible THROUGH this panel, and in
   fullscreen mode the two layers interleave into exactly the display corruption
   this rule prevents. Painting layer-1 (an opaque alias) keeps the panel a
   panel whatever the shell does, and isolation starts a new stacking context
   so nothing inside can blend with the page behind it either. */
/* The host's tab-strip row ABOVE the panel is a sibling of the pane body, so no
   rule inside .mrc-panel can reach it. That row has NO background of its own:
   it inherits the right sidebar's surface, which wallpaper/glass themes rewrite
   to transparent on #root. The result is a 38px band where the conversation
   behind the sidebar bleeds through the tab titles — the panel body below is
   already opaque, but the strip is not.

   :has() scopes this to the ONE dockkit pane that actually hosts our panel, so
   other tabs keep whatever surface the theme gives them. layer-1 is an opaque
   alias even in glass mode (that theme only clears bg-base and sidebar-fill). */
[data-dockkit-pane]:has(.mrc-panel) [class*="tabHostHeader"],
[data-dockkit-pane]:has(.mrc-panel) [class*="tabStrip"] {
  background-color: var(--dsw-alias-bg-layer-1, #161b19) !important;
}
.mrc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); font-size: 12px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #161b19));
  background-color: var(--dsw-alias-bg-layer-1, #161b19);
  isolation: isolate; }
.mrc-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none;
  background: var(--dsw-alias-bg-layer-1, transparent); }
.mrc-title { font-weight: 600; }
.mrc-total { color: var(--dsw-alias-label-tertiary); margin-left: auto; font-size: 11px; }
.mrc-iconButton { border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; border-radius: 4px; width: 20px; height: 20px; line-height: 1; font-size: 13px; }
.mrc-iconButton:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mrc-roots { flex: 1; min-height: 0; overflow: auto; }
.mrc-root { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mrc-rootHead { display: flex; align-items: center; gap: 6px; width: 100%; border: 0;
  background: transparent; color: inherit; cursor: pointer; padding: 6px 8px; text-align: left; font: inherit; }
.mrc-rootHead:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrc-caret { display: inline-block; width: 10px; color: var(--dsw-alias-label-tertiary);
  transform: rotate(0deg); transition: transform .12s ease; }
.mrc-caretOpen { transform: rotate(90deg); }
.mrc-rootLabel { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrc-tag { font-size: 10px; padding: 0 4px; border-radius: 3px; flex: none;
  color: var(--dsw-alias-label-tertiary); border: 1px solid var(--dsw-alias-border-l2); }
.mrc-tagAlt { border-style: dashed; }
.mrc-branch { color: var(--dsw-alias-label-tertiary); font-size: 11px; flex: none; max-width: 90px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrc-aheadBehind { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mrc-rootCount { margin-left: auto; display: flex; gap: 6px; align-items: center; flex: none; }
.mrc-files { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mrc-add { color: var(--dsw-alias-state-success-primary); }
.mrc-del { color: var(--dsw-alias-state-error-primary); }
.mrc-rootBody { padding-bottom: 4px; }
.mrc-tree { display: flex; flex-direction: column; }
.mrc-row { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent;
  color: inherit; cursor: pointer; font: inherit; text-align: left; padding: 2px 8px; line-height: 18px; }
.mrc-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrc-rowActive { background: var(--dsw-alias-interactive-bg-active); }
.mrc-dirRow { color: var(--dsw-alias-label-secondary); }
.mrc-dirName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrc-dirCount { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.mrc-badge { flex: none; width: 12px; text-align: center; font-size: 10px; font-weight: 700; }
.mrc-badge-M { color: var(--dsw-alias-state-warn-primary); }
.mrc-badge-A { color: var(--dsw-alias-state-success-primary); }
.mrc-badge-D { color: var(--dsw-alias-state-error-primary); }
.mrc-badge-R, .mrc-badge-C { color: var(--dsw-alias-state-business-primary); }
.mrc-badge-\\? { color: var(--dsw-alias-state-success-primary); }
.mrc-badge-U { color: var(--dsw-alias-state-error-primary); }
.mrc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrc-counts { margin-left: auto; display: flex; gap: 4px; font-size: 10px; flex: none; }
.mrc-note { padding: 6px 12px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.mrc-ok { color: var(--dsw-alias-state-success-primary); }
/* The commit box sits between the file tree and the history: message first,
   then the actions (AI draft / Push / Commit) on one row so the panel stays
   dense. Commit is the brand-filled primary action; Push is a secondary
   outline button so the two write actions read as different strengths. */
.mrc-commitBox { border-top: 1px dashed var(--dsw-alias-border-l1); padding: 6px 8px; display: flex;
  flex-direction: column; gap: 4px; }
.mrc-commitInput { width: 100%; box-sizing: border-box; resize: vertical; min-height: 34px;
  font: inherit; font-size: 11px; line-height: 16px; padding: 4px 6px; border-radius: 4px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.18));
  border: 1px solid var(--dsw-alias-border-l2); }
.mrc-commitInput:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.mrc-commitActions { display: flex; align-items: center; gap: 6px; }
/* One line that names the difference between the two write actions, because
   "提交" and "推送" read like synonyms to anyone who is not a git daily user:
   commit saves locally, push uploads to the remote. */
.mrc-flowHint { color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 14px; }
.mrc-commitCount { color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.mrc-aiButton { margin-left: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;

  font: inherit; font-size: 11px; padding: 2px 8px; }
.mrc-aiButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.mrc-pushButton { border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-state-business-primary); cursor: pointer;
  font: inherit; font-size: 11px; padding: 2px 10px; font-weight: 600; }
.mrc-pushButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mrc-commitButton { border: 0; border-radius: 4px; cursor: pointer; font: inherit; font-size: 11px;
  padding: 3px 10px; font-weight: 600;
  /* The label must not read its colour from a SURFACE alias: theme plugins
     rewrite --dsw-alias-bg-base to transparent (glass mode), which turned this
     text invisible on the brand-coloured button. A fixed dark ink on the brand
     fill is legible in both themes and independent of what the shell does to
     its surface tokens. */
  background: var(--dsw-alias-state-business-primary);
  color: #0b0f14; }
.mrc-commitButton:hover:not(:disabled) { filter: brightness(1.08); }
.mrc-aiButton:disabled, .mrc-pushButton:disabled, .mrc-commitButton:disabled { opacity: .45; cursor: default; }
.mrc-error { color: var(--dsw-alias-state-error-primary); }
/* Left/right split while a file or commit is open, stacked while it is not.
   The panel is a narrow column, so a vertical split (tree above, diff below) ate
   the list down to a few rows; putting the preview BESIDE the list keeps the
   tree readable at the panel's real width. The data-preview attribute drives the
   switch — one layout rule, not two component trees. */
.mrc-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mrc-panel[data-preview='true'] .mrc-body { flex-direction: row; }
.mrc-diffPane { flex: none; max-height: 45%; min-height: 120px; display: flex; flex-direction: column;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1, #161b19); isolation: isolate; }
.mrc-panel[data-preview='true'] .mrc-diffPane {
  flex: 1 1 55%; max-height: none; min-height: 0; min-width: 0;
  border-top: 0; border-left: 1px solid var(--dsw-alias-border-l1); }
.mrc-panel[data-preview='true'] .mrc-rootsWrap { flex: 1 1 45%; min-width: 160px; min-height: 0;
  display: flex; flex-direction: column; border-right: 1px solid var(--dsw-alias-border-l1); }
.mrc-rootsWrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mrc-diffBar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mrc-diffTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
  font-family: var(--ds-font-family-code); font-size: 11px; }
.mrc-diff { overflow: auto; flex: 1; min-height: 0; font-family: var(--ds-font-family-code); font-size: 11px; }
.mrc-line { display: flex; gap: 8px; padding: 0 8px; white-space: pre; }
.mrc-lineNo { color: var(--dsw-alias-label-tertiary); min-width: 34px; text-align: right; flex: none;
  user-select: none; }
.mrc-lineText { white-space: pre; }
/* The +/- gutter keeps the markdown-copyable shape of a unified diff and gives
   the eye a second, position-stable cue independent of colour. */
.mrc-sign { flex: none; width: 8px; text-align: center; user-select: none; opacity: 1;
  font-weight: 700; }
/* Diff rows are marked THREE ways, because a tinted background alone is not
   enough: at 12% the fill was invisible next to the surface, and the text itself
   stayed the theme's label colour so nothing told the eye where a change began.

   The text colour is MIXED WITH THE LABEL COLOUR rather than set to the raw
   state colour: the state-success alias is a bright green chosen to sit on a
   DARK surface, and painting it on its own 18% tint measured 1.96:1 — worse
   than the plain row it replaced. Mixing 55% of the theme's primary label into
   it keeps the hue recognisable while pulling the value toward the text colour
   that is already known to be readable on this surface. */
.mrc-lineAdd { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-success-primary); }
.mrc-lineAdd .mrc-lineText, .mrc-lineAdd .mrc-lineNo, .mrc-lineAdd .mrc-sign {
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-label-primary)); }
.mrc-lineDel { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent);
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-error-primary); }
.mrc-lineDel .mrc-lineText, .mrc-lineDel .mrc-lineNo, .mrc-lineDel .mrc-sign {
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-label-primary)); }
.mrc-hunk { padding: 2px 8px; color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-2); white-space: pre; font-weight: 600; }
.mrc-fileHead { padding: 1px 8px; color: var(--dsw-alias-label-tertiary); white-space: pre; }
.mrc-diffNote { padding: 8px 12px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mrc-commits { border-top: 1px dashed var(--dsw-alias-border-l1); margin-top: 2px; }
.mrc-commitToggle { display: flex; align-items: center; gap: 6px; width: 100%; border: 0;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  font: inherit; text-align: left; padding: 4px 8px; font-size: 11px; }
.mrc-commitToggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrc-commitList { display: flex; flex-direction: column; padding-bottom: 4px; }
.mrc-commitRow { display: flex; align-items: center; gap: 6px; width: 100%; border: 0;
  background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left;
  padding: 2px 8px 2px 20px; line-height: 18px; font-size: 11px; }
.mrc-commitRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrc-commitDot { color: var(--dsw-alias-state-business-primary); font-size: 8px; flex: none; }
.mrc-commitSubject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.mrc-commitWhen { color: var(--dsw-alias-label-tertiary); font-size: 10px; flex: none; }
.mrc-ref { font-size: 9px; padding: 0 4px; border-radius: 3px; flex: none; max-width: 110px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-state-business-primary); border: 1px solid var(--dsw-alias-border-l2); }
.mrc-commitMeta { padding: 8px 12px 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mrc-commitHash { font-family: var(--ds-font-family-code); font-size: 11px;
  color: var(--dsw-alias-state-business-primary); }
.mrc-commitAuthor { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.mrc-commitBody { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 6px;
  white-space: pre-wrap; }
`;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    /** A small inline glyph: a stack of branches, drawn in currentColor. */
    function MultiRootIcon(props) {
      const size = props?.size ?? 14;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': 'true'
      },
      h('path', { d: 'M3.5 2.5v7' }),
      h('circle', { cx: '3.5', cy: '11.5', r: '1.6' }),
      h('circle', { cx: '3.5', cy: '2.5', r: '1.6' }),
      h('path', { d: 'M3.5 6.5h5a2 2 0 0 1 2 2v1.6' }),
      h('circle', { cx: '12.5', cy: '11.5', r: '1.6' }));
    }

    function apply(ctx) {
      ensureStyle();

      // The tab service is published by dsh-better-sidebar, possibly AFTER this
      // plugin's own activation: reconcile on the service event instead of
      // requiring a mount order that belongs to another package.
      let current = null;
      const reconcile = () => {
        const service = ctx.get('betterSidebar');
        if (current?.service === service) return;
        current?.dispose();
        current = undefined;
        if (service === undefined) return;
        try {
          current = {
            service,
            dispose: service.registerTab({
              id: TAB_ID,
              title: () => (isZh() ? COPY.zh.tab : COPY.en.tab),
              description: () => (isZh() ? COPY.zh.tabDesc : COPY.en.tabDesc),
              icon: (size) => h(MultiRootIcon, { size }),
              order: 25,
              single: true,
              component: (props) => h(MultiRootChangesTab, props)
            })
          };
        } catch (error) {
          // A duplicate registration (a reload that did not dispose) must not
          // take the whole plugin tree down.
          console.error('[dsh-multi-root-changes] tab registration failed:', error);
          current = undefined;
        }
      };

      ctx.effect(() => {
        reconcile();
        const offService = ctx.on('internal/service', (name) => {
          if (name === 'betterSidebar') reconcile();
        });
        return () => {
          offService?.();
          current?.dispose();
          current = undefined;
          document.getElementById(STYLE_ID)?.remove();
        };
      }, 'multi-root-changes: sidebar tab');
    }

    const module = { exports: { apply, name: 'dsh-multi-root-changes' } };
    module.exports.__test = { buildTree, statusLetter, baseName, formatTime };
    return module.exports;
  }
});

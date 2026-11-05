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
        tooLarge: '文件过大，仅显示前一部分'
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
        tooLarge: 'File too large; showing the beginning only'
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

    /** The diff reader: a unified patch, or a new file's whole content. */
    function DiffView(props) {
      const { root, entry, t } = props;
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
      }, [root, entry.path, entry.origPath, entry.x, entry.y, entry.untracked]);

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
            h('span', { className: 'mrc-lineNo' }, String(index + 1)), h('span', { className: 'mrc-lineText' }, line))));
      }

      const patch = String(data.patch ?? '');
      if (patch.trim() === '') return h('div', { className: 'mrc-diffNote' }, t('diffEmpty'));

      // A patch is rendered by KEEPING git's own hunk structure: header lines
      // start a new section, +/- lines are the content, and everything else is
      // context. Nothing needs to be recomputed or re-numbered.
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
          || line.startsWith('similarity') || line.startsWith('rename ')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-fileHead' }, line));
          continue;
        }
        if (line.startsWith('+')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-line mrc-lineAdd' },
            h('span', { className: 'mrc-lineNo' }, String(newNo)), h('span', { className: 'mrc-lineText' }, line.slice(1))));
          newNo += 1;
          continue;
        }
        if (line.startsWith('-')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-line mrc-lineDel' },
            h('span', { className: 'mrc-lineNo' }, String(oldNo)), h('span', { className: 'mrc-lineText' }, line.slice(1))));
          oldNo += 1;
          continue;
        }
        if (line.startsWith('\\')) {
          rows.push(h('div', { key: rows.length, className: 'mrc-fileHead' }, line));
          continue;
        }
        rows.push(h('div', { key: rows.length, className: 'mrc-line' },
          h('span', { className: 'mrc-lineNo' }, String(oldNo)), h('span', { className: 'mrc-lineText' }, line.slice(1))));
        oldNo += 1;
        newNo += 1;
      }
      return h('div', { className: 'mrc-diff' }, rows);
    }

    /** One root's collapsible section: header, counters, tree. */
    function RootSection(props) {
      const { root, t, selected, onSelectEntry } = props;
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
          ? h('span', { className: 'mrc-aheadBehind' },
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
          hasRepo && tree.length > 0 ? h('div', { className: 'mrc-tree' }, tree.map((node, index) => renderNode(node, 0, `${root.path}:${index}`))) : null)
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
      const [tick, setTick] = useState(0);
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
        setSelected((prev) => {
          if (prev !== null && prev.root === root && prev.entry.path === entry.path) return null;
          return { root, entry };
        });
      }, []);

      const roots = state.data?.roots ?? [];
      const totalFiles = roots.reduce((sum, root) => sum + (root.status?.entries?.length ?? 0), 0);

      return h('div', { className: 'mrc-panel' },
        h('div', { className: 'mrc-bar' },
          h('span', { className: 'mrc-title' }, t('tab')),
          h('span', { className: 'mrc-total' }, state.loading ? t('loading') : t('files', { count: totalFiles })),
          h('button', {
            type: 'button',
            className: 'mrc-iconButton',
            title: t('refresh'),
            'aria-label': t('refresh'),
            onClick: () => setTick((value) => value + 1)
          }, '↻')),

        state.error !== null
          ? h('div', { className: 'mrc-note mrc-error' }, `${t('readFailed')}: ${state.error}`)
          : null,

        state.data !== null && state.data.registryFound === false && roots.length <= 1
          ? h('div', { className: 'mrc-note' }, t('registryMissing'))
          : null,

        roots.length === 0 && state.loading ? h('div', { className: 'mrc-note' }, t('loading')) : null,
        roots.length === 0 && !state.loading ? h('div', { className: 'mrc-note' }, t('empty')) : null,

        h('div', { className: 'mrc-roots' }, roots.map((root) => h(RootSection, {
          key: root.path,
          root,
          t,
          selected,
          onSelectEntry
        }))),

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
                onClick: () => setSelected((prev) => (prev === null ? null : { ...prev }))
              }, '↻'),
              h('button', {
                type: 'button',
                className: 'mrc-iconButton',
                title: 'Close',
                'aria-label': 'Close',
                onClick: () => setSelected(null)
              }, '×')),
            h(DiffView, { key: `${selected.root}:${selected.entry.path}`, root: selected.root, entry: selected.entry, t }))
          : null);
    }

    /** The panel's stylesheet, injected once. */
    const STYLE_ID = 'dsh-multi-root-changes-style';
    const CSS = `
.mrc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); font-size: 12px; background: transparent; }
.mrc-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
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
.mrc-error { color: var(--dsw-alias-state-error-primary); }
.mrc-diffPane { flex: none; max-height: 45%; min-height: 120px; display: flex; flex-direction: column;
  border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.mrc-diffBar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mrc-diffTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
  font-family: var(--ds-font-family-code); font-size: 11px; }
.mrc-diff { overflow: auto; flex: 1; min-height: 0; font-family: var(--ds-font-family-code); font-size: 11px; }
.mrc-line { display: flex; gap: 8px; padding: 0 8px; white-space: pre; }
.mrc-lineNo { color: var(--dsw-alias-label-tertiary); min-width: 34px; text-align: right; flex: none;
  user-select: none; }
.mrc-lineText { white-space: pre; }
.mrc-lineAdd { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.mrc-lineDel { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.mrc-hunk { padding: 2px 8px; color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-2); white-space: pre; }
.mrc-fileHead { padding: 1px 8px; color: var(--dsw-alias-label-tertiary); white-space: pre; }
.mrc-diffNote { padding: 8px 12px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
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
    module.exports.__test = { buildTree, statusLetter, baseName };
    return module.exports;
  }
});

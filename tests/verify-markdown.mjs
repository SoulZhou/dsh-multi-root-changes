/**
 * Verify the Markdown renderer in client.js WITHOUT a browser.
 *
 * The renderer is a set of pure functions inside client.js's module closure,
 * so import() cannot reach it. Instead we extract the exact source region
 * (from `function safeMarkdownUrl` through `function isMarkdownPath`) and run
 * it in a `vm` with a mock `createElement` that records the element tree.
 * This proves that:
 *   - headings / bold / italic / code / links / lists / quotes / rules /
 *     fenced code / tables all produce the expected tag shapes,
 *   - unsafe link schemes (javascript:, data:) degrade to plain text,
 *   - every piece of file content is a TEXT node, never an HTML string.
 *
 * Run with: node tests/verify-markdown.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const clientSrc = readFileSync(join(here, '..', 'client.js'), 'utf8');

const start = clientSrc.indexOf('function safeMarkdownUrl');
const endMark = 'function isMarkdownPath(path) {';
const end = clientSrc.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.log('FAIL  could not locate markdown renderer source region');
  process.exit(1);
}
// Include isMarkdownPath itself (up to its closing brace + newline).
const afterEnd = clientSrc.indexOf('\n    }', end);
const region = clientSrc.slice(start, afterEnd + 6);

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

// A recording createElement: type, props, children — exactly what React would
// receive. Text is kept as plain strings so we can assert nothing is HTML.
function h(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(3).filter((c) => c !== null && c !== undefined && c !== false) };
}
function flattenText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (node && typeof node === 'object') return node.children.map(flattenText).join('');
  return '';
}
function tags(node, type) {
  const found = [];
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (n.type === type) found.push(n);
    n.children.forEach(walk);
  };
  walk(node);
  return found;
}

const ctx = { h, console };
vm.createContext(ctx);
vm.runInContext(region + '\nthis.MarkdownBody = MarkdownBody; this.isMarkdownPath = isMarkdownPath; this.safeMarkdownUrl = safeMarkdownUrl;', ctx);
const { MarkdownBody, isMarkdownPath, safeMarkdownUrl } = ctx;

console.log('\n=== markdown path detection ===');
for (const p of ['a.md', 'README.MD', 'doc.markdown', 'notes.mdown', 'x.mkd']) {
  check(`detects ${p}`, isMarkdownPath(p) === true);
}
for (const p of ['a.txt', 'a.mdx', 'md', 'a.md.bak']) {
  check(`rejects ${p}`, isMarkdownPath(p) === false);
}

console.log('\n=== link scheme safety ===');
check('https allowed', safeMarkdownUrl('https://example.com') === 'https://example.com');
check('mailto allowed', safeMarkdownUrl('mailto:a@b.c') === 'mailto:a@b.c');
check('in-page anchor allowed', safeMarkdownUrl('#section') === '#section');
check('javascript: blocked', safeMarkdownUrl('javascript:alert(1)') === null);
check('data: blocked', safeMarkdownUrl('data:text/html,x') === null);
check('vbscript: blocked', safeMarkdownUrl('vbscript:msgbox') === null);

console.log('\n=== block rendering ===');
const doc = [
  '# Title',
  '',
  'A **bold** and *italic* word with `code` and [link](https://x.test).',
  '',
  '- one',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted line',
  '',
  '---',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '[bad](javascript:alert(1))'
].join('\n');
const tree = MarkdownBody({ content: doc });
const text = flattenText(tree);
check('renders as .mrc-markdown root', tree.type === 'div' && tree.props.className === 'mrc-markdown');
check('one h1 with the title', tags(tree, 'h1').length === 1 && flattenText(tags(tree, 'h1')[0]).includes('Title'));
check('bold is a <strong>', tags(tree, 'strong').length >= 1);
check('italic is an <em>', tags(tree, 'em').length >= 1);
check('inline code is a <code>', tags(tree, 'code').length >= 2);
check('safe link is an <a> with target/rel', (() => {
  const a = tags(tree, 'a')[0];
  return a && a.props.href === 'https://x.test' && a.props.target === '_blank' && /noopener/.test(a.props.rel);
})());
check('no <a> for javascript: link', tags(tree, 'a').length === 1, `anchors=${tags(tree, 'a').length}`);
check('unsafe link text still visible', text.includes('bad'));
check('unordered list has 2 <li>', tags(tree, 'ul').length === 1 && tags(tags(tree, 'ul')[0], 'li').length === 2);
check('ordered list has 2 <li>', tags(tree, 'ol').length === 1 && tags(tags(tree, 'ol')[0], 'li').length === 2);
check('blockquote present', tags(tree, 'blockquote').length === 1);
check('horizontal rule present', tags(tree, 'hr').length === 1);
check('fenced code becomes <pre><code>', tags(tree, 'pre').length === 1 && flattenText(tags(tree, 'pre')[0]).includes('const x = 1;'));
check('table has thead + tbody rows', tags(tree, 'table').length === 1 &&
  tags(tree, 'th').length === 2 && tags(tree, 'td').length === 2);

console.log('\n=== injection safety ===');
const evil = MarkdownBody({ content: '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>' });
const evilText = flattenText(evil);
check('raw HTML is NOT parsed into elements', tags(evil, 'img').length === 0 && tags(evil, 'script').length === 0);
check('raw HTML kept as inert text', evilText.includes('<img') && evilText.includes('<script'));

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

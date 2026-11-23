/* A STAT WIDGET CAN SHOW MORE THAN ONE CAPTION LINE.
 *
 * A stat tile showed exactly one caption: the first column after the
 * value. "captions" names the columns to show instead, one line each, in
 * order. These gates pin the rules: without "captions" nothing changes;
 * a named column that is missing or empty gives no line; every named
 * line stays on one line (never wraps, ends in an ellipsis, full text on
 * hover); lines two and on are a bulleted list the plugin draws; the
 * lines drop from the last one up when space runs short, and the number
 * and the pill never move; the spec validator
 * names what is wrong in plain words; the option survives the spec file,
 * the edit form and the desktop cache. Every value here is invented.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadPlugin, makeFakeAdapter } from './harness.mjs';

const { lib, obsidian } = loadPlugin();

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function byClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }
function freshEl() { return new obsidian.Modal({}).contentEl; }
const parse = (tile) => lib.parseDashboardSpec(JSON.stringify({ id: 'cl', title: 'Lines', database: '07 Data/x.db', tiles: [tile] }));
const statTile = (extra) => Object.assign({ title: 'Index', viz: 'stat', y: 'value', sql: 'SELECT 1 AS value' }, extra);
const TABLE = { columns: ['value', 'change', 'window', 'source'], rows: [[42, 'up 2 vs. last week', 'last 7 days', 'Scale A']] };
const captionsOf = (el) => byClass(el, 'icor-sqlv-stat-caption').map((c) => c.textContent);

function draw(tile, table) {
  const el = freshEl();
  lib.renderTile(el, tile, table || TABLE, {});
  return el;
}

test('THE LIMIT: without "captions" a stat still shows exactly one caption, the next column', () => {
  assert.deepEqual(captionsOf(draw({ title: 'Index', viz: 'stat', y: ['value'] })), ['up 2 vs. last week']);
  assert.deepEqual([...lib.statOf(TABLE, { y: ['value'] }).captions], ['up 2 vs. last week']);
  assert.deepEqual(captionsOf(draw({ viz: 'stat', y: ['value'] }, { columns: ['value'], rows: [[1]] })), [], 'no other column, no caption');
});

test('"captions" shows each named column as its own line, in the order given', () => {
  const el = draw({ title: 'Index', viz: 'stat', y: ['value'], captions: ['change', 'window', 'source'] });
  assert.deepEqual(captionsOf(el), ['up 2 vs. last week', 'last 7 days', 'Scale A']);
  assert.deepEqual(byClass(el, 'icor-sqlv-stat-caption').map((c) => c.getAttribute('title')), ['up 2 vs. last week', 'last 7 days', 'Scale A'],
    'a cut line keeps its full text on hover');
});

test('the first named line stays plain; lines two and on are a bulleted list the plugin draws', () => {
  const el = draw({ title: 'Index', viz: 'stat', y: ['value'], captions: ['change', 'window', 'source'] });
  const stat = byClass(el, 'icor-sqlv-stat')[0];
  assert.deepEqual(stat.children.map((c) => [...c.classSet][0]), ['icor-sqlv-stat-value', 'icor-sqlv-stat-caption', 'icor-sqlv-stat-bullets']);
  const [first, list] = stat.children.slice(1);
  assert.equal(first.tagName, 'DIV');
  assert.equal(first.classSet.has('is-bullet'), false);
  assert.equal(list.tagName, 'UL');
  assert.deepEqual(list.children.map((li) => [li.tagName, li.textContent, li.classSet.has('is-bullet')]),
    [['LI', 'last 7 days', true], ['LI', 'Scale A', true]]);
  assert.equal(list.children.some((li) => /^[\u2022\-*]/.test(li.textContent)), false, 'the bullet is drawn, never typed into the text');
  const one = draw({ viz: 'stat', y: ['value'], captions: ['change'] });
  assert.equal(byClass(one, 'icor-sqlv-stat-bullets').length, 0, 'one named line, no list');
});

test('every named line is one line; the one caption without "captions" keeps its two-line clamp', () => {
  const el = draw({ viz: 'stat', y: ['value'], captions: ['change', 'window'] });
  assert.deepEqual(byClass(el, 'icor-sqlv-stat-caption').map((c) => c.classSet.has('is-line')), [true, true]);
  const legacy = draw({ viz: 'stat', y: ['value'] });
  assert.equal(byClass(legacy, 'icor-sqlv-stat-caption')[0].classSet.has('is-line'), false, 'back-compatible');
  const css = fs.readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
  const rule = /\.icor-sqlv-stat-caption\.is-line \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the one-line rule exists');
  assert.match(rule[1], /white-space: nowrap/);
  assert.match(rule[1], /text-overflow: ellipsis/);
  assert.match(rule[1], /overflow: hidden/);
  assert.match(css, /\.icor-sqlv-stat-caption\.is-bullet::before \{[^}]*content: '\\2022'/, 'the plugin draws the bullet');
});

test('a named column that is missing, null or empty gives no line, never an error', () => {
  const table = { columns: ['value', 'a', 'b'], rows: [[1, null, '']] };
  const el = draw({ viz: 'stat', y: ['value'], captions: ['a', 'b', 'nope'] }, table);
  assert.deepEqual(captionsOf(el), []);
  assert.equal(byClass(el, 'icor-sqlv-error').length, 0);
  assert.deepEqual(captionsOf(draw({ viz: 'stat', y: ['value'], captions: ['nope', 'source'] })), ['Scale A']);
});

test('the spec validator keeps "captions" and names what is wrong, in plain words', () => {
  const ok = parse(statTile({ captions: [' change ', 'window'] }));
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual([...ok.spec.tiles[0].captions], ['change', 'window']);
  assert.equal(parse(statTile({})).spec.tiles[0].captions, undefined);
  const bad = [
    [statTile({ captions: 'change' }), /"captions" must be a list of 1 to 4 column names/],
    [statTile({ captions: [] }), /"captions" must be a list/],
    [statTile({ captions: ['a', 'b', 'c', 'd', 'e'] }), /"captions" must be a list of 1 to 4/],
    [statTile({ captions: ['a', ''] }), /"captions" must be a list/],
    [{ title: 'L', viz: 'line', x: 'd', y: 'v', sql: 'SELECT 1 AS d, 2 AS v', captions: ['a'] }, /only work on a stat widget/],
    [{ title: 'B', viz: 'stat', captions: ['a'], source: { table: 't', metric: 'v', agg: 'avg' } }, /only work on an SQL stat widget/],
  ];
  for (const [tile, re] of bad) {
    const r = parse(tile);
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
    assert.match(r.reason, /^Tile 1: /);
  }
});

test('"captions" survive the spec file', () => {
  const json = lib.specToJson(parse(statTile({ captions: ['change', 'window'] })).spec);
  assert.deepEqual(JSON.parse(json).tiles[0].captions, ['change', 'window']);
  assert.deepEqual([...lib.parseDashboardSpec(json).spec.tiles[0].captions], ['change', 'window']);
});

/* --------------------------------------------------- giving way to space -- */

test('the steps: named lines only drop, from the last one up; the one caption still clamps first', () => {
  assert.deepEqual([...lib.statCaptionSteps(1)].map((s) => [...s]), [[''], ['is-clamped-1'], ['is-dropped']], 'one caption: unchanged');
  assert.deepEqual([...lib.statCaptionSteps(3, true)].map((s) => [...s]), [
    ['', '', ''],
    ['', '', 'is-dropped'],
    ['', 'is-dropped', 'is-dropped'],
    ['is-dropped', 'is-dropped', 'is-dropped'],
  ]);
});

test('named lines drop from the last one up until the stat fits, and come back on resize', () => {
  const observers = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { this.cb([]); }
    disconnect() {}
  }
  const fresh = loadPlugin({ globals: { ResizeObserver: FakeResizeObserver } });
  const stat = new fresh.obsidian.Modal({}).contentEl;
  const caps = [0, 1, 2].map(() => stat.createDiv({ cls: 'icor-sqlv-stat-caption' }));
  const lines = (c) => (c.classSet.has('is-dropped') ? 0 : 1);
  stat.isConnected = true;
  Object.defineProperty(stat, 'scrollHeight', { get: () => 80 + caps.reduce((n, c) => n + lines(c) * 15, 0) });
  const expect = [[200, [1, 1, 1]], [125, [1, 1, 1]], [110, [1, 1, 0]], [95, [1, 0, 0]], [85, [0, 0, 0]], [200, [1, 1, 1]]];
  stat.clientHeight = expect[0][0];
  fresh.lib.fitStatCaption(stat, caps, undefined, true);
  for (const [height, want] of expect) {
    stat.clientHeight = height;
    observers[0].cb([]);
    assert.deepEqual(caps.map(lines), want, 'at ' + height + 'px');
  }
});

/* ---------------------------------------------- the view and the cache -- */

const DASH = '07 Databases/Dashboards/cl.json';
const CACHE = '07 Databases/Dashboard Cache/dashboards/cl.json';
const SPEC = { id: 'cl', title: 'Lines', database: '07 Databases/x.db', tiles: [statTile({ captions: ['window', 'change'] })] };
const settle = () => new Promise((r) => setTimeout(r, 20));

async function makeView(files, binaries, { desktop = true } = {}) {
  const fresh = loadPlugin({ desktop });
  const adapter = makeFakeAdapter(files, binaries);
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  const view = plugin.viewFactories['icor-sqlite-viewer-dashboards']({ app });
  view.app = app;
  return { plugin, view, adapter };
}

test('a phone shows the same caption lines from the desktop cache', async () => {
  const desk = await makeView({ [DASH]: JSON.stringify(SPEC) }, { '07 Databases/x.db': new Uint8Array([1]) });
  desk.plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  desk.plugin.query.query = async () => ({ columns: TABLE.columns, rows: TABLE.rows, ms: 1 });
  await desk.view.onOpen();
  await settle();
  assert.deepEqual(captionsOf(desk.view.contentEl), ['last 7 days', 'up 2 vs. last week']);
  const cache = desk.adapter.files.get(CACHE);
  const phone = await makeView({ [DASH]: JSON.stringify(SPEC), [CACHE]: cache }, { '07 Databases/x.db': new Uint8Array([1]) }, { desktop: false });
  phone.plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big for this device.' });
  await phone.view.onOpen();
  await settle();
  assert.deepEqual(captionsOf(phone.view.contentEl), ['last 7 days', 'up 2 vs. last week']);
});

/* ---------------------------------------------------------- the edit form -- */

test('the edit screen shows the caption columns for an SQL stat tile and saves them back', async () => {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: TABLE.columns, rows: TABLE.rows, ms: 1 });
  const tile = parse(statTile({ captions: ['window', 'change'] })).spec.tiles[0];
  const spec = { id: 'd', title: 'D', database: '07 Data/x.db', globalTimeframe: { preset: '90d' }, tiles: [tile], path: 'd.json' };
  const view = { saveAndRender: async () => {} };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, 0);
  form.open();
  assert.equal(form.state.captions, 'window, change');
  const input = [...walkEl(form.formEl)].find((e) => e.tagName === 'INPUT' && e.getAttribute('aria-label') === 'Caption columns (comma-separated)');
  assert.ok(input, 'the field is on the form');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(form.previewState, 'ok');
  assert.deepEqual(captionsOf(form.previewEl), ['last 7 days', 'up 2 vs. last week'], 'the preview shows the lines');
  await form.save();
  assert.deepEqual([...spec.tiles[0].captions], ['window', 'change'], 'an edit keeps them');
  form.state.captions = 'a, b, c, d, e';
  assert.match(form.buildTile().reason, /"captions" must be a list of 1 to 4/);
  form.state.captions = '';
  assert.equal(form.buildTile().tile.captions, undefined, 'emptied, the old one-caption rule is back');
});

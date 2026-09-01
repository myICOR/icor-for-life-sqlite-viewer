/* THE FILTER FUNNEL AND THE JSON VIEW.
 *
 * 0.2.1 rules pinned here: the filter row is hidden until the funnel shows
 * it (a table at rest is a header and its rows), an active filter carries
 * a visible dot on the funnel so a hidden filter never hides data
 * silently, and every plugin surface declares INKLINE's plugin-owned
 * control boundary (data-ink-plugin). The JSON view: a dashboard spec
 * hands its leaf to the builder, any other JSON gets the reader, a big
 * file renders in part, and the text editor saves through the vault.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeFakeAdapter } from './harness.mjs';

const VIEW_BROWSER = 'icor-sqlite-viewer-browser';
const VIEW_JSON = 'icor-sqlite-viewer-json';

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function byClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }
function click(el) { for (const fn of (el.handlers && el.handlers.click) || []) fn({ preventDefault() {}, stopPropagation() {} }); }

async function makeBrowser() {
  const { makePlugin } = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async (db, sql) => {
    if (/sqlite_master/.test(sql)) return { columns: ['name', 'type'], rows: [['things', 'table']], ms: 1 };
    if (/COUNT\(\*\)/.test(sql)) return { columns: ['n'], rows: [[2]], ms: 1 };
    return { columns: ['a', 'b'], rows: [[1, 'x'], [2, 'y']], ms: 1 };
  };
  const view = plugin.viewFactories[VIEW_BROWSER]({ app });
  view.app = app;
  return { plugin, view };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('the filter row is hidden at rest; the funnel shows it; the dot marks active filters', async () => {
  const { view } = await makeBrowser();
  await view.setDatabase('07 Data/x.db');
  await settle();
  assert.equal(byClass(view.contentEl, 'icor-sqlv-filter').length, 0, 'no filter inputs at rest');
  const funnel = byClass(view.contentEl, 'icor-sqlv-funnel')[0];
  assert.ok(funnel, 'the funnel button exists on the data tab');
  assert.equal(funnel.attrs['aria-pressed'], 'false');
  assert.equal(funnel.classSet.has('has-filters'), false);

  click(funnel);
  await settle();
  assert.ok(byClass(view.contentEl, 'icor-sqlv-filter').length > 0, 'the funnel shows the filter row');
  const pressed = byClass(view.contentEl, 'icor-sqlv-funnel')[0];
  assert.equal(pressed.attrs['aria-pressed'], 'true');

  /* Hidden again with a filter active: the dot must say so. */
  view.filters = { a: 'x' };
  view.filtersVisible = false;
  view.renderMain();
  await settle();
  const dotted = byClass(view.contentEl, 'icor-sqlv-funnel')[0];
  assert.equal(dotted.classSet.has('has-filters'), true, 'an active filter shows on the funnel while hidden');
  assert.equal(byClass(view.contentEl, 'icor-sqlv-filter').length, 0);
});

test('the browser root declares the INKLINE plugin-owned control boundary', async () => {
  const { view } = await makeBrowser();
  await view.setDatabase('07 Data/x.db');
  assert.equal(view.contentEl.attrs['data-ink-plugin'], 'icor-for-life-sqlite-viewer');
});

/* ----------------------------------------------------------- JSON view -- */

async function makeJsonView(files, { size } = {}) {
  const { makePlugin } = loadPlugin();
  const adapter = makeFakeAdapter(files);
  const modified = [];
  const app = {
    vault: {
      adapter,
      getFiles: () => [],
      read: async (f) => files[f.path],
      modify: async (f, text) => { files[f.path] = text; modified.push(f.path); },
    },
    workspace: { onLayoutReady: () => {}, on: () => ({}) },
  };
  const plugin = makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  const states = [];
  const leaf = { app, setViewState: async (s) => { states.push(s); }, view: null };
  const view = plugin.viewFactories[VIEW_JSON](leaf);
  view.app = app;
  view.leaf = leaf;
  const path = Object.keys(files)[0];
  const file = { path, name: path.split('/').pop(), stat: { size: size === undefined ? files[path].length : size } };
  return { plugin, view, file, states, modified, files };
}

test('a JSON that is not a dashboard opens in the reader: pretty, read-only, with copy and edit', async () => {
  const { view, file, states } = await makeJsonView({ 'notes/data.json': '{"b":1,"a":[1,2]}' });
  await view.onLoadFile(file);
  view.file = file;
  await settle();
  assert.equal(states.length, 0, 'a plain JSON never redirects the leaf');
  const pre = byClass(view.contentEl, 'icor-sqlv-json-pre')[0];
  assert.ok(pre, 'the reader renders');
  assert.match(pre.textContent, /"b": 1/, 'pretty-printed');
  const buttons = [];
  for (const el of walkEl(view.contentEl)) if (el.tagName === 'BUTTON') buttons.push(el.textContent);
  assert.ok(buttons.includes('Copy JSON'));
  assert.ok(buttons.includes('Edit as text'));
  assert.equal(view.contentEl.attrs['data-ink-plugin'], 'icor-for-life-sqlite-viewer');
});

test('a JSON that parses as a dashboard spec hands its leaf to the builder', async () => {
  const spec = { id: 'my-dash', title: 'Mine', database: '07 Data/x.db', tiles: [{ sql: 'SELECT 1 AS one', viz: 'stat', y: 'one' }] };
  const { view, file, states } = await makeJsonView({ '07 Data/Dashboards/my-dash.json': JSON.stringify(spec) });
  await view.onLoadFile(file);
  await settle();
  assert.equal(states.length, 1, 'the leaf is redirected once');
  assert.equal(states[0].type, 'icor-sqlite-viewer-dashboards');
});

test('a cache file and a plain object are not mistaken for dashboards', () => {
  const { lib } = loadPlugin();
  const cachePayload = { dashboardId: 'x', title: 'X', computedAt: '2026-09-01T00:00:00Z', tiles: [] };
  assert.equal(lib.parseDashboardSpec(JSON.stringify(cachePayload)).ok, false, 'a cache has no id, so it is not a spec');
  assert.equal(lib.parseDashboardSpec('{"name":"pkg","version":"1.0.0"}').ok, false);
  assert.equal(lib.parseDashboardSpec('[1,2,3]').ok, false);
});

test('a big JSON shows its size and its first part, read-only, without an editor', async () => {
  const big = '{"pad":"' + 'x'.repeat(300) + '"}';
  const { view, file } = await makeJsonView({ 'big/dump.json': big }, { size: 3 * 1024 * 1024 });
  await view.onLoadFile(file);
  view.file = file;
  await settle();
  const buttons = [];
  for (const el of walkEl(view.contentEl)) if (el.tagName === 'BUTTON') buttons.push(el.textContent);
  assert.equal(buttons.includes('Edit as text'), false, 'no editor for a file this big');
  const notes = byClass(view.contentEl, 'icor-sqlv-note').map((n) => n.textContent).join(' ');
  assert.match(notes, /big file/i);
  assert.match(notes, /first part/);
});

test('the text editor saves through the vault on blur', async () => {
  const files = { 'notes/data.json': '{"a":1}' };
  const { view, file, modified } = await makeJsonView(files);
  await view.onLoadFile(file);
  view.file = file;
  await settle();
  let editBtn = null;
  for (const el of walkEl(view.contentEl)) if (el.tagName === 'BUTTON' && el.textContent === 'Edit as text') editBtn = el;
  click(editBtn);
  const area = byClass(view.contentEl, 'icor-sqlv-json-editor')[0];
  assert.ok(area, 'the editor appears');
  area.value = '{"a":2}';
  for (const fn of area.handlers.blur || []) await fn();
  assert.deepEqual(modified, ['notes/data.json']);
  assert.equal(files['notes/data.json'], '{"a":2}');
});

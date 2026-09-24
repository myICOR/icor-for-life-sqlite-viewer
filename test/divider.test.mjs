/* THE SECTION DIVIDER.
 *
 * A widget with no data: a thin horizontal line, with an optional heading,
 * that separates groups of widgets. These gates pin its rules: the spec
 * accepts it with only a title and a layout and refuses data on it; it is
 * one row tall and full width by default; a grid row holding nothing but
 * dividers is DIVIDER_ROW_PX tall instead of a full cell, while the saved
 * layout and the packing stay in whole rows; a drag counts rows by their
 * real heights; the view draws it without a query on every device and
 * keeps its slot in the phone cache; the edit screen offers it with a
 * heading field and saves it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeFakeAdapter, unwrap } from './harness.mjs';

const { lib, obsidian } = loadPlugin();

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
const byClass = (root, cls) => [...walkEl(root)].filter((e) => e.classSet && e.classSet.has(cls));
const parse = (tiles, extra) => lib.parseDashboardSpec(JSON.stringify(Object.assign({ id: 'd', title: 'D', database: '07 Data/x.db', tiles }, extra || {})));

/* --------------------------------------------------------- the spec -- */

test('the spec accepts a divider with only a title and a layout, or with nothing but its viz', () => {
  const r = parse([{ title: 'Body', viz: 'divider', layout: { x: 0, y: 1, w: 6, h: 1 } }, { viz: 'divider' }], { database: undefined });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(unwrap(r.spec.tiles[0]), { title: 'Body', viz: 'divider', layout: { x: 0, y: 1, w: 6, h: 1 } });
  assert.equal(r.spec.tiles[1].title, '', 'no heading: just the line');
  const json = JSON.parse(lib.specToJson(r.spec));
  assert.deepEqual(json.tiles[0], { title: 'Body', viz: 'divider', layout: { x: 0, y: 1, w: 6, h: 1 } }, 'saved without sql, source or axes');
  assert.deepEqual(json.tiles[1], { viz: 'divider' });
  assert.equal(lib.parseDashboardSpec(lib.specToJson(r.spec)).ok, true);
});

test('the spec refuses data, a tall divider and a heading that is not text, in plain words', () => {
  assert.match(parse([{ viz: 'divider', sql: 'SELECT 1' }]).reason, /^Tile 1: a section divider draws no data, so it takes no "sql" or "source"\./);
  assert.match(parse([{ viz: 'divider', source: { table: 't', agg: 'count' } }]).reason, /takes no "sql" or "source"/);
  assert.match(parse([{ viz: 'divider', layout: { x: 0, y: 0, w: 6, h: 2 } }]).reason, /^Tile 1: a section divider is one thin row, so its "layout" h must be 1\./);
  assert.match(parse([{ viz: 'divider', title: 7 }]).reason, /heading \("title"\) of a section divider must be text/);
  assert.match(parse([{ viz: 'pie' }]).reason, /line, bar, stat, table or divider/);
});

/* --------------------------------------------------------- the grid -- */

test('a divider is one row, full width by default, and reflows to a phone width', () => {
  assert.deepEqual(unwrap(lib.defaultSpanFor({ viz: 'divider' })), { w: 6, h: 1 });
  const tiles = [{ viz: 'stat' }, { viz: 'divider' }, { viz: 'stat' }];
  assert.deepEqual(unwrap(lib.normalizeLayout(tiles, 6)[1]), { x: 0, y: 1, w: 6, h: 1 });
  assert.deepEqual(unwrap(lib.normalizeLayout(tiles, 2)[1]), { x: 0, y: 1, w: 2, h: 1 }, 'on a phone it spans the two columns');
});

test('a row of only dividers is thin; a row with any widget, the add tile, or nothing, is a full cell', () => {
  const D = lib.DIVIDER_ROW_PX;
  assert.equal(D, 24);
  const rect = (x, y, w, h, thin) => ({ l: { x, y, w, h }, thin });
  assert.deepEqual(unwrap(lib.rowTracks([
    rect(0, 0, 1, 1, false),
    rect(0, 1, 6, 1, true),
    rect(0, 2, 3, 1, true), rect(3, 2, 3, 1, true),
    rect(0, 3, 4, 1, true), rect(4, 3, 2, 1, false),
    rect(0, 5, 2, 1, false),
  ], 170)), [170, D, D, 170, 170, 170], 'dividers only: thin, even two side by side; mixed, empty: full');
  assert.deepEqual(unwrap(lib.rowTracks([rect(0, 0, 6, 1, true), rect(0, 0, 1, 2, false)], 170)), [170, 170],
    'a tall widget reaching into the row keeps it full');
  assert.deepEqual(unwrap(lib.rowTracks([], 170)), []);
});

test('a drag counts rows by their real heights: a thin row is crossed at half of its own height', () => {
  const tracks = [170, 24, 170];
  const gap = 12;
  /* Uniform rows: the same as the old Math.round(dy / (cellH + gap)). */
  for (const dy of [-400, -100, -91, -90, 0, 90, 91, 181, 272, 500]) {
    assert.equal(lib.rowsForOffset([], gap, 3, dy, 170), Math.max(-3, Math.round(dy / 182) || 0), 'uniform ' + dy);
  }
  assert.equal(lib.rowsForOffset(tracks, gap, 1, 17, 170), 0);
  assert.equal(lib.rowsForOffset(tracks, gap, 1, 18, 170), 1, 'moving a divider down past its thin row takes 18px, not 91');
  assert.equal(lib.rowsForOffset(tracks, gap, 2, -19, 170), -1, 'and up into it the same (the exact half rounds toward zero, as before)');
  assert.equal(lib.rowsForOffset(tracks, gap, 0, 91 + 18 + 1, 170), 1, 'a full row then half of the thin one');
  assert.equal(lib.rowsForOffset(tracks, gap, 0, 182 + 18, 170), 2);
  assert.equal(lib.rowsForOffset(tracks, gap, 0, -500, 170), 0, 'never above the top');
});

/* ------------------------------------------------------- the drawing -- */

test('the divider draws a line with an optional heading, marked as a separator', () => {
  const withHeading = new obsidian.Modal({}).contentEl;
  lib.renderTile(withHeading, { viz: 'divider', title: 'Body composition' }, { columns: [], rows: [] }, {});
  const rule = byClass(withHeading, 'icor-sqlv-divider')[0];
  assert.ok(rule.classSet.has('has-heading'));
  assert.equal(rule.getAttribute('role'), 'separator');
  assert.equal(rule.getAttribute('aria-label'), 'Body composition');
  const heading = byClass(rule, 'icor-sqlv-divider-heading')[0];
  assert.equal(heading.textContent, 'Body composition');
  assert.equal(heading.getAttribute('title'), 'Body composition', 'a cut heading keeps its full text on hover');
  assert.equal(byClass(withHeading, 'icor-sqlv-tile-title').length, 0, 'no tile title row: the heading is the title');

  const bare = new obsidian.Modal({}).contentEl;
  lib.renderTile(bare, { viz: 'divider', title: '   ' }, { columns: [], rows: [] }, {});
  const line = byClass(bare, 'icor-sqlv-divider')[0];
  assert.equal(line.classSet.has('has-heading'), false);
  assert.equal(line.children.length, 0, 'no heading: just the line');
  assert.equal(line.getAttribute('aria-label'), null);
});

/* ---------------------------------------------------------- the view -- */

const VIEW = 'icor-sqlite-viewer-dashboards';
const DASH = '07 Databases/Dashboards/mixed.json';
const CACHE = '07 Databases/Dashboard Cache/dashboards/mixed.json';
const MIXED = {
  id: 'mixed', title: 'Mixed', database: '07 Databases/x.db',
  tiles: [
    { title: 'Body', viz: 'divider', layout: { x: 0, y: 0, w: 6, h: 1 } },
    { title: 'Index', viz: 'stat', sql: 'SELECT 7 AS value', layout: { x: 0, y: 1, w: 1, h: 1 } },
  ],
};

async function makeView(files, { desktop = true } = {}) {
  const fresh = loadPlugin({ desktop });
  const adapter = makeFakeAdapter(files, { '07 Databases/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  const view = plugin.viewFactories[VIEW]({ app });
  view.app = app;
  return { plugin, view, adapter };
}

test('the desktop draws a divider without a query, keeps its cache slot, and gives its row the thin height', async () => {
  const { plugin, view, adapter } = await makeView({ [DASH]: JSON.stringify(MIXED) });
  const queries = [];
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async (db, sql) => { queries.push(sql); return { columns: ['value'], rows: [[7]], ms: 1 }; };
  await view.onOpen();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(queries.filter((q) => !/sqlite_master|^PRAGMA/.test(q)), ['SELECT 7 AS value'], 'one query, for the data widget only (the rest is the catalog)');
  const divider = byClass(view.contentEl, 'is-divider')[0];
  assert.ok(divider, 'the divider tile is drawn');
  assert.equal(byClass(divider, 'icor-sqlv-error').length, 0, 'no "names no database" error');
  assert.equal(view.gridState.grid.style.gridTemplateRows, '24px 170px', 'thin row, then a full one');
  assert.match(byClass(view.contentEl, 'icor-sqlv-dash-status')[0].textContent, /^1 query in/);
  const cache = JSON.parse(adapter.files.get(CACHE));
  assert.equal(cache.tiles[0].viz, 'divider', 'the divider keeps index 0 in the cache');
  assert.deepEqual(cache.tiles[1].rows, [[7]], 'so the stat stays at index 1');
});

test('a phone draws the divider with nothing to compute and the next widget from its own cache slot', async () => {
  const cache = {
    dashboardId: 'mixed', title: 'Mixed', computedAt: new Date().toISOString(),
    tiles: [Object.assign({}, MIXED.tiles[0]), Object.assign({}, MIXED.tiles[1], { y: [], columns: ['value'], rows: [[7]], ghost: null })],
  };
  const { plugin, view } = await makeView({ [DASH]: JSON.stringify(MIXED), [CACHE]: JSON.stringify(cache) }, { desktop: false });
  plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big.' });
  await view.onOpen();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(byClass(view.contentEl, 'icor-sqlv-divider-heading').some((h) => h.textContent === 'Body'));
  assert.ok(byClass(view.contentEl, 'icor-sqlv-stat-value').some((v) => /7/.test(v.children.map((c) => c.textContent).join(''))), 'the stat renders from slot 1');
  assert.match(byClass(view.contentEl, 'icor-sqlv-dash-status')[0].textContent, /^Computed on desktop/, 'a divider does not count as a live widget');
});

/* ---------------------------------------------------------- the form -- */

async function makeForm(tiles, editIndex) {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  let queried = 0;
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => { queried++; return { columns: ['value'], rows: [[1]], ms: 1 }; };
  const spec = { id: 'd', title: 'D', database: '07 Data/x.db', globalTimeframe: { preset: '90d' }, tiles, path: 'd.json' };
  const view = { saveAndRender: async (s) => { view.saved = s; } };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, editIndex);
  return { form, spec, view, queries: () => queried };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const byLabel = (root, label) => [...walkEl(root)].find((e) => e.getAttribute && e.getAttribute('aria-label') === label);

test('the edit screen adds a divider with a heading, previews it without a query, and saves one full-width thin row', async () => {
  const { form, spec, queries } = await makeForm([{ title: 'Index', viz: 'stat', sql: 'SELECT 1', layout: { x: 0, y: 0, w: 1, h: 1 } }], -1);
  form.open();
  const start = [...walkEl(form.formEl)].find((e) => e.tagName === 'BUTTON' && e.textContent === 'Add a section divider instead');
  assert.ok(start, 'a new widget offers the divider up front');
  start.handlers.click[0]();
  assert.equal(form.state.mode, 'divider');
  assert.ok(byLabel(form.formEl, 'Width of the divider on the grid'));
  const heading = byLabel(form.formEl, 'Heading');
  heading.value = 'Body';
  heading.handlers.input[0]();
  await wait(500);
  assert.equal(form.previewState, 'ok', 'the preview needs no database');
  assert.equal(queries(), 0, 'and runs no query');
  assert.ok(byClass(form.previewEl, 'icor-sqlv-divider').length);
  await form.save();
  assert.deepEqual(JSON.parse(JSON.stringify(spec.tiles[1])), { title: 'Body', viz: 'divider', layout: { x: 0, y: 1, w: 6, h: 1 } });
  assert.equal(lib.parseDashboardSpec(lib.specToJson(spec)).ok, true);
});

test('editing a divider opens the divider form, keeps its width, and can switch to a data widget', async () => {
  const { form, spec } = await makeForm([{ title: 'Body', viz: 'divider', layout: { x: 0, y: 2, w: 3, h: 1 } }], 0);
  form.open();
  assert.equal(form.state.mode, 'divider');
  assert.equal(byLabel(form.formEl, 'Heading').value, 'Body');
  const heading = byLabel(form.formEl, 'Heading');
  heading.value = 'Sleep';
  heading.handlers.input[0]();
  await wait(500);
  await form.save();
  assert.deepEqual(JSON.parse(JSON.stringify(spec.tiles[0])), { title: 'Sleep', viz: 'divider', layout: { x: 0, y: 2, w: 3, h: 1 } }, 'width kept, row stays one');

  const again = await makeForm([{ title: 'Body', viz: 'divider', layout: { x: 0, y: 0, w: 6, h: 1 } }], 0);
  again.form.open();
  const type = byLabel(again.form.formEl, 'Widget type');
  type.value = 'data';
  type.handlers.change[0]();
  assert.equal(again.form.state.mode, 'form', 'back to the data form');
  assert.ok([...walkEl(again.form.formEl)].some((e) => e.getAttribute && /^Database/.test(e.getAttribute('aria-label') || '')), 'which starts at the database');
});

test('the chart type pickers in both modes offer the section divider', async () => {
  const { form } = await makeForm([{ title: 'Q', viz: 'stat', sql: 'SELECT 1', layout: { x: 0, y: 0, w: 1, h: 1 } }], 0);
  form.open();
  const select = [...walkEl(form.formEl)].find((e) => e.tagName === 'SELECT' && e.getAttribute('aria-label') === 'Chart type');
  assert.ok(select.children.some((o) => o.value === 'divider' && o.textContent === 'Section divider'));
  select.value = 'divider';
  select.handlers.change[0]();
  assert.equal(form.state.mode, 'divider');
  assert.equal(form.state.dataMode, 'sql', 'and remembers the SQL mode to go back to');
});

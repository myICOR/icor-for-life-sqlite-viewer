/* THE CHANGE OVER THE PERIOD, IN A CHART'S TITLE ROW.
 *
 * Opt-in per tile ("headerDelta": true): a one-series line or bar chart
 * shows how much its series moved over what it plots, at the right end of
 * its title row, with the stat chips' diagonal arrows, one decimal, a
 * typographic minus and the tile's unit. "headerDeltaAverageDays": N makes
 * each end the average of the first and last N days of the plotted dates
 * instead of one noisy point. The title ellipsizes before the change gives
 * way; hovering shows both ends. Every value here is invented.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeFakeAdapter, unwrap } from './harness.mjs';

const { lib, obsidian } = loadPlugin();

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
const byClass = (root, cls) => [...walkEl(root)].filter((e) => e.classSet && e.classSet.has(cls));
const parse = (tile) => lib.parseDashboardSpec(JSON.stringify({ id: 'd', title: 'D', database: '07 Data/x.db', tiles: [tile] }));

/* Twenty days, 100.0 falling by 0.5 a day, with a noisy first and last day. */
const ROWS = Array.from({ length: 20 }, (_, i) => {
  const day = '2026-03-' + String(i + 1).padStart(2, '0');
  let v = 100 - i * 0.5;
  if (i === 0) v += 3;
  if (i === 19) v -= 3;
  return [day, v];
});
const TABLE = { columns: ['day', 'weight'], rows: ROWS };
const LINE = { title: 'Weight', viz: 'line', x: 'day', y: ['weight'], unit: 'lb', headerDelta: true };

/* ------------------------------------------------------------ the math -- */

test('without N: the first plotted point against the last, one decimal, arrow and typographic minus', () => {
  const d = lib.headerDeltaOf(TABLE, LINE);
  /* 103.0 -> 87.5 */
  assert.equal(d.diff, -15.5);
  assert.equal(d.direction, 'down');
  assert.equal(d.text, '↘ −15.5 lb');
  assert.equal(d.hover, 'From 103.0 lb (2026-03-01) to 87.5 lb (2026-03-20)');
});

test('with N: each end is the average of the first and last N days of the plotted dates', () => {
  const d = lib.headerDeltaOf(TABLE, Object.assign({}, LINE, { headerDeltaAverageDays: 7 }));
  /* first 7 days: 100..97 (+3 on day one) -> 98.928..; last 7: 93.5..90.5 (-3 on the last) -> 91.571.. */
  assert.equal(d.first.count, 7);
  assert.equal(d.last.count, 7);
  assert.equal(d.first.from, '2026-03-01');
  assert.equal(d.first.to, '2026-03-07');
  assert.equal(d.last.from, '2026-03-14');
  assert.equal(d.last.to, '2026-03-20');
  assert.equal(d.text, '↘ −7.4 lb', 'a weekly average, not the noisy single days');
  assert.match(d.hover, /^From 98\.9 lb \(average of 7, 2026-03-01 to 2026-03-07\) to 91\.6 lb \(average of 7, 2026-03-14 to 2026-03-20\)$/);
  const gaps = lib.headerDeltaOf({ columns: ['day', 'weight'], rows: [['2026-03-01', 10], ['2026-03-09', 12], ['2026-03-30', 20]] }, Object.assign({}, LINE, { headerDeltaAverageDays: 7 }));
  assert.equal(gaps.first.count, 1, 'counted by dates, not by rows');
  assert.equal(gaps.text, '↗ +10.0 lb');
});

test('up, flat, no unit, datetime x, and nothing to compare', () => {
  const up = lib.headerDeltaOf({ columns: ['day', 'v'], rows: [['2026-01-01', 1], ['2026-01-02', 2.24]] }, { x: 'day', y: ['v'] });
  assert.equal(up.text, '↗ +1.2');
  const flat = lib.headerDeltaOf({ columns: ['day', 'v'], rows: [['2026-01-01', 5], ['2026-01-02', 5.04]] }, { x: 'day', y: ['v'], unit: 'lb' });
  assert.equal(flat.text, '→ ±0.0 lb');
  assert.equal(flat.direction, 'flat');
  const stamps = lib.headerDeltaOf({ columns: ['at', 'v'], rows: [['2026-01-01T08:00', 1], ['2026-01-01T20:00', 3], ['2026-01-09T08:00', 9]] }, { x: 'at', y: ['v'], headerDeltaAverageDays: 1 });
  assert.equal(stamps.first.count, 2, 'datetimes count by their day');
  assert.equal(stamps.text, '↗ +7.0');
  const words = lib.headerDeltaOf({ columns: ['k', 'v'], rows: [['a', 1], ['b', 4]] }, { x: 'k', y: ['v'], headerDeltaAverageDays: 7 });
  assert.equal(words.text, '↗ +3.0', 'x values that are not dates: first and last point');
  assert.equal(lib.headerDeltaOf({ columns: ['day', 'v'], rows: [['2026-01-01', 1]] }, { x: 'day', y: ['v'] }), null, 'one point: nothing to compare');
  assert.equal(lib.headerDeltaOf({ columns: ['day', 'v'], rows: [['2026-01-01', null], ['2026-01-02', 'n/a'], ['2026-01-03', 4]] }, { x: 'day', y: ['v'] }), null);
  assert.equal(lib.headerDeltaOf({ columns: ['day'], rows: [['2026-01-01']] }, { x: 'day', y: ['v'] }), null, 'a missing column: nothing');
});

/* ------------------------------------------------------- the validator -- */

test('the spec accepts it on one-series line and bar charts, SQL or built, and keeps it through the file', () => {
  const sql = parse({ title: 'W', viz: 'line', sql: 'SELECT 1 AS day, 2 AS w', x: 'day', y: 'w', headerDelta: true, headerDeltaAverageDays: 7 });
  assert.equal(sql.ok, true, sql.reason);
  assert.equal(sql.spec.tiles[0].headerDelta, true);
  assert.equal(sql.spec.tiles[0].headerDeltaAverageDays, 7);
  const json = JSON.parse(lib.specToJson(sql.spec)).tiles[0];
  assert.equal(json.headerDelta, true);
  assert.equal(json.headerDeltaAverageDays, 7);
  const built = parse({ viz: 'bar', headerDelta: true, source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day' } });
  assert.equal(built.ok, true, built.reason);
  const prepared = lib.prepareTileForRender(built.spec.tiles[0], { columns: ['x', 'value'], rows: [['2026-01-01', 1], ['2026-01-02', 3]] });
  assert.equal(prepared.spec.headerDelta, true, 'a built chart carries it to the renderer');
  const off = parse({ viz: 'stat', sql: 'SELECT 1', headerDelta: false });
  assert.equal(off.ok, true, 'false is harmless anywhere');
  assert.equal(off.spec.tiles[0].headerDelta, undefined);
  assert.equal(JSON.parse(lib.specToJson(off.spec)).tiles[0].headerDelta, undefined);
});

test('the spec refuses it elsewhere in plain words', () => {
  assert.match(parse({ viz: 'stat', sql: 'SELECT 1', headerDelta: true }).reason, /^Tile 1: "headerDelta" only works on a line or bar chart with one series\./);
  assert.match(parse({ viz: 'line', sql: 'SELECT 1', x: 'd', y: ['a', 'b'], headerDelta: true }).reason, /one series/);
  assert.match(parse({ viz: 'bar', headerDelta: true, source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', series: 'kind' } }).reason, /one series/);
  assert.match(parse({ viz: 'line', sql: 'SELECT 1', x: 'd', y: 'a', headerDelta: 'yes' }).reason, /"headerDelta" must be true or false/);
  assert.match(parse({ viz: 'line', sql: 'SELECT 1', x: 'd', y: 'a', headerDeltaAverageDays: 7 }).reason, /"headerDeltaAverageDays" needs "headerDelta": true/);
  for (const bad of [0, 2.5, 366, '7']) {
    assert.match(parse({ viz: 'line', sql: 'SELECT 1', x: 'd', y: 'a', headerDelta: true, headerDeltaAverageDays: bad }).reason,
      /"headerDeltaAverageDays" must be a whole number of days from 1 to 365/, String(bad));
  }
});

/* ------------------------------------------------------------ the tile -- */

test('the title row carries the change at its right; the title keeps its own element and hover text', () => {
  const el = new obsidian.Modal({}).contentEl;
  lib.renderTile(el, Object.assign({}, LINE, { headerDeltaAverageDays: 7 }), TABLE, {});
  const bar = el.children[0];
  assert.ok(bar.classSet.has('icor-sqlv-tile-titlebar'));
  assert.deepEqual(bar.children.map((c) => [...c.classSet][0]), ['icor-sqlv-tile-title', 'icor-sqlv-head-delta']);
  assert.equal(bar.children[0].getAttribute('title'), 'Weight');
  const chip = bar.children[1];
  assert.equal(chip.textContent, '↘ −7.4 lb');
  assert.ok(chip.classSet.has('is-down'));
  assert.match(chip.getAttribute('title'), /^From 98\.9 lb .* to 91\.6 lb /, 'hover shows both ends and their dates');
  assert.match(chip.getAttribute('aria-label'), /^Change over the period: /);
  assert.ok(el.children[1].classSet.has('icor-sqlv-tile-body'), 'the chart body follows');
});

test('no opt-in, a multi-series table, or nothing to compare: the plain title, no change', () => {
  const plain = new obsidian.Modal({}).contentEl;
  lib.renderTile(plain, Object.assign({}, LINE, { headerDelta: undefined }), TABLE, {});
  assert.ok(plain.children[0].classSet.has('icor-sqlv-tile-title'));
  assert.equal(byClass(plain, 'icor-sqlv-head-delta').length, 0);
  const one = new obsidian.Modal({}).contentEl;
  lib.renderTile(one, LINE, { columns: ['day', 'weight'], rows: [['2026-03-01', 1]] }, {});
  assert.equal(byClass(one, 'icor-sqlv-head-delta').length, 0);
  const stat = new obsidian.Modal({}).contentEl;
  lib.renderTile(stat, { viz: 'stat', headerDelta: true }, { columns: ['v'], rows: [[1]] }, {});
  assert.equal(byClass(stat, 'icor-sqlv-head-delta').length, 0, 'a stat never draws it');
});

test('a phone shows the change from the cached rows', async () => {
  const tile = { title: 'Weight', viz: 'line', sql: 'SELECT day, weight FROM t', x: 'day', y: 'weight', unit: 'lb', headerDelta: true, headerDeltaAverageDays: 7 };
  const spec = { id: 'hd', title: 'HD', database: '07 Databases/x.db', tiles: [tile] };
  const cache = { dashboardId: 'hd', title: 'HD', computedAt: new Date().toISOString(), tiles: [Object.assign({}, tile, { y: ['weight'], columns: TABLE.columns, rows: TABLE.rows, ghost: null })] };
  const fresh = loadPlugin({ desktop: false });
  const adapter = makeFakeAdapter({
    '07 Databases/Dashboards/hd.json': JSON.stringify(spec),
    '07 Databases/Dashboard Cache/dashboards/hd.json': JSON.stringify(cache),
  }, { '07 Databases/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big.' });
  const view = plugin.viewFactories['icor-sqlite-viewer-dashboards']({ app });
  view.app = app;
  await view.onOpen();
  await new Promise((r) => setTimeout(r, 20));
  const chip = byClass(view.contentEl, 'icor-sqlv-head-delta')[0];
  assert.ok(chip, 'drawn from the cache');
  assert.equal(chip.textContent, '↘ −7.4 lb');
});

/* ------------------------------------------------------------ the form -- */

async function makeForm(tile) {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.schemaFor = async () => ({ live: true, tables: [{ name: 't', columns: [{ name: 'day', type: 'TEXT' }, { name: 'v', type: 'REAL' }] }] });
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['x', 'value'], rows: [['2026-01-01', 1], ['2026-01-02', 2]], ms: 1 });
  const spec = { id: 'd', title: 'D', database: '07 Data/x.db', globalTimeframe: { preset: '90d' }, tiles: [JSON.parse(JSON.stringify(tile))], path: 'd.json' };
  const view = { saveAndRender: async () => {} };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, 0);
  return { form, spec };
}
const byLabel = (root, label) => [...walkEl(root)].find((e) => e.getAttribute && e.getAttribute('aria-label') === label);

test('the edit screen offers the checkbox and the N field, in both modes, and saves them', async () => {
  const { form, spec } = await makeForm({ title: 'W', viz: 'line', sql: 'SELECT day, v FROM t', x: 'day', y: ['v'], unit: 'lb' });
  form.open();
  const cb = byLabel(form.formEl, 'Show change over the period');
  assert.ok(cb, 'the SQL form offers it for a one-series chart');
  assert.equal(byLabel(form.formEl, 'Average the ends over N days'), undefined, 'N shows once it is on');
  cb.checked = true;
  cb.handlers.change[0]();
  const n = byLabel(form.formEl, 'Average the ends over N days');
  n.value = '7';
  n.handlers.input[0]();
  await new Promise((r) => setTimeout(r, 500));
  await form.save();
  assert.equal(spec.tiles[0].headerDelta, true);
  assert.equal(spec.tiles[0].headerDeltaAverageDays, 7);
  assert.equal(lib.parseDashboardSpec(lib.specToJson(spec)).ok, true);

  const built = await makeForm({ title: 'B', viz: 'bar', headerDelta: true, compare: 'none', favorable: 'up', source: { table: 't', metric: 'v', agg: 'sum', filters: [], timeColumn: 'day', timeframe: 'global' } });
  built.form.open();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(byLabel(built.form.formEl, 'Show change over the period').checked, true, 'the built form offers it too, already on');
  built.form.state.headerDeltaAverageDays = 'week';
  assert.match(built.form.buildTile().reason, /N must be a whole number of days/);
  built.form.state.headerDeltaAverageDays = '';
  assert.equal(built.form.buildTile().tile.headerDelta, true);
  built.form.state.viz = 'stat';
  assert.equal(built.form.buildTile().tile.headerDelta, undefined, 'a stat carries none');
});

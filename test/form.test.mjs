/* THE WIDGET FORM.
 *
 * The form's mechanics are pure and gated as such: every filter operator
 * maps to exactly one SQL shape and passes the read-only gate; the
 * comparison frames produce the twin period (previous, and same period
 * last year) for presets and custom ranges; the delta badge colors by the
 * per-widget favorable direction, never by sign; the preview gate is a
 * state machine where only a green preview unlocks Save; the debounce is
 * driven with fake timers; the one-way SQL conversion produces a raw tile
 * that parses; and a form-built tile round-trips through the spec file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap } from './harness.mjs';

const { lib } = loadPlugin();
const G90 = { preset: '90d' };

/* ------------------------------------------------------ filter operators -- */

test('every filter operator maps to its SQL shape, quoted, and passes the gate', () => {
  const cases = {
    eq: [`"kind" = 'x'`, { column: 'kind', op: 'eq', value: 'x' }],
    ne: [`"kind" <> 'x'`, { column: 'kind', op: 'ne', value: 'x' }],
    gt: [`"qty" > '5'`, { column: 'qty', op: 'gt', value: '5' }],
    gte: [`"qty" >= '5'`, { column: 'qty', op: 'gte', value: '5' }],
    lt: [`"qty" < '5'`, { column: 'qty', op: 'lt', value: '5' }],
    lte: [`"qty" <= '5'`, { column: 'qty', op: 'lte', value: '5' }],
    empty: [`("kind" IS NULL OR "kind" = '')`, { column: 'kind', op: 'empty' }],
    not_empty: [`("kind" IS NOT NULL AND "kind" <> '')`, { column: 'kind', op: 'not_empty' }],
  };
  for (const [op, [expected, row]] of Object.entries(cases)) {
    assert.equal(lib.filterConditionOf(row), expected, op);
    assert.equal(lib.gateStatement('SELECT 1 FROM t WHERE ' + lib.filterConditionOf(row)).ok, true, op);
  }
  assert.match(lib.filterConditionOf({ column: 'note', op: 'contains', value: '50%' }), /LIKE '%50\\%%' ESCAPE/);
  assert.match(lib.filterConditionOf({ column: 'note', op: 'not_contains', value: 'x' }), /^NOT \(/);
  /* A hostile value through every value-taking operator: the quote is
   * doubled, never allowed to close the literal. */
  for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']) {
    const cond = lib.filterConditionOf({ column: 'kind', op, value: "o'brien; DROP TABLE x" });
    assert.match(cond, /'o''brien; DROP TABLE x'/, op + ' must double the quote');
    assert.equal(lib.gateStatement('SELECT 1 FROM t WHERE ' + cond).ok, true, op);
  }
});

test('filter rows chain with AND, and hostile values stay quoted', () => {
  const cond = lib.filtersCondOf({
    filters: [
      { column: 'metric_name', op: 'eq', value: 'step_count' },
      { column: 'source', op: 'ne', value: "o'brien" },
    ],
  });
  assert.equal(cond, `"metric_name" = 'step_count' AND "source" <> 'o''brien'`);
});

test('the legacy single filter still parses and becomes a filter row', () => {
  const spec = {
    id: 'legacy', title: 'L', database: '07 Data/x.db',
    tiles: [{
      viz: 'bar',
      source: { table: 't', metric: 'v', agg: 'sum', filter: { column: 'kind', value: 'a' }, timeColumn: 'day' },
    }],
  };
  const r = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(unwrap(r.spec.tiles[0].source.filters), [{ column: 'kind', op: 'eq', value: 'a' }]);
});

/* --------------------------------------------------- comparison frames -- */

test('previous period for a preset: the window right before the current one, same length', () => {
  const tile = { viz: 'bar', source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: { preset: '30d' } } };
  const sql = lib.sqlForWidget(tile, G90, 'previous');
  assert.match(sql, /"day" >= date\(\(SELECT MAX\("day"\) FROM "t"\), '-60 day'\)/);
  assert.match(sql, /"day" < date\(\(SELECT MAX\("day"\) FROM "t"\), '-30 day'\)/);
  assert.equal(lib.gateStatement(sql).ok, true);
});

test('same period last year for a preset, and both shifts for a custom range', () => {
  const tile = { viz: 'stat', source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: { preset: '30d' } } };
  const year = lib.sqlForWidget(tile, G90, 'year');
  assert.match(year, /'-1 year', '-30 day'/);
  assert.match(year, /<= date\(\(SELECT MAX\("day"\) FROM "t"\), '-1 year'\)/);

  const custom = { viz: 'stat', source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: { from: '2026-06-01', to: '2026-06-30' } } };
  const prev = lib.sqlForWidget(custom, G90, 'previous');
  assert.match(prev, /julianday\('2026-06-30'\) - julianday\('2026-06-01'\) \+ 1/);
  assert.match(prev, /"day" < '2026-06-01'/);
  const sply = lib.sqlForWidget(custom, G90, 'year');
  assert.match(sply, /date\('2026-06-01', '-1 year'\)/);
  assert.match(sply, /date\('2026-06-30', '-1 year'\)/);
});

test('canCompare: needs a time column, a bounded frame, and no series split', () => {
  const base = { source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: 'global' } };
  assert.equal(lib.canCompare(base, G90), true);
  assert.equal(lib.canCompare({ source: Object.assign({}, base.source, { series: 'kind' }) }, G90), false);
  assert.equal(lib.canCompare({ source: Object.assign({}, base.source, { timeColumn: undefined }) }, G90), false);
  assert.equal(lib.canCompare({ source: Object.assign({}, base.source, { timeframe: { preset: 'all' } }) }, G90), false);
});

/* ---------------------------------------------------- the delta badge -- */

test('the badge colors by the favorable direction, never by sign', () => {
  const upGood = lib.deltaBadge(110, 100, 'up');
  assert.equal(upGood.direction, 'up');
  assert.equal(upGood.good, true);
  assert.equal(upGood.label, '+10%');
  const upBad = lib.deltaBadge(110, 100, 'down');
  assert.equal(upBad.good, false, 'weight going up is not a win');
  const downGood = lib.deltaBadge(90, 100, 'down');
  assert.equal(downGood.direction, 'down');
  assert.equal(downGood.good, true, 'resting heart rate going down is a win');
  const downBad = lib.deltaBadge(90, 100, 'up');
  assert.equal(downBad.good, false);
  const flat = lib.deltaBadge(100, 100, 'up');
  assert.equal(flat.direction, 'flat');
  assert.equal(flat.good, null);
  assert.equal(lib.deltaBadge(5, null, 'up'), null, 'no previous value, no badge');
});

/* ------------------------------------------------------ the preview gate -- */

test('the preview gate: only a green preview unlocks Save, and any change locks it again', () => {
  let s = 'stale';
  assert.equal(lib.canSave(s), false);
  s = lib.nextPreviewState(s, 'run');
  assert.equal(lib.canSave(s), false, 'running is not green');
  s = lib.nextPreviewState(s, 'ok');
  assert.equal(lib.canSave(s), true);
  s = lib.nextPreviewState(s, 'change');
  assert.equal(lib.canSave(s), false, 'a change makes the preview stale again');
  s = lib.nextPreviewState(s, 'run');
  s = lib.nextPreviewState(s, 'error');
  assert.equal(lib.canSave(s), false);
  assert.equal(lib.nextPreviewState('stale', 'ok'), 'stale', 'a stray ok without a run changes nothing');
});

test('the debounce runs once per burst of changes, driven with fake timers', () => {
  const scheduled = [];
  let nextId = 1;
  const schedule = (fn) => { const id = nextId++; scheduled.push({ id, fn }); return id; };
  const cancel = (id) => { const i = scheduled.findIndex((s) => s.id === id); if (i >= 0) scheduled.splice(i, 1); };
  const d = lib.makeDebounce(400, schedule, cancel);
  let runs = 0;
  d.bump(() => runs++);
  d.bump(() => runs++);
  d.bump(() => runs++);
  assert.equal(scheduled.length, 1, 'earlier timers are canceled');
  scheduled[0].fn();
  assert.equal(runs, 1, 'one burst, one run');
  d.stop();
  d.bump(() => runs++);
  d.stop();
  assert.equal(scheduled.filter((s) => s.id >= 4).length, 0, 'stop cancels the pending run');
});

/* --------------------------------------------- spec round-trip and parse -- */

test('a form-built widget (filters, compare, favorable, size) round-trips through the spec file', () => {
  const spec = {
    id: 'formed', title: 'Formed', database: '07 Data/mypka-health.db',
    globalTimeframe: { preset: '90d' },
    tiles: [{
      title: 'Weight trend', viz: 'line', unit: 'kg',
      compare: 'previous', favorable: 'down',
      layout: { x: 0, y: 0, w: 2, h: 2 },
      source: {
        table: 'health_metric', metric: 'qty', agg: 'avg',
        filters: [
          { column: 'metric_name', op: 'eq', value: 'weight_body_mass' },
          { column: 'source', op: 'not_empty' },
        ],
        timeColumn: 'local_date', timeframe: 'global',
      },
    }],
  };
  const first = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.spec.tiles[0].compare, 'previous');
  assert.equal(first.spec.tiles[0].favorable, 'down');
  const second = lib.parseDashboardSpec(lib.specToJson(first.spec));
  assert.equal(second.ok, true, second.reason);
  assert.deepEqual(unwrap(second.spec), unwrap(first.spec));
});

test('compare with a series split is refused; bad compare and favorable values are named', () => {
  const base = {
    id: 'x', title: 'X', database: 'a.db',
    tiles: [{
      viz: 'bar', compare: 'previous',
      source: { table: 't', metric: 'v', agg: 'sum', series: 'kind', timeColumn: 'day' },
    }],
  };
  assert.match(lib.parseDashboardSpec(JSON.stringify(base)).reason, /cannot also compare/);
  const badCompare = JSON.parse(JSON.stringify(base));
  delete badCompare.tiles[0].source.series;
  badCompare.tiles[0].compare = 'sometimes';
  assert.match(lib.parseDashboardSpec(JSON.stringify(badCompare)).reason, /"compare"/);
  const badFav = JSON.parse(JSON.stringify(base));
  delete badFav.tiles[0].source.series;
  badFav.tiles[0].compare = 'none';
  badFav.tiles[0].favorable = 'sideways';
  assert.match(lib.parseDashboardSpec(JSON.stringify(badFav)).reason, /"favorable"/);
});

test('the one-way conversion: a built widget converted to SQL parses as a raw tile and keeps its query', () => {
  const spec = {
    id: 'conv', title: 'C', database: '07 Data/x.db', globalTimeframe: { preset: '90d' },
    tiles: [{
      title: 'Steps', viz: 'bar', unit: 'steps',
      source: { table: 'health_metric', metric: 'qty', agg: 'sum', filters: [{ column: 'metric_name', op: 'eq', value: 'step_count' }], timeColumn: 'local_date', timeframe: 'global' },
    }],
  };
  const parsed = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(parsed.ok, true, parsed.reason);
  const tile = parsed.spec.tiles[0];
  const sql = lib.tileSql(tile, parsed.spec);
  /* What the Edit-as-SQL door produces: */
  const raw = { title: tile.title, sql, viz: tile.viz, x: 'x', y: 'value', unit: tile.unit };
  parsed.spec.tiles[0] = raw;
  const reparsed = lib.parseDashboardSpec(lib.specToJson({
    id: 'conv', title: 'C', database: '07 Data/x.db', globalTimeframe: { preset: '90d' },
    tiles: [Object.assign({ stack: false, y: ['value'] }, raw, { y: ['value'] })],
  }));
  assert.equal(reparsed.ok, true, reparsed.reason);
  assert.equal(reparsed.spec.tiles[0].sql, sql, 'the query survives verbatim');
  assert.equal(reparsed.spec.tiles[0].source, undefined, 'the form is gone: it is a raw SQL tile now');
  assert.equal(lib.tileSql(reparsed.spec.tiles[0], reparsed.spec), sql, 'and it keeps running the same SQL');
});

/* ---------------------------------------------- the form, DOM-driven -- */

import { makeFakeAdapter } from './harness.mjs';

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function byClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }

test('the form gates Save on a green preview and saves a widget that round-trips', async () => {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [{ path: '07 Data/x.db', stat: { size: 1 } }] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.schemaFor = async () => ({ live: true, tables: [{ name: 'things', columns: [{ name: 'day', type: 'TEXT' }, { name: 'qty', type: 'REAL' }, { name: 'kind', type: 'TEXT' }] }] });
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['x', 'value'], rows: [['d1', 3]], ms: 1 });

  const spec = { id: 'd', title: 'D', database: '', globalTimeframe: { preset: '90d' }, tiles: [], path: '07 Data/Dashboards/d.json' };
  const view = { saveAndRender: async (s) => { view.saved = s; }, };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, -1);
  form.open();
  assert.equal(form.saveBtn.disabled, true, 'Save starts locked');

  /* Fill the sentence: database, table, value. */
  form.state.database = '07 Data/x.db';
  form.state.table = 'things';
  form.state.metric = 'qty';
  form.state.timeColumn = 'day';
  form.renderForm();
  form.touch();
  await new Promise((r) => setTimeout(r, 500)); /* past the 400ms debounce */
  assert.equal(form.previewState, 'ok', 'the preview ran green');
  assert.equal(form.saveBtn.disabled, false, 'a green preview unlocks Save');
  assert.ok(byClass(form.previewEl, 'icor-sqlv-tile').length, 'the preview shows the widget');

  /* A change locks it again. */
  form.state.unit = 'kg';
  form.touch();
  assert.equal(form.saveBtn.disabled, true, 'a change makes the preview stale');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(form.saveBtn.disabled, false);

  await form.save();
  assert.ok(view.saved, 'the spec was saved');
  assert.equal(spec.tiles.length, 1);
  assert.equal(spec.tiles[0].source.table, 'things');
  assert.deepEqual(unwrap(spec.tiles[0].layout), { x: 0, y: 0, w: 2, h: 2 }, 'the medium size preset landed');
  const reparsed = lib.parseDashboardSpec(lib.specToJson(spec));
  assert.equal(reparsed.ok, true, reparsed.reason);
});

test('a failed preview locks Save and shows its error in the form', async () => {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.schemaFor = async () => ({ live: true, tables: [{ name: 'things', columns: [{ name: 'day', type: 'TEXT' }, { name: 'qty', type: 'REAL' }] }] });
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => { throw new Error('no such table: things'); };
  const spec = { id: 'd', title: 'D', database: '', globalTimeframe: { preset: '90d' }, tiles: [], path: 'p.json' };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, { saveAndRender: async () => {} }, spec, -1);
  form.open();
  form.state.database = '07 Data/x.db';
  form.state.table = 'things';
  form.state.metric = 'qty';
  form.state.timeColumn = 'day';
  form.touch();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(form.previewState, 'error');
  assert.equal(form.saveBtn.disabled, true, 'a red preview never saves');
  assert.match(byClass(form.previewEl, 'icor-sqlv-error').map((e) => e.textContent).join(' '), /no such table/);
  await form.save();
  assert.equal(spec.tiles.length, 0, 'save is a no-op while locked');
});

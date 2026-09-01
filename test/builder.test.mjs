/* THE BUILDER.
 *
 * A built widget never hand-assembles SQL at render time: sqlForWidget is
 * a pure function from descriptor to string, so this gate pins the exact
 * string for every permutation that matters (tall tables with a filter,
 * wide tables, count, latest, series, group-by override, every timeframe
 * shape, hostile identifiers), and every generated string must pass the
 * same read-only statement gate as hand-written SQL. Timeframe resolution
 * including "global" inheritance, the series pivot, the render
 * preparation, the extended parser, the spec round-trip, the catalog and
 * the existence-gated starters are measured here too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib } = loadPlugin();

const G90 = { preset: '90d' };

/* ------------------------------------------------------- SQL generation -- */

test('tall table: filter + sum per day, global timeframe, anchored on the newest matching row', () => {
  const tile = {
    viz: 'bar',
    source: {
      table: 'health_metric', metric: 'qty', agg: 'sum',
      filters: [{ column: 'metric_name', op: 'eq', value: 'step_count' }],
      timeColumn: 'local_date', timeframe: 'global',
    },
  };
  const sql = lib.sqlForWidget(tile, G90);
  assert.equal(sql,
    'SELECT "local_date" AS x, SUM("qty") AS value FROM "health_metric"' +
    ' WHERE "metric_name" = \'step_count\'' +
    ' AND "local_date" >= date((SELECT MAX("local_date") FROM "health_metric" WHERE "metric_name" = \'step_count\'), \'-90 day\')' +
    ' GROUP BY "local_date" ORDER BY "local_date"');
  assert.equal(lib.gateStatement(sql).ok, true);
});

test('wide table: plain average per day with a fixed preset, no filter in the anchor', () => {
  const tile = {
    viz: 'line',
    source: { table: 'health_sleep', metric: 'total_sleep_hr', agg: 'avg', timeColumn: 'local_date', timeframe: { preset: '30d' } },
  };
  const sql = lib.sqlForWidget(tile, G90);
  assert.equal(sql,
    'SELECT "local_date" AS x, AVG("total_sleep_hr") AS value FROM "health_sleep"' +
    ' WHERE "local_date" >= date((SELECT MAX("local_date") FROM "health_sleep"), \'-30 day\')' +
    ' GROUP BY "local_date" ORDER BY "local_date"');
});

test('months preset, custom range, and all time', () => {
  const base = { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day' };
  const months = lib.sqlForWidget({ viz: 'bar', source: Object.assign({}, base, { timeframe: { preset: '12m' } }) }, G90);
  assert.match(months, /'-12 month'/);
  const custom = lib.sqlForWidget({ viz: 'bar', source: Object.assign({}, base, { timeframe: { from: '2026-01-01', to: '2026-06-30' } }) }, G90);
  assert.match(custom, /"day" >= '2026-01-01' AND "day" <= '2026-06-30'/);
  const all = lib.sqlForWidget({ viz: 'bar', source: Object.assign({}, base, { timeframe: { preset: 'all' } }) }, G90);
  assert.equal(all, 'SELECT "day" AS x, SUM("v") AS value FROM "t" GROUP BY "day" ORDER BY "day"');
});

test('global inheritance: the widget follows the dashboard, and a fixed widget does not', () => {
  const follow = { viz: 'bar', source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: 'global' } };
  assert.match(lib.sqlForWidget(follow, { preset: '7d' }), /'-7 day'/);
  assert.match(lib.sqlForWidget(follow, { from: '2026-01-01', to: '2026-02-01' }), /'2026-01-01'/);
  const fixed = { viz: 'bar', source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: { preset: '30d' } } };
  assert.match(lib.sqlForWidget(fixed, { preset: '7d' }), /'-30 day'/, 'a fixed widget keeps its own range');
});

test('count needs no metric; series adds a column and the group by; groupBy overrides the time column', () => {
  const count = lib.sqlForWidget({ viz: 'bar', source: { table: 'engagement_posts', agg: 'count', timeColumn: 'batch_id', timeframe: { preset: 'all' } } }, G90);
  assert.equal(count, 'SELECT "batch_id" AS x, COUNT(*) AS value FROM "engagement_posts" GROUP BY "batch_id" ORDER BY "batch_id"');
  const series = lib.sqlForWidget({ viz: 'bar', source: { table: 'engagement_posts', agg: 'count', series: 'status', timeColumn: 'batch_id', timeframe: { preset: 'all' } } }, G90);
  assert.equal(series, 'SELECT "batch_id" AS x, "status" AS series, COUNT(*) AS value FROM "engagement_posts" GROUP BY "batch_id", "status" ORDER BY "batch_id"');
  const grouped = lib.sqlForWidget({ viz: 'bar', source: { table: 'health_workout', metric: 'duration_sec', agg: 'sum', groupBy: 'workout_type', timeColumn: 'local_date', timeframe: { preset: '90d' } } }, G90);
  assert.match(grouped, /^SELECT "workout_type" AS x, SUM\("duration_sec"\) AS value/);
  assert.match(grouped, /GROUP BY "workout_type" ORDER BY "workout_type"$/);
  assert.match(grouped, /"local_date" >= date/, 'the time window still applies');
});

test('stat widgets: aggregate to one value; latest reads the newest row', () => {
  const sum = lib.sqlForWidget({ viz: 'stat', source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day', timeframe: { preset: '7d' } } }, G90);
  assert.equal(sum, 'SELECT SUM("v") AS value FROM "t" WHERE "day" >= date((SELECT MAX("day") FROM "t"), \'-7 day\')');
  const latest = lib.sqlForWidget({ viz: 'stat', source: { table: 'health_metric', metric: 'qty', agg: 'latest', filters: [{ column: 'metric_name', op: 'eq', value: 'weight_body_mass' }], timeColumn: 'local_date', timeframe: { preset: 'all' } } }, G90);
  assert.equal(latest, 'SELECT "qty" AS value, "local_date" AS at FROM "health_metric" WHERE "metric_name" = \'weight_body_mass\' ORDER BY "local_date" DESC LIMIT 1');
});

test('hostile names and values cannot break out of their quoting, and the gate still passes', () => {
  const sql = lib.sqlForWidget({
    viz: 'bar',
    source: {
      table: 'we"ird', metric: 'va"l', agg: 'sum',
      filters: [{ column: 'ki"nd', op: 'eq', value: "o'brien; DROP TABLE x" }],
      timeColumn: 'da"y', timeframe: { preset: '7d' },
    },
  }, G90);
  assert.match(sql, /"we""ird"/);
  assert.match(sql, /'o''brien; DROP TABLE x'/);
  assert.equal(lib.gateStatement(sql).ok, true);
});

test('every generated SQL passes the read-only gate: a permutation sweep', () => {
  const frames = ['global', { preset: '7d' }, { preset: '12m' }, { preset: 'all' }, { from: '2026-01-01', to: '2026-02-01' }];
  const aggs = ['sum', 'avg', 'min', 'max', 'count'];
  let n = 0;
  for (const viz of ['line', 'bar', 'stat']) {
    for (const agg of aggs) {
      for (const timeframe of frames) {
        for (const filters of [undefined, [{ column: 'kind', op: 'eq', value: 'x' }]]) {
          for (const series of viz === 'stat' ? [undefined] : [undefined, 'cat']) {
            const tile = { viz, source: { table: 't', metric: agg === 'count' ? '' : 'v', agg, filters, series, timeColumn: 'day', timeframe } };
            const sql = lib.sqlForWidget(tile, G90);
            assert.equal(lib.gateStatement(sql).ok, true, 'gate must pass: ' + sql);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n >= 200, 'the sweep must actually sweep, ran ' + n);
});

/* -------------------------------------------------- timeframe validity -- */

test('timeframe validity: presets, ranges, global only where allowed', () => {
  assert.equal(lib.validTimeframe({ preset: '90d' }, false), true);
  assert.equal(lib.validTimeframe({ preset: 'yesterday' }, false), false);
  assert.equal(lib.validTimeframe({ from: '2026-01-01', to: '2026-02-01' }, false), true);
  assert.equal(lib.validTimeframe({ from: 'not-a-date', to: '2026-02-01' }, false), false);
  assert.equal(lib.validTimeframe('global', true), true);
  assert.equal(lib.validTimeframe('global', false), false, 'the dashboard itself cannot follow itself');
  assert.equal(lib.validTimeframe(undefined, false), true);
});

test('resolveTimeframe: global and missing fall back to the dashboard, which falls back to 90 days', () => {
  assert.deepEqual(unwrap(lib.resolveTimeframe('global', { preset: '7d' })), { preset: '7d' });
  assert.deepEqual(unwrap(lib.resolveTimeframe(undefined, { preset: '7d' })), { preset: '7d' });
  assert.deepEqual(unwrap(lib.resolveTimeframe({ preset: '30d' }, { preset: '7d' })), { preset: '30d' });
  assert.deepEqual(unwrap(lib.resolveTimeframe('global', undefined)), { preset: '90d' });
});

/* ------------------------------------------------------- pivot and prep -- */

test('pivotSeries: long rows become one column per series, biggest total first, holes stay null', () => {
  const wide = lib.pivotSeries({
    columns: ['x', 'series', 'value'],
    rows: [
      ['d1', 'a', 1], ['d1', 'b', 10],
      ['d2', 'b', 20], ['d3', 'a', 2],
    ],
  });
  assert.deepEqual(unwrap(wide), {
    columns: ['x', 'b', 'a'],
    rows: [['d1', 10, 1], ['d2', 20, null], ['d3', null, 2]],
  });
});

test('prepareTileForRender: raw tiles pass through, built widgets get generated axes, series pivot to wide', () => {
  const raw = { title: 'R', sql: 'SELECT 1', viz: 'line', x: 'a', y: ['b'] };
  const t1 = lib.prepareTileForRender(raw, { columns: ['a', 'b'], rows: [[1, 2]] });
  assert.equal(t1.spec, raw);
  const built = { title: 'B', viz: 'bar', unit: 'x', stack: false, source: { table: 't', metric: 'v', agg: 'sum', timeColumn: 'day' } };
  const t2 = lib.prepareTileForRender(built, { columns: ['x', 'value'], rows: [['d1', 5]] });
  assert.deepEqual(unwrap(t2.spec.y), ['value']);
  assert.equal(t2.spec.x, 'x');
  const withSeries = { title: 'S', viz: 'bar', stack: true, unit: '', source: { table: 't', metric: 'v', agg: 'sum', series: 'cat', timeColumn: 'day' } };
  const t3 = lib.prepareTileForRender(withSeries, { columns: ['x', 'series', 'value'], rows: [['d1', 'a', 1], ['d1', 'b', 2]] });
  assert.deepEqual(unwrap(t3.spec.y), ['b', 'a']);
  assert.equal(t3.spec.stack, true);
  assert.deepEqual(unwrap(t3.table.rows), [['d1', 2, 1]]);
});

/* ------------------------------------------------------ parser and file -- */

test('a 0.1.x spec still parses, with the global timeframe defaulted', () => {
  const old = {
    id: 'health-overview', title: 'Health', database: '07 Data/mypka-health.db',
    tiles: [{ title: 'T', sql: 'SELECT 1 AS one', viz: 'stat', y: 'one' }],
  };
  const r = lib.parseDashboardSpec(JSON.stringify(old));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(unwrap(r.spec.globalTimeframe), { preset: '90d' });
});

test('built widgets parse; broken ones are refused with the tile named', () => {
  const spec = {
    id: 'built', title: 'Built', globalTimeframe: { preset: '30d' },
    tiles: [{
      title: 'Steps', viz: 'bar', unit: 'steps',
      source: { database: '07 Data/mypka-health.db', table: 'health_metric', metric: 'qty', agg: 'sum', filter: { column: 'metric_name', value: 'step_count' }, timeColumn: 'local_date' },
    }],
  };
  const r = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.spec.tiles[0].source.timeframe, 'global', 'a widget without a timeframe follows the dashboard');

  const noTable = JSON.parse(JSON.stringify(spec));
  delete noTable.tiles[0].source.table;
  assert.match(lib.parseDashboardSpec(JSON.stringify(noTable)).reason, /Tile 1.*"table"/);
  const badAgg = JSON.parse(JSON.stringify(spec));
  badAgg.tiles[0].source.agg = 'median';
  assert.match(lib.parseDashboardSpec(JSON.stringify(badAgg)).reason, /agg/);
  const statSeries = JSON.parse(JSON.stringify(spec));
  statSeries.tiles[0].viz = 'stat';
  statSeries.tiles[0].source.series = 'source';
  assert.match(lib.parseDashboardSpec(JSON.stringify(statSeries)).reason, /series/);
  const noDb = JSON.parse(JSON.stringify(spec));
  delete noDb.tiles[0].source.database;
  assert.match(lib.parseDashboardSpec(JSON.stringify(noDb)).reason, /database/);
});

test('an empty dashboard parses (the builder starts from it); SQL tiles still need a top-level database', () => {
  const empty = { id: 'fresh', title: 'Fresh', tiles: [] };
  assert.equal(lib.parseDashboardSpec(JSON.stringify(empty)).ok, true);
  const sqlNoDb = { id: 'x', title: 'X', tiles: [{ sql: 'SELECT 1', viz: 'stat' }] };
  assert.match(lib.parseDashboardSpec(JSON.stringify(sqlNoDb)).reason, /top-level "database"/);
});

test('specToJson round-trips through the parser without loss', () => {
  const spec = {
    id: 'round', title: 'Round trip', database: '07 Data/engagement.db',
    globalTimeframe: { from: '2026-01-01', to: '2026-03-01' },
    tiles: [
      { title: 'Raw', sql: 'SELECT batch_id, COUNT(*) AS n FROM engagement_posts GROUP BY batch_id', viz: 'bar', x: 'batch_id', y: ['n'], unit: '', stack: false },
      { title: 'Built', viz: 'line', unit: 'kg', stack: false, source: { database: '07 Data/mypka-health.db', table: 'health_metric', metric: 'qty', agg: 'avg', filter: { column: 'metric_name', value: 'weight_body_mass' }, timeColumn: 'local_date', timeframe: 'global' } },
    ],
  };
  const first = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(first.ok, true, first.reason);
  const second = lib.parseDashboardSpec(lib.specToJson(first.spec));
  assert.equal(second.ok, true, second.reason);
  assert.deepEqual(unwrap(second.spec), unwrap(first.spec));
});

test('tileDatabase and tileSql: widget database beats dashboard database; raw SQL passes through', () => {
  const spec = { database: 'a.db', globalTimeframe: G90, tiles: [] };
  assert.equal(lib.tileDatabase({ sql: 'SELECT 1' }, spec), 'a.db');
  assert.equal(lib.tileDatabase({ source: { database: 'b.db', table: 't' } }, spec), 'b.db');
  assert.equal(lib.tileSql({ sql: 'SELECT 1' }, spec), 'SELECT 1');
  assert.match(lib.tileSql({ viz: 'stat', source: { table: 't', metric: 'v', agg: 'sum' } }, spec), /^SELECT SUM\("v"\) AS value FROM "t"$/);
});

/* --------------------------------------------------------- the catalog -- */

async function makeCatalogPlugin(adapter, { desktop = true } = {}) {
  const fresh = loadPlugin({ desktop });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  return plugin;
}

test('the desktop writes a catalog: tables, columns, and the values of small text columns', async () => {
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const plugin = await makeCatalogPlugin(adapter);
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async (db, sql) => {
    if (/sqlite_master/.test(sql)) return { columns: ['name'], rows: [['health_metric']], ms: 1, engine: 'cli' };
    if (/table_info/.test(sql)) {
      return { columns: ['cid', 'name', 'type'], rows: [[0, 'metric_name', 'TEXT'], [1, 'qty', 'REAL'], [2, 'local_date', 'TEXT']], ms: 1, engine: 'cli' };
    }
    if (/DISTINCT "metric_name"/.test(sql)) return { columns: ['metric_name'], rows: [['step_count'], ['heart_rate']], ms: 1, engine: 'cli' };
    if (/DISTINCT "local_date"/.test(sql)) return { columns: ['local_date'], rows: Array.from({ length: 201 }, (_, i) => ['d' + i]), ms: 1, engine: 'cli' };
    throw new Error('unexpected: ' + sql);
  };
  await plugin.writeCatalog('07 Data/x.db');
  const path = '07 Data/Dashboard Cache/catalogs/x.json';
  assert.equal(adapter.files.has(path), true);
  const catalog = JSON.parse(adapter.files.get(path));
  assert.equal(catalog.tables[0].name, 'health_metric');
  assert.deepEqual(catalog.values['health_metric.metric_name'], ['heart_rate', 'step_count']);
  assert.equal(catalog.values['health_metric.local_date'], undefined, 'a column with over 200 values stays out');
});

test('the mobile picker reads the catalog when the database cannot be opened', async () => {
  const catalog = {
    database: '07 Data/big.db', computedAt: '2026-09-01T10:00:00Z',
    tables: [{ name: 'health_metric', columns: [{ name: 'metric_name', type: 'TEXT' }, { name: 'qty', type: 'REAL' }] }],
    values: { 'health_metric.metric_name': ['step_count'] },
  };
  const adapter = makeFakeAdapter(
    { '07 Data/Dashboard Cache/catalogs/big.json': JSON.stringify(catalog) },
    { '07 Data/big.db': new Uint8Array(3 * 1024 * 1024) }
  );
  const plugin = await makeCatalogPlugin(adapter, { desktop: false });
  plugin.settings.mobileCapMb = 1;
  const schema = await plugin.schemaFor('07 Data/big.db');
  assert.equal(schema.live, false);
  assert.equal(schema.tables[0].name, 'health_metric');
  const values = await plugin.distinctValues('07 Data/big.db', 'health_metric', 'metric_name');
  assert.deepEqual(unwrap(values.values), ['step_count']);
  await assert.rejects(plugin.distinctValues('07 Data/big.db', 'health_metric', 'source'), /not in the catalog yet/);
});

test('without engine and without catalog, the picker says what to do in plain words', async () => {
  const adapter = makeFakeAdapter({}, { '07 Data/big.db': new Uint8Array(3 * 1024 * 1024) });
  const plugin = await makeCatalogPlugin(adapter, { desktop: false });
  plugin.settings.mobileCapMb = 1;
  await assert.rejects(plugin.schemaFor('07 Data/big.db'), /Open the database once on the desktop and sync/);
});

/* ------------------------------------------------- existence-gated seeds -- */

test('starters are seeded only for databases that exist in the vault', async () => {
  const adapter = makeFakeAdapter({}, { '07 Data/engagement.db': new Uint8Array([1]) });
  const plugin = await makeCatalogPlugin(adapter);
  await plugin.ensureStarterFiles();
  assert.equal(adapter.files.has('07 Data/Dashboards/engagement-overview.json'), true, 'its database exists, so it seeds');
  assert.equal(adapter.files.has('07 Data/Dashboards/health-overview.json'), false, 'no health database, no health dashboard');
  assert.equal(adapter.files.has('07 Data/Dashboards/youtube-overview.json'), false);
  assert.equal(adapter.files.has('07 Data/Dashboards/README.md'), true, 'the README always seeds');
});

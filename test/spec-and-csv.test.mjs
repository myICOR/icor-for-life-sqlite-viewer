/* DASHBOARD SPECS, CSV, THE DATABASE INDEX AND THE CHART MATH.
 *
 * A dashboard file is member-editable JSON, so the parser is measured on
 * what it accepts, what it refuses, and above all on the rule that a tile's
 * SQL passes the statement gate at parse time: a write hidden in a
 * dashboard file must die in the parser, before any engine exists. The
 * three starter dashboards ship inside main.js, so they are parsed here by
 * the same parser that will read them from disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap } from './harness.mjs';

const { lib } = loadPlugin();

const goodSpec = () => ({
  id: 'my-dash',
  title: 'My Dash',
  database: '07 Data/example.db',
  tiles: [
    { title: 'Trend', sql: 'SELECT day, n FROM t ORDER BY day', viz: 'line', x: 'day', y: 'n', unit: 'rows' },
    { title: 'Total', sql: 'SELECT COUNT(*) AS n FROM t', viz: 'stat', y: 'n' },
    { title: 'Raw', sql: 'SELECT * FROM t LIMIT 5', viz: 'table' },
  ],
});

test('a well-formed spec parses, y normalises to a list, extras are dropped', () => {
  const r = lib.parseDashboardSpec(JSON.stringify(goodSpec()));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.spec.id, 'my-dash');
  assert.deepEqual(unwrap(r.spec.tiles[0].y), ['n']);
  assert.equal(r.spec.tiles[0].stack, false);
  assert.deepEqual(unwrap(r.spec.tiles[2].y), []);
});

test('a tile with a write query is refused at parse time, naming the tile', () => {
  const spec = goodSpec();
  spec.tiles[1].sql = 'DROP TABLE t';
  const r = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Tile 2/);
  assert.match(r.reason, /SELECT, WITH, PRAGMA or EXPLAIN/);
});

test('broken JSON, a bad id, a missing database and an empty tile list are refused in plain words', () => {
  assert.match(lib.parseDashboardSpec('{ nope').reason, /not valid JSON/);
  const badId = goodSpec(); badId.id = 'has spaces';
  assert.match(lib.parseDashboardSpec(JSON.stringify(badId)).reason, /"id"/);
  const noDb = goodSpec(); delete noDb.database;
  assert.match(lib.parseDashboardSpec(JSON.stringify(noDb)).reason, /"database"/);
  const noTiles = goodSpec(); noTiles.tiles = 'nope';
  assert.match(lib.parseDashboardSpec(JSON.stringify(noTiles)).reason, /"tiles"/);
});

test('a line or bar tile without x or y is refused; a stat without either is fine', () => {
  const noX = goodSpec(); delete noX.tiles[0].x;
  assert.match(lib.parseDashboardSpec(JSON.stringify(noX)).reason, /"x"/);
  const noY = goodSpec(); delete noY.tiles[0].y;
  assert.match(lib.parseDashboardSpec(JSON.stringify(noY)).reason, /"y"/);
  const bareStat = goodSpec();
  bareStat.tiles = [{ sql: 'SELECT 1 AS one', viz: 'stat' }];
  assert.equal(lib.parseDashboardSpec(JSON.stringify(bareStat)).ok, true);
});

test('an unknown viz is refused', () => {
  const bad = goodSpec(); bad.tiles[0].viz = 'pie';
  assert.match(lib.parseDashboardSpec(JSON.stringify(bad)).reason, /line, bar, stat or table/);
});

test('the three starter dashboards pass their own parser', () => {
  for (const starter of lib.STARTER_DASHBOARDS) {
    const r = lib.parseDashboardSpec(JSON.stringify(starter.spec));
    assert.equal(r.ok, true, starter.file + ': ' + (r.reason || ''));
    for (const tile of r.spec.tiles) {
      assert.equal(lib.gateStatement(tile.sql).ok, true, starter.file + ' tile SQL must pass the gate');
    }
  }
});

test('cache paths: cache folder, database stem, dashboard id', () => {
  assert.equal(
    lib.cachePathFor('07 Data/Dashboard Cache', '07 Data/mypka-health.db', 'health-overview'),
    '07 Data/Dashboard Cache/mypka-health/health-overview.json'
  );
});

/* ------------------------------------------------------------------ CSV -- */

test('CSV: plain cells stay plain, commas and quotes and newlines are quoted, null is empty', () => {
  const csv = lib.toCsv(['a', 'b'], [
    ['plain', 12],
    ['with, comma', 'say "hi"'],
    ['line\nbreak', null],
  ]);
  assert.equal(csv, 'a,b\r\nplain,12\r\n"with, comma","say ""hi"""\r\n"line\nbreak",\r\n');
});

test('CSV of zero rows is just the header', () => {
  assert.equal(lib.toCsv(['x'], []), 'x\r\n');
});

/* ------------------------------------------------------ the database index -- */

test('the index finds databases, skips sidecars and the folders nobody means', () => {
  const found = lib.findDatabases([
    { path: '07 Data/mypka-health.db', size: 1 },
    { path: '07 Data/engagement.db', size: 2 },
    { path: '07 Data/engagement.db-wal', size: 3 },
    { path: '07 Data/engagement.db-shm', size: 4 },
    { path: '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db', size: 5 },
    { path: '.obsidian/plugins/x/cache.db', size: 6 },
    { path: '.git/index.db', size: 7 },
    { path: '.trash/old.sqlite', size: 8 },
    { path: 'notes/note.md', size: 9 },
    { path: 'a/data.sqlite3', size: 10 },
  ]);
  assert.deepEqual(unwrap(found.map((f) => f.path)), [
    '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db',
    '07 Data/engagement.db',
    '07 Data/mypka-health.db',
    'a/data.sqlite3',
  ]);
});

test('result shaping: sqlite3 -json text and sql.js results become one table shape', () => {
  const cli = lib.cliTable('[{"a":1,"b":"x"},{"a":2,"b":null}]\n');
  assert.deepEqual(unwrap(cli), { columns: ['a', 'b'], rows: [[1, 'x'], [2, null]] });
  assert.deepEqual(unwrap(lib.cliTable('')), { columns: [], rows: [] }, 'zero rows print nothing at all');
  const wasm = lib.wasmTable([{ columns: ['a'], values: [[1], [2]] }]);
  assert.deepEqual(unwrap(wasm), { columns: ['a'], rows: [[1], [2]] });
  assert.deepEqual(unwrap(lib.wasmTable([])), { columns: [], rows: [] });
});

/* ------------------------------------------------------------ chart math -- */

test('niceScale lands on round steps and covers the data', () => {
  const s = lib.niceScale(3, 97, 5);
  assert.equal(s.min <= 3, true);
  assert.equal(s.max >= 97, true);
  assert.equal(s.ticks[0], s.min);
  assert.equal(s.ticks[s.ticks.length - 1], s.max);
  const flat = lib.niceScale(5, 5, 5);
  assert.equal(flat.max > flat.min, true, 'a flat series still gets a drawable axis');
});

test('stacked segments accumulate in series order and clamp negatives to zero', () => {
  const segs = lib.stackRows([[/* x */ 'd1', 2, 3, -1]], [1, 2, 3]);
  assert.deepEqual(unwrap(segs), [[[0, 2], [2, 5], [5, 5]]]);
});

test('statOf reads the named column of the first row and captions with the next column', () => {
  const table = { columns: ['weight_kg', 'local_date'], rows: [[104.4, '2026-08-16']] };
  const s = lib.statOf(table, { y: ['weight_kg'] });
  assert.equal(s.value, 104.4);
  assert.equal(s.caption, '2026-08-16');
  assert.equal(lib.statOf({ columns: ['n'], rows: [] }, { y: ['n'] }).value, null);
});

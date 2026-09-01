/* THE 0.5.1 HARDENING (Vex audit, 2026-09-01).
 *
 * M2: the catalog carries structure only unless the member opts in to
 * values. L4: cache and catalog keys carry a hash of the full vault path
 * so same-named databases stop colliding, with the 0.5.0 key still read
 * when it names the same database. L2: the console line never carries SQL
 * or database content. L3: the sqlite3 path setting only accepts an
 * absolute path whose file name says sqlite3. L1: the .json claim rides a
 * setting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib } = loadPlugin();

async function bootPlugin(fresh, adapter, saved = null) {
  const registered = [];
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app, saved);
  plugin.app = app;
  plugin.registerExtensions = (exts, type) => registered.push([exts.join(','), type]);
  await plugin.onload();
  return { plugin, registered };
}

/* ------------------------------------------------- M2: values are opt-in -- */

function stubSchemaQueries(plugin) {
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async (db, sql) => {
    if (/sqlite_master/.test(sql)) return { columns: ['name'], rows: [['health_mood']], ms: 1 };
    if (/table_info/.test(sql)) return { columns: ['cid', 'name', 'type'], rows: [[0, 'mood', 'TEXT'], [1, 'score', 'REAL']], ms: 1 };
    if (/DISTINCT "mood"/.test(sql)) return { columns: ['mood'], rows: [['low'], ['fine'], ['great']], ms: 1 };
    throw new Error('unexpected: ' + sql);
  };
}

test('M2: by default the catalog holds structure only, no raw values', async () => {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/moods.db': new Uint8Array([1]) });
  const { plugin } = await bootPlugin(fresh, adapter);
  stubSchemaQueries(plugin);
  await plugin.writeCatalog('07 Data/moods.db');
  const path = lib.catalogPathFor(plugin.settings.cacheFolder, '07 Data/moods.db');
  const catalog = JSON.parse(adapter.files.get(path));
  assert.equal(catalog.tables[0].name, 'health_mood', 'the structure is there');
  assert.deepEqual(unwrap(catalog.values), {}, 'no value of any column reaches the synced file by default');
});

test('M2: with the setting on, small text columns are harvested as before', async () => {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/moods.db': new Uint8Array([1]) });
  const { plugin } = await bootPlugin(fresh, adapter);
  stubSchemaQueries(plugin);
  plugin.settings.catalogIncludeValues = true;
  await plugin.writeCatalog('07 Data/moods.db');
  const path = lib.catalogPathFor(plugin.settings.cacheFolder, '07 Data/moods.db');
  const catalog = JSON.parse(adapter.files.get(path));
  assert.deepEqual(unwrap(catalog.values['health_mood.mood']), ['fine', 'great', 'low']);
});

test('M2: without values, the picker path says to type the value, naming the setting', async () => {
  const fresh = loadPlugin();
  const catalog = {
    database: '07 Data/big.db', computedAt: '2026-09-01T10:00:00Z',
    tables: [{ name: 't', columns: [{ name: 'kind', type: 'TEXT' }] }],
    values: {},
  };
  const adapter = makeFakeAdapter(
    { [lib.catalogPathFor('07 Data/Dashboard Cache', '07 Data/big.db')]: JSON.stringify(catalog) },
    { '07 Data/big.db': new Uint8Array(3 * 1024 * 1024) }
  );
  const { plugin } = await bootPlugin(loadPlugin({ desktop: false }), adapter);
  plugin.settings.mobileCapMb = 1;
  await assert.rejects(plugin.distinctValues('07 Data/big.db', 't', 'kind'),
    /Include category values in the mobile catalog/);
});

/* --------------------------------------------- L4: collision-free keys -- */

test('L4: same-named databases in different folders get different catalog paths', () => {
  const a = lib.catalogPathFor('C', 'A/health.db');
  const b = lib.catalogPathFor('C', 'B/health.db');
  assert.notEqual(a, b);
  assert.match(a, /catalogs\/health-[0-9a-f]{8}\.json$/);
  assert.equal(lib.catalogPathFor('C', 'A/health.db'), a, 'the key is stable');
});

test('L4: a 0.5.0 stem-keyed catalog is still read, but only when it names the same database', async () => {
  const fresh = loadPlugin();
  const legacy = {
    database: '07 Data/big.db', computedAt: '2026-09-01T10:00:00Z',
    tables: [{ name: 't', columns: [] }], values: {},
  };
  const adapter = makeFakeAdapter(
    { '07 Data/Dashboard Cache/catalogs/big.json': JSON.stringify(legacy) },
    { '07 Data/big.db': new Uint8Array([1]) }
  );
  const { plugin } = await bootPlugin(fresh, adapter);
  const found = await plugin.readCatalog('07 Data/big.db');
  assert.ok(found, 'the legacy key still reads');
  assert.equal(found.database, '07 Data/big.db');
  const wrong = await plugin.readCatalog('Elsewhere/big.db');
  assert.equal(wrong, null, 'a same-named database in another folder must not inherit the catalog');
});

/* ------------------------------------------------- L2: the console line -- */

test('L2: the console line carries the place and the error class, never the message', () => {
  const e = new Error("no such table: secret_diagnosis near 'SELECT qty FROM health'");
  e.name = 'Error';
  const line = lib.safeLogLine('dashboards failed to render', e);
  assert.equal(line, 'ICOR SQLite Viewer: dashboards failed to render (Error)');
  assert.doesNotMatch(line, /secret|SELECT|health/);
  assert.equal(lib.safeLogLine('x', null), 'ICOR SQLite Viewer: x (Error)');
});

/* --------------------------------------------- L3: the sqlite3 path rule -- */

test('L3: the sqlite3 path must be absolute and named like sqlite3; empty clears it', () => {
  assert.equal(lib.checkSqlite3Path('').ok, true);
  assert.equal(lib.checkSqlite3Path('  ').empty, true);
  assert.equal(lib.checkSqlite3Path('/opt/homebrew/bin/sqlite3').ok, true);
  assert.equal(lib.checkSqlite3Path('C:\\tools\\sqlite3.exe').ok, true);
  assert.match(lib.checkSqlite3Path('sqlite3').reason, /full path/);
  assert.match(lib.checkSqlite3Path('/usr/bin/python3').reason, /sqlite3/);
  assert.match(lib.checkSqlite3Path('/tmp/evil').reason, /sqlite3/);
});

/* ------------------------------------------------- L1: the .json setting -- */

test('L1: the .json claim rides its setting; the database extensions never do', async () => {
  const on = await bootPlugin(loadPlugin(), makeFakeAdapter());
  assert.deepEqual(unwrap(on.registered.map((r) => r[0])), ['db,sqlite,sqlite3', 'json'], 'default: both registered');
  const off = await bootPlugin(loadPlugin(), makeFakeAdapter(), { openJsonFiles: false });
  assert.deepEqual(unwrap(off.registered.map((r) => r[0])), ['db,sqlite,sqlite3'], 'setting off: json stays free');
});

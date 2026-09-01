/* THE ENGINES.
 *
 * Engine A is a process invocation, so its gate watches the arguments: the
 * SQL must travel as one execFile argument (never through a shell), the
 * database must be opened read-only twice over (-readonly plus mode=ro in
 * the URI), the timeout must reach the process runner, and a killed query
 * must come back in plain words. Engine B is measured end to end: a real
 * database is built with sql.js in the test realm, handed to the plugin as
 * bytes behind a fake adapter, and queried through the plugin's own loader,
 * which is exactly the mobile path. The QueryService on top is measured for
 * the two rules that make the whole plugin safe: the gate runs before any
 * engine, and the row cap lands on uncapped SELECTs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeRequire = createRequire(import.meta.url);
const { lib, makePlugin } = loadPlugin();

/* ------------------------------------------------------------- the URI -- */

test('the database URI is read-only and survives spaces, percent signs and question marks', () => {
  const uri = lib.dbFileUri('/Users/tom/My Life Folder - TR/07 Data/mypka-health.db');
  assert.equal(uri, 'file:/Users/tom/My Life Folder - TR/07 Data/mypka-health.db?mode=ro');
  assert.equal(lib.dbFileUri('/a/100%?x#y.db'), 'file:/a/100%25%3fx%23y.db?mode=ro');
});

/* ---------------------------------------------------------- Engine A -- */

function fakeCli(behaviour) {
  const calls = [];
  return {
    calls,
    childProcess: {
      execFile(bin, args, options, cb) {
        calls.push({ bin, args, options });
        setImmediate(() => behaviour(cb, { bin, args, options }));
      },
    },
    pathx: nodeRequire('path'),
  };
}

test('Engine A: the SQL is one argument after -readonly and -json, never a shell string', async () => {
  const sql = "SELECT * FROM t WHERE a = 'x; rm -rf'";
  const deps = fakeCli((cb) => cb(null, '[{"a":1}]', ''));
  const table = await lib.cliQuery(deps, { absPath: '/v/x.db', sql, timeoutMs: 1234 });
  assert.equal(deps.calls.length, 1);
  const call = deps.calls[0];
  assert.equal(call.bin, 'sqlite3');
  assert.deepEqual(unwrap(call.args), ['-readonly', '-json', '-cmd', '.timeout 5000', 'file:/v/x.db?mode=ro', sql]);
  assert.equal(call.options.timeout, 1234);
  assert.equal(call.options.killSignal, 'SIGKILL');
  assert.deepEqual(unwrap(table), { columns: ['a'], rows: [[1]] });
});

test('Engine A: zero rows print nothing and come back as an empty table', async () => {
  const deps = fakeCli((cb) => cb(null, '', ''));
  const table = await lib.cliQuery(deps, { absPath: '/v/x.db', sql: 'SELECT 1 WHERE 0' });
  assert.deepEqual(unwrap(table), { columns: [], rows: [] });
});

test('Engine A: a killed query says how long it waited, in plain words', async () => {
  const deps = fakeCli((cb) => { const e = new Error('killed'); e.killed = true; cb(e, '', ''); });
  await assert.rejects(
    lib.cliQuery(deps, { absPath: '/v/x.db', sql: 'SELECT 1', timeoutMs: 30000 }),
    /stopped after 30 seconds/
  );
});

test('Engine A: sqlite3 errors surface as their own text, without a scary prefix', async () => {
  const deps = fakeCli((cb) => cb(new Error('exit 1'), '', 'Error: no such table: nope\n'));
  await assert.rejects(lib.cliQuery(deps, { absPath: '/v/x.db', sql: 'SELECT * FROM nope' }), /no such table: nope/);
});

test('Engine A: a locked database explains itself in plain words', async () => {
  const deps = fakeCli((cb) => cb(new Error('exit 5'), '', 'Error: in prepare, database is locked (5)\n'));
  await assert.rejects(
    lib.cliQuery(deps, { absPath: '/v/x.db', sql: 'SELECT 1' }),
    /Another app is writing to this database right now/
  );
});

test('detectCli: a found binary reports its version, a missing one says so plainly', async () => {
  const found = fakeCli((cb) => cb(null, '3.51.0 2025-06-12 abcdef\n', ''));
  assert.deepEqual(unwrap(await lib.detectCli(found)), { ok: true, version: '3.51.0' });
  const missing = fakeCli((cb) => cb(new Error('ENOENT'), '', ''));
  const r = await lib.detectCli(missing);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/);
});

/* ------------------------------------------------- the QueryService -- */

async function makeServicePlugin(adapter, { desktop = true } = {}) {
  const fresh = loadPlugin({ desktop });
  const app = {
    vault: { adapter, getFiles: () => [] },
    workspace: { onLayoutReady: () => {} },
  };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  return { plugin, lib: fresh.lib };
}

test('the service refuses a write before any engine is asked', async () => {
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const { plugin } = await makeServicePlugin(adapter);
  const deps = fakeCli((cb) => cb(null, '[]', ''));
  plugin.query.deps = deps;
  plugin.query.cli = { ok: true, version: 'gate' };
  await assert.rejects(plugin.query.query('07 Data/x.db', 'DROP TABLE t'), /Only read queries/);
  assert.equal(deps.calls.length, 0, 'the gate must fire before the process runner');
});

test('the row cap lands on an uncapped SELECT and leaves a capped one alone', async () => {
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  adapter.getBasePath = () => '/vault';
  const { plugin } = await makeServicePlugin(adapter);
  const deps = fakeCli((cb) => cb(null, '[]', ''));
  plugin.query.deps = deps;
  plugin.query.cli = { ok: true, version: 'gate' };
  const res = await plugin.query.query('07 Data/x.db', 'SELECT * FROM t', { cap: 500 });
  assert.equal(res.capped, true);
  assert.match(deps.calls[0].args[5], / LIMIT 500$/);
  await plugin.query.query('07 Data/x.db', 'SELECT * FROM t LIMIT 7', { cap: 500 });
  assert.match(deps.calls[1].args[5], /LIMIT 7$/);
  assert.doesNotMatch(deps.calls[1].args[5], /LIMIT 500/);
});

test('engine choice: no CLI and a file over the cap means no engine, in plain words', async () => {
  const big = new Uint8Array(3 * 1024 * 1024);
  const adapter = makeFakeAdapter({}, { '07 Data/big.db': big });
  const { plugin } = await makeServicePlugin(adapter, { desktop: false });
  plugin.settings.mobileCapMb = 2;
  plugin.query.cli = { ok: false, reason: 'not here' };
  const choice = await plugin.query.engineFor('07 Data/big.db');
  assert.equal(choice.engine, null);
  assert.match(choice.reason, /too big to load into memory/);
  assert.match(choice.reason, /the cap is 2 MB/);
  assert.match(choice.reason, /desktop cache/);
  const missing = await plugin.query.engineFor('07 Data/gone.db');
  assert.equal(missing.engine, null);
  assert.match(missing.reason, /not found/);
});

test('Engine B end to end: real bytes through the plugin loader, on the mobile path', async () => {
  /* Build a real database in the test realm with the same vendored sql.js. */
  const initSqlJs = nodeRequire(resolve(repo, 'sql-wasm.js'));
  const SQL = await initSqlJs({ wasmBinary: readFileSync(resolve(repo, 'sql-wasm.wasm')) });
  const source = new SQL.Database();
  source.run('CREATE TABLE things (day TEXT, n INTEGER)');
  source.run("INSERT INTO things VALUES ('2026-08-01', 3), ('2026-08-02', 5)");
  const bytes = source.export();
  source.close();

  const pluginDir = '.obsidian/plugins/icor-for-life-sqlite-viewer';
  const adapter = makeFakeAdapter(
    { [pluginDir + '/sql-wasm.js']: readFileSync(resolve(repo, 'sql-wasm.js'), 'utf8') },
    {
      [pluginDir + '/sql-wasm.wasm']: readFileSync(resolve(repo, 'sql-wasm.wasm')),
      '07 Data/tiny.db': bytes,
    }
  );
  const { plugin } = await makeServicePlugin(adapter, { desktop: false });
  assert.equal(plugin.query.deps, null, 'no Node handles exist off the desktop');
  const choice = await plugin.query.engineFor('07 Data/tiny.db');
  assert.equal(choice.engine, 'wasm');
  const res = await plugin.query.query('07 Data/tiny.db', 'SELECT day, n FROM things ORDER BY day');
  assert.equal(res.engine, 'wasm');
  assert.deepEqual(unwrap(res.rows), [['2026-08-01', 3], ['2026-08-02', 5]]);
  /* And the gate holds on this engine too. */
  await assert.rejects(plugin.query.query('07 Data/tiny.db', 'DELETE FROM things'), /Only read queries/);
});

/* ---------------------------------------------------- the dashboard cache -- */

test('the cache round-trips through the adapter, keyed by dashboard id, and a 0.1.x cache still reads', async () => {
  const adapter = makeFakeAdapter();
  const { plugin } = await makeServicePlugin(adapter);
  const spec = { id: 'health-overview', title: 'Health', database: '07 Data/mypka-health.db', tiles: [] };
  const tiles = [{ title: 'T', viz: 'stat', x: '', y: ['n'], unit: '', stack: false, columns: ['n'], rows: [[42]] }];
  await plugin.writeDashboardCache(spec, tiles);
  const path = '07 Data/Dashboard Cache/dashboards/health-overview.json';
  assert.equal(adapter.files.has(path), true);
  const cache = await plugin.readDashboardCache(spec);
  assert.equal(cache.dashboardId, 'health-overview');
  assert.deepEqual(unwrap(cache.tiles[0].rows), [[42]]);
  assert.equal(typeof cache.computedAt, 'string');
  /* A cache written by 0.1.x under the database stem is still found. */
  const old = { id: 'legacy-dash', title: 'L', database: '07 Data/mypka-health.db', tiles: [] };
  await adapter.write('07 Data/Dashboard Cache/mypka-health/legacy-dash.json',
    JSON.stringify({ dashboardId: 'legacy-dash', computedAt: '2026-09-01T00:00:00Z', tiles: [] }));
  const legacy = await plugin.readDashboardCache(old);
  assert.equal(legacy.dashboardId, 'legacy-dash');
});

test('a broken cache file reads as no cache, never as a crash', async () => {
  const adapter = makeFakeAdapter({ '07 Data/Dashboard Cache/mypka-health/health-overview.json': '{ not json' });
  const { plugin } = await makeServicePlugin(adapter);
  const spec = { id: 'health-overview', title: 'Health', database: '07 Data/mypka-health.db', tiles: [] };
  assert.equal(await plugin.readDashboardCache(spec), null);
});

/* ------------------------------------------------- the starter writer -- */

test('starter files are written once and never overwritten', async () => {
  const adapter = makeFakeAdapter(
    { '07 Data/Dashboards/health-overview.json': 'MEMBER EDITED' },
    {
      '07 Data/mypka-health.db': new Uint8Array([1]),
      '07 Data/engagement.db': new Uint8Array([1]),
      '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db': new Uint8Array([1]),
    }
  );
  const { plugin } = await makeServicePlugin(adapter);
  await plugin.ensureStarterFiles();
  assert.equal(adapter.files.get('07 Data/Dashboards/health-overview.json'), 'MEMBER EDITED',
    'an edited dashboard is the member\'s, not the plugin\'s');
  assert.equal(adapter.files.has('07 Data/Dashboards/README.md'), true);
  assert.equal(adapter.files.has('07 Data/Dashboards/engagement-overview.json'), true);
  assert.equal(adapter.files.has('07 Data/Dashboards/youtube-overview.json'), true);
  const before = adapter.log.length;
  await plugin.ensureStarterFiles();
  const writesAfter = adapter.log.slice(before).filter((l) => l[0] === 'write');
  assert.equal(writesAfter.length, 0, 'the second load writes nothing');
});

/* THE LIVE PIPELINE.
 *
 * The 0.1.0 dashboards rendered empty in the real vault while every unit
 * gate was green, which is exactly the failure the unit gates cannot see:
 * they never ran the shipped code against the real databases in the real
 * process environment. This gate does. It loads main.js, points a real
 * filesystem adapter at a real vault, strips the environment down to the
 * GUI PATH the Obsidian process actually gets on macOS
 * (/usr/bin:/bin:/usr/sbin:/sbin), and runs the full dashboard pipeline:
 * discover specs, parse them, run every tile's query through the plugin's
 * own QueryService, and write the cache. Reads touch the real databases
 * (read-only, as always); writes are redirected into a temp overlay so the
 * gate never modifies the vault.
 *
 * It runs only when ICOR_SQLV_VAULT names a vault, so `npm test` stays
 * hermetic on machines without one:
 *
 *   ICOR_SQLV_VAULT="/path/to/vault" node --test test/live-pipeline.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

import { loadPlugin } from './harness.mjs';

const vaultPath = process.env.ICOR_SQLV_VAULT;
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/* A real-fs adapter: reads come from the vault, writes land in an overlay
 * temp directory, so the gate proves the pipeline without touching the
 * vault. Paths are vault-relative with forward slashes, like Obsidian's. */
function makeLiveAdapter(vault, overlay) {
  const overlaid = (p) => join(overlay, ...p.split('/'));
  const real = (p) => join(vault, ...p.split('/'));
  const pick = (p) => (existsSync(overlaid(p)) ? overlaid(p) : real(p));
  return {
    getBasePath: () => vault,
    async exists(p) { return existsSync(pick(p)); },
    async stat(p) {
      const abs = pick(p);
      if (!existsSync(abs)) return null;
      const st = statSync(abs);
      return { size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
    },
    async read(p) { return readFileSync(pick(p), 'utf8'); },
    async readBinary(p) { return readFileSync(pick(p)); },
    async mkdir(p) { mkdirSync(overlaid(p), { recursive: true }); },
    async write(p, text) {
      mkdirSync(dirname(overlaid(p)), { recursive: true });
      writeFileSync(overlaid(p), text);
    },
    async list(p) {
      const out = { files: [], folders: [] };
      const abs = real(p);
      for (const name of existsSync(abs) ? readdirSync(abs) : []) {
        const rel = p + '/' + name;
        (statSync(join(abs, name)).isDirectory() ? out.folders : out.files).push(rel);
      }
      return out;
    },
  };
}

test('the full dashboard pipeline against the real vault, on the GUI PATH', { skip: !vaultPath && 'set ICOR_SQLV_VAULT to run the live gate' }, async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = GUI_PATH;
  const overlay = join(os.tmpdir(), 'icor-sqlv-live-' + Math.random().toString(36).slice(2, 10));
  mkdirSync(overlay, { recursive: true });
  try {
    const { makePlugin } = loadPlugin();
    const adapter = makeLiveAdapter(vaultPath, overlay);
    const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
    const plugin = makePlugin(app);
    await plugin.onload();

    const cli = await plugin.query.detect();
    assert.equal(cli.ok, true, 'sqlite3 must be found on the GUI PATH: ' + JSON.stringify(cli));

    const { specs, errors } = await plugin.loadDashboardSpecs();
    assert.equal(errors.length, 0, 'every spec on disk must parse: ' + JSON.stringify(errors));
    assert.ok(specs.length >= 3, 'the three starter dashboards must be discovered, found ' + specs.length);

    for (const spec of specs) {
      const choice = await plugin.query.engineFor(spec.database);
      assert.equal(choice.engine, 'cli', spec.id + ' must get the CLI engine on this desktop: ' + (choice.reason || ''));
      const cachedTiles = [];
      for (const tile of spec.tiles) {
        const res = await plugin.query.query(spec.database, tile.sql, { cap: 5000 });
        assert.ok(res.rows.length > 0, spec.id + ' / "' + tile.title + '" must return rows');
        cachedTiles.push(Object.assign({}, tile, { columns: res.columns, rows: res.rows }));
      }
      await plugin.writeDashboardCache(spec, cachedTiles);
      const cacheFile = join(overlay, '07 Data', 'Dashboard Cache', 'dashboards', spec.id + '.json');
      assert.ok(existsSync(cacheFile), 'the cache must be written for ' + spec.id);
      const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
      assert.equal(cache.tiles.length, spec.tiles.length);
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(overlay, { recursive: true, force: true });
  }
});

/* The 0.1.0 bug lived above the pipeline, in the view, so the view itself
 * is driven here: the real dashboards view class, the real specs on disk,
 * the real databases, a fake DOM. Empty is the one thing a dashboard is
 * never allowed to be: every tile ends as a drawn tile or as visible error
 * text. */
test('the dashboards view renders every tile or its error, never nothing', { skip: !vaultPath && 'set ICOR_SQLV_VAULT to run the live gate' }, async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = GUI_PATH;
  const overlay = join(os.tmpdir(), 'icor-sqlv-live-' + Math.random().toString(36).slice(2, 10));
  mkdirSync(overlay, { recursive: true });
  try {
    const { makePlugin } = loadPlugin();
    const adapter = makeLiveAdapter(vaultPath, overlay);
    const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
    const plugin = makePlugin(app);
    await plugin.onload();
    await plugin.query.detect();

    const factory = plugin.viewFactories['icor-sqlite-viewer-dashboards'];
    assert.ok(factory, 'the dashboards view must be registered');
    const view = factory({ app });
    view.app = app;
    await view.onOpen();
    /* renderDashboard runs unawaited from render(); give it one turn per
     * tile plus slack, then measure the DOM it left behind. The + tile
     * appears instantly and does not count as a rendered widget. */
    const realTiles = () => collectByClass(view.contentEl, 'icor-sqlv-tile').filter((el) => !el.classSet.has('icor-sqlv-add-tile'));
    for (let i = 0; i < 200 && realTiles().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    /* And let the last tile finish. */
    await new Promise((r) => setTimeout(r, 500));
    const tiles = realTiles();
    const errors = collectByClass(view.contentEl, 'icor-sqlv-error');
    assert.ok(tiles.length > 0 || errors.length > 0,
      'the view rendered nothing at all: no tiles and no visible error text');
    assert.equal(errors.map(textOf).join('; '), '', 'no tile may carry an error against the real vault');
    assert.ok(tiles.length >= 4, 'the active starter dashboard must render all its tiles, got ' + tiles.length);
    for (const tile of tiles) {
      assert.ok(tile.children.length > 0, 'a tile must contain a chart, a stat or a table, never be empty');
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(overlay, { recursive: true, force: true });
  }
});

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function treeHasClass(root, cls) { for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) return true; return false; }
function collectByClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }
function textOf(el) { let t = el.textContent || ''; for (const c of el.children || []) t += textOf(c); return t; }

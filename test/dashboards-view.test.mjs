/* THE DASHBOARDS VIEW.
 *
 * The 0.1.0 live bug: a dashboards view that opened before the starter
 * files existed stayed empty forever (the ribbon only revealed the stale
 * leaf), and a failure inside the un-awaited render chain died silently.
 * These gates pin the 0.1.1 rules: an empty folder seeds itself and
 * renders, a failing query becomes visible error text inside its tile, a
 * failure of the whole render chain becomes visible error text in the
 * view, and reload() re-reads the folder every time it is called.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeFakeAdapter } from './harness.mjs';

const VIEW_DASHBOARDS = 'icor-sqlite-viewer-dashboards';

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function collectByClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }
function textOf(el) { let t = el.textContent || ''; for (const c of el.children || []) t += ' ' + textOf(c); return t; }

async function makeView(adapter, { desktop = true } = {}) {
  const { makePlugin } = loadPlugin({ desktop });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {} } };
  const plugin = makePlugin(app);
  await plugin.onload();
  const view = plugin.viewFactories[VIEW_DASHBOARDS]({ app });
  view.app = app;
  return { plugin, view };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a view opened against an empty folder seeds the starters and finds them', async () => {
  const adapter = makeFakeAdapter();
  const { plugin, view } = await makeView(adapter);
  /* No engine will answer (no databases exist), but discovery must work. */
  plugin.query.cli = { ok: false, reason: 'gate' };
  await view.onOpen();
  await settle();
  assert.ok(view.specs.length >= 3, 'the starters must be seeded and discovered, found ' + view.specs.length);
  assert.ok(adapter.files.has('07 Data/Dashboards/health-overview.json'));
  assert.equal(view.activeId, view.specs[0].id);
});

test('a failing tile query renders its error text inside the tile, never an empty tile', async () => {
  const adapter = makeFakeAdapter();
  const { plugin, view } = await makeView(adapter);
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => { throw new Error('no such table: nope'); };
  await view.onOpen();
  await settle();
  const tiles = collectByClass(view.contentEl, 'icor-sqlv-tile');
  assert.ok(tiles.length > 0, 'tiles must exist');
  const errors = collectByClass(view.contentEl, 'icor-sqlv-error');
  assert.ok(errors.length > 0, 'the errors must be visible');
  assert.match(errors.map(textOf).join(' '), /no such table: nope/);
  const status = textOf(view.contentEl);
  assert.match(status, /queries failed/, 'the status line must say that queries failed');
});

test('a failure of the whole render chain lands in the view as text, never as a blank pane', async () => {
  const adapter = makeFakeAdapter();
  const { plugin, view } = await makeView(adapter);
  plugin.query.engineFor = async () => { throw new Error('the engine exploded'); };
  await view.onOpen();
  await settle();
  const errors = collectByClass(view.contentEl, 'icor-sqlv-error');
  assert.ok(errors.length > 0, 'the failure must be visible');
  const text = errors.map(textOf).join(' ');
  assert.match(text, /could not be drawn/);
  assert.match(text, /the engine exploded/);
});

test('reload() re-reads the folder, so a dashboard added after the first open appears', async () => {
  const adapter = makeFakeAdapter();
  const { plugin, view } = await makeView(adapter);
  plugin.query.cli = { ok: false, reason: 'gate' };
  await view.onOpen();
  await settle();
  const before = view.specs.length;
  await adapter.write('07 Data/Dashboards/extra.json', JSON.stringify({
    id: 'extra', title: 'Extra', database: '07 Data/x.db',
    tiles: [{ sql: 'SELECT 1 AS one', viz: 'stat', y: 'one' }],
  }));
  await view.reload();
  await settle();
  assert.equal(view.specs.length, before + 1, 'the new dashboard must be discovered on reload');
});

/* A STAT WIDGET CAN JUDGE A HIDDEN SCORE.
 *
 * The ranges judge the shown value, so a value that is not one number
 * ("114/66") could never carry a level. "rangeColumn" names a column of
 * the query whose number the ranges judge instead. That column is never
 * shown, not even as the caption. These gates pin the rules: the score
 * decides the level, the shown text stays as it is, a query without the
 * column draws a neutral tile, the spec validator names what is wrong in
 * plain words, and the option survives the spec file, the edit form and
 * the desktop cache. Every value here is invented for the gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib, obsidian } = loadPlugin();

const BANDS = [
  { low: 0, high: 0, level: 'Good', label: 'in range' },
  { low: 1, high: 1, level: 'Watch', label: 'watch' },
  { level: 'Alert', label: 'see doctor' },
];
const EXTRAS = { levels: lib.normalizeLevels(undefined), levelLooks: { stat: 'rail' } };

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function byClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }
function freshEl() { return new obsidian.Modal({}).contentEl; }
const parse = (tile) => lib.parseDashboardSpec(JSON.stringify({ id: 'rc', title: 'Score', database: '07 Data/x.db', tiles: [tile] }));
const pairTile = (extra) => Object.assign({ title: 'Pair', viz: 'stat', unit: 'u', y: 'value', sql: 'SELECT 1 AS value' }, extra);
const TABLE = (score) => ({ columns: ['value', 'score', 'note'], rows: [['120/70', score, 'as of today']] });

function draw(tile, table, extras) {
  const el = freshEl();
  lib.renderTile(el, tile, table, Object.assign({}, EXTRAS, extras || {}));
  return el;
}

test('THE BUG: a value that is not one number could never get a level', () => {
  const el = draw({ title: 'Pair', viz: 'stat', y: ['value'], ranges: BANDS.slice(0, 2) }, TABLE(2));
  assert.equal(el.classSet.has('is-level'), false, 'without rangeColumn, "120/70" is judged and matches nothing');
});

test('the ranges judge the rangeColumn, and the shown value stays as written', () => {
  for (const [score, level, pill] of [[0, 'Good', 'in range'], [1, 'Watch', 'watch'], [2, 'Alert', 'see doctor'], ['1', 'Watch', 'watch']]) {
    const el = draw({ title: 'Pair', viz: 'stat', unit: 'u', y: ['value'], ranges: BANDS, rangeColumn: 'score' }, TABLE(score));
    assert.ok(el.classSet.has('is-level'), 'score ' + score);
    assert.equal(el.getAttribute('aria-label'), 'Pair, 120/70 u, level ' + level + ', ' + pill);
    assert.deepEqual(byClass(el, 'icor-sqlv-stat-value')[0].children.map((c) => c.textContent), ['120/70', ' u']);
    assert.deepEqual(byClass(el, 'icor-sqlv-level-pill').map((p) => p.textContent), [pill]);
  }
});

test('the rangeColumn is never shown: the caption is the next column after it', () => {
  const el = draw({ title: 'Pair', viz: 'stat', y: ['value'], ranges: BANDS, rangeColumn: 'score' }, TABLE(0));
  assert.deepEqual(byClass(el, 'icor-sqlv-stat-caption').map((c) => c.textContent), ['as of today']);
  assert.equal(lib.statOf(TABLE(0), { y: ['value'], rangeColumn: 'score' }).caption, 'as of today');
  assert.equal(lib.statOf(TABLE(0), { y: ['value'] }).caption, '0', 'without it, the old caption rule is unchanged');
});

test('a query without the column, or a score that is not a number, draws a neutral tile, never an error', () => {
  const missing = draw({ viz: 'stat', y: ['value'], ranges: BANDS, rangeColumn: 'nope' }, TABLE(0));
  const blank = draw({ viz: 'stat', y: ['value'], ranges: BANDS.slice(0, 2), rangeColumn: 'score' }, TABLE(null));
  const empty = draw({ viz: 'stat', y: ['value'], ranges: BANDS, rangeColumn: 'score' }, { columns: ['value', 'score'], rows: [] });
  for (const el of [missing, blank, empty]) {
    assert.equal(el.classSet.has('is-level'), false);
    assert.equal(byClass(el, 'icor-sqlv-error').length, 0);
  }
});

test('the spec validator keeps a rangeColumn and names what is wrong, in plain words', () => {
  const ok = parse(pairTile({ ranges: BANDS, rangeColumn: ' score ' }));
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.spec.tiles[0].rangeColumn, 'score');
  assert.equal(parse(pairTile({ ranges: BANDS })).spec.tiles[0].rangeColumn, undefined);
  const bad = [
    [pairTile({ ranges: BANDS, rangeColumn: '' }), /"rangeColumn" must be the name of a column/],
    [pairTile({ ranges: BANDS, rangeColumn: 3 }), /"rangeColumn" must be the name of a column/],
    [pairTile({ rangeColumn: 'score' }), /"rangeColumn" needs "ranges"/],
    [pairTile({ ranges: BANDS, rangeColumn: 'value' }), /is the shown value already/],
    [{ title: 'L', viz: 'line', x: 'd', y: 'v', sql: 'SELECT 1 AS d, 2 AS v', rangeColumn: 'score' }, /only works on a stat widget/],
    [{ title: 'B', viz: 'stat', ranges: BANDS, rangeColumn: 'score', source: { table: 't', metric: 'v', agg: 'avg' } }, /only works on an SQL stat widget/],
  ];
  for (const [tile, re] of bad) {
    const r = parse(tile);
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
    assert.match(r.reason, /^Tile 1: /);
  }
});

test('a rangeColumn survives the spec file', () => {
  const first = parse(pairTile({ ranges: BANDS, rangeColumn: 'score' }));
  const json = lib.specToJson(first.spec);
  assert.equal(JSON.parse(json).tiles[0].rangeColumn, 'score');
  assert.equal(lib.parseDashboardSpec(json).spec.tiles[0].rangeColumn, 'score');
});

/* ---------------------------------------------- the view and the cache -- */

const DASH = '07 Databases/Dashboards/rc.json';
const CACHE = '07 Databases/Dashboard Cache/dashboards/rc.json';
const SPEC = { id: 'rc', title: 'Score', database: '07 Databases/x.db', tiles: [pairTile({ ranges: BANDS, rangeColumn: 'score' })] };
const settle = () => new Promise((r) => setTimeout(r, 20));

async function makeView(files, binaries, { desktop = true } = {}) {
  const fresh = loadPlugin({ desktop });
  const adapter = makeFakeAdapter(files, binaries);
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  const view = plugin.viewFactories['icor-sqlite-viewer-dashboards']({ app });
  view.app = app;
  return { plugin, view, adapter };
}

test('the desktop caches the score with the result, and a phone judges it at render time', async () => {
  const desk = await makeView({ [DASH]: JSON.stringify(SPEC) }, { '07 Databases/x.db': new Uint8Array([1]) });
  desk.plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  desk.plugin.query.query = async () => ({ columns: ['value', 'score', 'note'], rows: [['120/70', 1, 'as of today']], ms: 1 });
  await desk.view.onOpen();
  await settle();
  assert.match(byClass(desk.view.contentEl, 'is-level')[0].getAttribute('aria-label'), /level Watch/);
  const cache = desk.adapter.files.get(CACHE);
  assert.equal(JSON.parse(cache).tiles[0].rangeColumn, 'score');

  const phone = await makeView({ [DASH]: JSON.stringify(SPEC), [CACHE]: cache }, { '07 Databases/x.db': new Uint8Array([1]) }, { desktop: false });
  phone.plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big for this device.' });
  await phone.view.onOpen();
  await settle();
  assert.match(byClass(phone.view.contentEl, 'is-level')[0].getAttribute('aria-label'), /level Watch/);
});

/* ---------------------------------------------------------- the edit form -- */

async function makeForm(tile) {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['value', 'score'], rows: [['120/70', 2]], ms: 1 });
  const spec = { id: 'd', title: 'D', database: '07 Data/x.db', globalTimeframe: { preset: '90d' }, tiles: [tile], path: 'd.json' };
  const view = { saveAndRender: async (s) => { view.saved = s; } };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, 0);
  return { form, spec };
}

test('the edit screen shows the rangeColumn for an SQL stat tile and saves it back', async () => {
  const parsed = parse(pairTile({ ranges: BANDS, rangeColumn: 'score' }));
  const { form, spec } = await makeForm(parsed.spec.tiles[0]);
  form.open();
  assert.equal(form.state.rangeColumn, 'score');
  const input = [...walkEl(form.formEl)].find((e) => e.tagName === 'INPUT' && e.getAttribute('aria-label') === 'Judge the ranges on column');
  assert.ok(input, 'the field is on the form');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(form.previewState, 'ok');
  assert.match(byClass(form.previewEl, 'is-level')[0].getAttribute('aria-label'), /level Alert/, 'the preview judges the score');
  await form.save();
  assert.equal(spec.tiles[0].rangeColumn, 'score', 'an edit keeps it');
  form.state.rangeColumn = 'value';
  assert.match(form.buildTile().reason, /is the shown value already/);
  form.state.rangeColumn = '';
  assert.equal(form.buildTile().tile.rangeColumn, undefined, 'emptied, it is gone');
});

/* VALUE LEVELS ON STAT WIDGETS.
 *
 * A stat widget can judge its headline number against a list of ranges,
 * each naming a level from the plugin settings (Good, Watch, Alert by
 * default). These gates pin the rules: the first range that holds the
 * number wins, bounds are inclusive, a range with no low and no high is
 * the catch-all and must come last; the change badge never decides the
 * level; the level name is the tile's accessible label so colour is never
 * the only signal; a missing or broken setup draws a neutral tile, never
 * an error; the spec validator names what is wrong in plain words; the
 * ranges survive the spec file, the edit form and the desktop cache, and
 * a phone judges the cached number at render time. Every band here is
 * invented for the gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib, obsidian } = loadPlugin();

const BANDS = [
  { low: 10, high: 20, level: 'Good' },
  { low: 5, high: 28, level: 'Watch' },
  { level: 'Alert', label: 'check in' },
];

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
function byClass(root, cls) { const out = []; for (const el of walkEl(root)) if (el.classSet && el.classSet.has(cls)) out.push(el); return out; }
function freshEl() { return new obsidian.Modal({}).contentEl; }
function specWith(tile) {
  return { id: 'lv', title: 'Levels', database: '07 Data/x.db', tiles: [tile] };
}
const parse = (tile) => lib.parseDashboardSpec(JSON.stringify(specWith(tile)));
const statTile = (extra) => Object.assign({ title: 'Index', viz: 'stat', sql: 'SELECT 1 AS value' }, extra);

/* ------------------------------------------------------------ settings -- */

test('the default levels are Good, Watch and Alert, coloured by theme variables', () => {
  assert.deepEqual(unwrap(lib.DEFAULT_SETTINGS.levels), [
    { name: 'Good', color: 'var(--color-green)' },
    { name: 'Watch', color: 'var(--color-orange)' },
    { name: 'Alert', color: 'var(--color-red)' },
  ]);
  assert.deepEqual(unwrap(lib.DEFAULT_SETTINGS.levelLooks), { stat: 'rail' });
  assert.deepEqual(Object.keys(lib.LEVEL_LOOKS.stat), ['rail', 'outline', 'tint']);
});

test('saved levels are made safe on load: bad entries dropped, bad colours cleared, looks checked', () => {
  const fromDefaults = lib.normalizeLevels(undefined);
  assert.deepEqual(unwrap(fromDefaults), unwrap(lib.DEFAULT_LEVELS));
  fromDefaults[0].name = 'Changed';
  assert.equal(lib.DEFAULT_LEVELS[0].name, 'Good', 'the defaults are copied, never shared');
  assert.deepEqual(unwrap(lib.normalizeLevels([
    { name: ' Fine ', color: '#00aa00' },
    { name: '', color: '#ffffff' },
    { name: 'Fine', color: '#000000' },
    'nonsense',
    { name: 'Odd', color: 'red; background: url(x)' },
  ])), [{ name: 'Fine', color: '#00aa00' }, { name: 'Odd', color: '' }]);
  assert.deepEqual(unwrap(lib.normalizeLevels([])), [], 'a member who removed every level keeps none');
  assert.deepEqual(unwrap(lib.normalizeLevelLooks({ stat: 'tint' })), { stat: 'tint' });
  assert.deepEqual(unwrap(lib.normalizeLevelLooks({ stat: 'neon' })), { stat: 'rail' });
  assert.deepEqual(unwrap(lib.normalizeLevelLooks(null)), { stat: 'rail' });
});

test('only a theme variable or a six-digit hex counts as a level colour', () => {
  for (const ok of ['var(--color-red)', 'var(--my-accent-2)', '#a1b2c3', '#FFFFFF']) assert.equal(lib.isLevelColor(ok), true, ok);
  for (const bad of ['red', '#abc', 'rgb(1,2,3)', 'var(--x); color: red', 'var(--x) !important', '', null, 7]) {
    assert.equal(lib.isLevelColor(bad), false, String(bad));
  }
});

test('the plugin normalizes its saved levels when it loads', async () => {
  const fresh = loadPlugin();
  const app = { vault: { adapter: makeFakeAdapter(), getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app, { levels: [{ name: 'Fine', color: '#00ff00' }, { name: '' }], levelLooks: { stat: 'outline' } });
  await plugin.onload();
  assert.deepEqual(unwrap(plugin.settings.levels), [{ name: 'Fine', color: '#00ff00' }]);
  assert.deepEqual(unwrap(plugin.levelExtras()), { levels: [{ name: 'Fine', color: '#00ff00' }], levelLooks: { stat: 'outline' } });
});

/* ------------------------------------------------------ classification -- */

test('the first range that holds the number wins, bounds inclusive, the catch-all last', () => {
  assert.equal(lib.levelOf(15, BANDS).level, 'Good');
  assert.equal(lib.levelOf(10, BANDS).level, 'Good', 'low is inclusive');
  assert.equal(lib.levelOf(20, BANDS).level, 'Good', 'high is inclusive');
  assert.equal(lib.levelOf(20.01, BANDS).level, 'Watch', 'overlapping ranges: the first match wins');
  assert.equal(lib.levelOf(5, BANDS).level, 'Watch');
  assert.equal(lib.levelOf(4.9, BANDS).level, 'Alert');
  const alert = lib.levelOf(99, BANDS);
  assert.equal(alert.level, 'Alert');
  assert.equal(alert.label, 'check in');
  assert.equal(lib.levelOf(-3, [{ high: 0, level: 'Below' }]).level, 'Below', 'an open low end');
  assert.equal(lib.levelOf(3, [{ high: 0, level: 'Below' }]), null, 'no match and no catch-all: no level');
});

test('numeric text is judged like a number; anything that is not a number gets no level', () => {
  assert.equal(lib.levelOf('12.5', BANDS).level, 'Good', 'printf output arrives as text');
  for (const v of [null, undefined, '', 'n/a', NaN, Infinity, true]) assert.equal(lib.levelOf(v, BANDS), null, String(v));
  assert.equal(lib.levelOf(15, undefined), null);
  assert.equal(lib.levelOf(15, 'Good'), null);
  assert.equal(lib.levelOf(15, [{ low: '10', high: 20, level: 'Hand-edited' }, { level: 'Other' }]).level, 'Other',
    'a cached range with a broken bound never matches');
});

test('resolveLevel takes the colour from the settings; an unknown level stays neutral', () => {
  const levels = lib.normalizeLevels(undefined);
  const hit = lib.resolveLevel(99, { ranges: BANDS }, levels);
  assert.deepEqual(unwrap(hit), { name: 'Alert', label: 'check in', color: 'var(--color-red)', known: true, overridden: false });
  const unknown = lib.resolveLevel(99, { ranges: [{ level: 'Renamed' }] }, levels);
  assert.equal(unknown.known, false);
  assert.equal(unknown.color, '');
  assert.equal(lib.resolveLevel(99, { ranges: BANDS }, undefined).known, false, 'no settings, no colour');
  assert.equal(lib.resolveLevel(99, {}, levels), null, 'no ranges, no level');
});

/* ------------------------------------------------------- the validator -- */

test('the spec validator accepts ranges on a stat tile, SQL or built, and keeps them', () => {
  const sql = parse(statTile({ ranges: [{ low: 10, high: 20, level: ' Good ', label: ' fine ' }, { level: 'Alert' }] }));
  assert.equal(sql.ok, true, sql.reason);
  assert.deepEqual(unwrap(sql.spec.tiles[0].ranges), [{ low: 10, high: 20, level: 'Good', label: 'fine' }, { level: 'Alert' }]);
  const built = parse({ viz: 'stat', ranges: [{ high: 0, level: 'Below' }], source: { table: 't', metric: 'v', agg: 'avg' } });
  assert.equal(built.ok, true, built.reason);
  assert.deepEqual(unwrap(built.spec.tiles[0].ranges), [{ high: 0, level: 'Below' }]);
  const none = parse(statTile({}));
  assert.equal(none.spec.tiles[0].ranges, undefined, 'no ranges, no key');
  assert.equal(parse(statTile({ ranges: [{ low: null, high: 3, level: 'Low' }] })).ok, true, 'null means no limit');
});

test('the spec validator names what is wrong with a range, in plain words', () => {
  const reason = (ranges, extra) => parse(Object.assign(statTile({ ranges }), extra || {})).reason;
  assert.match(reason([{ level: 'Good' }], { viz: 'line', x: 'a', y: 'b' }), /^Tile 1: "ranges" only work on a stat widget/);
  assert.match(reason({ level: 'Good' }), /^Tile 1: "ranges" must be a list like/);
  assert.match(reason(['Good']), /^Tile 1, range 1 must be a JSON object/);
  assert.match(reason([{ low: '10', level: 'Good' }]), /^Tile 1, range 1: "low" must be a number, or left out for no limit\./);
  assert.match(reason([{ high: true, level: 'Good' }]), /"high" must be a number/);
  assert.match(reason([{ low: 30, high: 20, level: 'Good' }]), /^Tile 1, range 1: "low" \(30\) is above "high" \(20\)\./);
  assert.match(reason([{ low: 1 }]), /^Tile 1, range 1 needs a "level"/);
  assert.match(reason([{ low: 1, level: '   ' }]), /needs a "level"/);
  assert.match(reason([{ low: 1, level: 'Good', label: 7 }]), /^Tile 1, range 1: "label" must be short text, 24 characters at most\./);
  assert.match(reason([{ low: 1, level: 'Good', label: 'x'.repeat(25) }]), /"label" must be short text/);
  assert.match(reason([{ level: 'Alert' }, { low: 1, level: 'Good' }]),
    /^Tile 1, range 2 can never match: range 1 has no "low" and no "high", so it already catches every number\. Put the catch-all last\./);
  assert.match(reason(Array.from({ length: 13 }, () => ({ low: 1, level: 'Good' }))), /at most 12 ranges/);
});

/* ------------------------------------------------ round trips and cache -- */

test('ranges survive the spec file for SQL and built tiles', () => {
  for (const tile of [
    statTile({ ranges: BANDS }),
    { title: 'Built', viz: 'stat', ranges: BANDS, source: { table: 't', metric: 'v', agg: 'avg' } },
  ]) {
    const first = parse(tile);
    assert.equal(first.ok, true, first.reason);
    const json = lib.specToJson(first.spec);
    assert.deepEqual(JSON.parse(json).tiles[0].ranges, BANDS);
    const again = lib.parseDashboardSpec(json);
    assert.deepEqual(unwrap(again.spec.tiles[0].ranges), BANDS);
  }
  assert.equal(JSON.parse(lib.specToJson(parse(statTile({})).spec)).tiles[0].ranges, undefined);
});

test('a built stat widget carries its ranges to the renderer', () => {
  const parsed = parse({ title: 'Built', viz: 'stat', ranges: BANDS, source: { table: 't', metric: 'v', agg: 'avg' } });
  const prepared = lib.prepareTileForRender(parsed.spec.tiles[0], { columns: ['value'], rows: [[3]] });
  assert.deepEqual(unwrap(prepared.spec.ranges), BANDS);
});

/* ------------------------------------------------------------- the tile -- */

const EXTRAS = { levels: lib.normalizeLevels(undefined), levelLooks: { stat: 'rail' } };

function draw(tile, rows, extras) {
  const el = freshEl();
  lib.renderTile(el, tile, { columns: ['value'], rows }, Object.assign({}, EXTRAS, extras || {}));
  return el;
}

test('a stat tile on a level gets the look, the colour, the level name as its label, and the pill', () => {
  const el = draw({ title: 'Index', viz: 'stat', unit: 'pts', ranges: BANDS }, [[99]]);
  assert.ok(el.classSet.has('is-level'));
  assert.ok(el.classSet.has('is-level-rail'), 'the settings look for stat');
  assert.equal(el.style['--sqlv-level-color'], 'var(--color-red)');
  assert.equal(el.getAttribute('role'), 'group');
  assert.equal(el.getAttribute('aria-label'), 'Index, 99 pts, level Alert, check in');
  assert.deepEqual(byClass(el, 'icor-sqlv-level-pill').map((p) => p.textContent), ['check in']);
  const good = draw({ title: 'Index', viz: 'stat', ranges: BANDS }, [[12]]);
  assert.equal(good.getAttribute('aria-label'), 'Index, 12, level Good');
  assert.equal(byClass(good, 'icor-sqlv-level-pill').length, 0, 'no label, no pill');
  const tint = draw({ viz: 'stat', ranges: BANDS }, [[12]], { levelLooks: { stat: 'tint' } });
  assert.ok(tint.classSet.has('is-level-tint'));
});

test('the level judges the headline number, never the change', () => {
  /* 12 is Good; the comparison says it jumped +140% from 5. */
  const el = draw({ title: 'Index', viz: 'stat', ranges: BANDS }, [[12]], { ghost: { columns: ['value'], rows: [[5]] }, compare: 'previous', favorable: 'down' });
  assert.ok(byClass(el, 'is-bad').length, 'the badge still reads bad for this direction');
  assert.match(el.getAttribute('aria-label'), /level Good/);
});

test('a missing or broken setup draws a neutral tile, never an error', () => {
  const cases = [
    [{ viz: 'stat' }, [[99]], null, 'no ranges'],
    [{ viz: 'stat', ranges: BANDS }, [], null, 'no data'],
    [{ viz: 'stat', ranges: BANDS }, [['n/a']], null, 'not a number'],
    [{ viz: 'stat', ranges: [{ level: 'Renamed' }] }, [[99]], null, 'a level the settings no longer have'],
    [{ viz: 'stat', ranges: 'garbage' }, [[99]], null, 'a hand-edited cache'],
    [{ viz: 'stat', ranges: BANDS }, [[99]], { levels: undefined, levelLooks: undefined }, 'no settings at all'],
  ];
  for (const [tile, rows, extras, why] of cases) {
    const el = draw(tile, rows, extras);
    assert.equal(el.classSet.has('is-level'), false, why);
    assert.equal(el.getAttribute('aria-label'), null, why);
    assert.equal(byClass(el, 'icor-sqlv-error').length, 0, why);
  }
  const uncoloured = draw({ viz: 'stat', ranges: BANDS }, [[99]], { levels: [{ name: 'Alert', color: '' }] });
  assert.equal(uncoloured.classSet.has('is-level'), false, 'a level without a colour draws no mark');
  assert.match(uncoloured.getAttribute('aria-label'), /level Alert/, 'but its name is still read out');
});

/* ---------------------------------------------------- the dashboards view -- */

const VIEW_DASHBOARDS = 'icor-sqlite-viewer-dashboards';
const settle = () => new Promise((r) => setTimeout(r, 20));

async function makeView(files, binaries, { desktop = true } = {}) {
  const fresh = loadPlugin({ desktop });
  const adapter = makeFakeAdapter(files, binaries);
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  const view = plugin.viewFactories[VIEW_DASHBOARDS]({ app });
  view.app = app;
  return { plugin, view, adapter };
}

const DASH = '07 Databases/Dashboards/lv.json';
const CACHE = '07 Databases/Dashboard Cache/dashboards/lv.json';
const LV_SPEC = { id: 'lv', title: 'Levels', database: '07 Databases/x.db', tiles: [statTile({ ranges: BANDS })] };

test('the desktop writes the ranges into the cache with the result', async () => {
  const { plugin, view, adapter } = await makeView({ [DASH]: JSON.stringify(LV_SPEC) }, { '07 Databases/x.db': new Uint8Array([1]) });
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['value'], rows: [[99]], ms: 1 });
  await view.onOpen();
  await settle();
  const levelled = byClass(view.contentEl, 'is-level');
  assert.equal(levelled.length, 1, 'the live tile is marked');
  const cache = JSON.parse(adapter.files.get(CACHE));
  assert.deepEqual(cache.tiles[0].ranges, BANDS, 'the ranges ride in the cache');
});

test('a phone judges the cached number at render time, from the cached ranges', async () => {
  const cache = {
    dashboardId: 'lv', title: 'Levels', computedAt: new Date().toISOString(),
    tiles: [Object.assign(statTile({ ranges: BANDS }), { y: [], columns: ['value'], rows: [['12.0']], ghost: null })],
  };
  const { plugin, view } = await makeView({ [DASH]: JSON.stringify(LV_SPEC), [CACHE]: JSON.stringify(cache) }, { '07 Databases/x.db': new Uint8Array([1]) }, { desktop: false });
  plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big for this device.' });
  await view.onOpen();
  await settle();
  const tile = byClass(view.contentEl, 'is-level')[0];
  assert.ok(tile, 'the cached tile is marked');
  assert.equal(tile.style['--sqlv-level-color'], 'var(--color-green)');
  assert.match(tile.getAttribute('aria-label'), /level Good/);
  assert.ok(byClass(view.contentEl, 'icor-sqlv-note').some((n) => /Computed on desktop/.test(n.textContent)), 'it came from the cache');
});

/* ---------------------------------------------------------- the edit form -- */

async function makeForm(tile) {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.schemaFor = async () => ({ live: true, tables: [{ name: 'things', columns: [{ name: 'day', type: 'TEXT' }, { name: 'qty', type: 'REAL' }] }] });
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['value'], rows: [[99]], ms: 1 });
  const spec = { id: 'd', title: 'D', database: '07 Data/x.db', globalTimeframe: { preset: '90d' }, tiles: tile ? [tile] : [], path: 'd.json' };
  const view = { saveAndRender: async (s) => { view.saved = s; } };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, tile ? 0 : -1);
  return { form, spec, view, plugin };
}

test('the edit screen shows the ranges for an SQL stat tile and saves them back', async () => {
  const parsed = parse(statTile({ ranges: BANDS }));
  const { form, spec } = await makeForm(parsed.spec.tiles[0]);
  form.open();
  assert.equal(form.state.mode, 'sql');
  assert.equal(byClass(form.formEl, 'icor-sqlv-range-row').length, 3, 'one row per range');
  assert.deepEqual(unwrap(form.state.ranges[0]), { low: '10', high: '20', level: 'Good', label: '' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(form.previewState, 'ok');
  assert.ok(byClass(form.previewEl, 'is-level').length, 'the preview draws the level');
  form.state.ranges[0].high = '22';
  form.touch();
  await new Promise((r) => setTimeout(r, 500));
  await form.save();
  assert.deepEqual(unwrap(spec.tiles[0].ranges[0]), { low: 10, high: 22, level: 'Good' });
  const reparsed = lib.parseDashboardSpec(lib.specToJson(spec));
  assert.equal(reparsed.ok, true, reparsed.reason);
  assert.equal(reparsed.spec.tiles[0].ranges.length, 3);
});

test('the edit screen shows the ranges for a built stat widget too, and adds rows the right way round', async () => {
  const { form } = await makeForm(null);
  form.open();
  Object.assign(form.state, { database: '07 Data/x.db', table: 'things', metric: 'qty', agg: 'avg', viz: 'stat' });
  await form.ensureSchema();
  form.renderForm();
  const buttons = () => [...walkEl(form.formEl)].filter((e) => e.tagName === 'BUTTON');
  const click = (text) => buttons().find((b) => b.textContent === text).handlers.click[0]();
  click('+ Anything else');
  assert.equal(form.state.ranges.length, 1);
  assert.equal(form.state.ranges[0].level, 'Alert', 'the catch-all defaults to the last level');
  assert.equal(buttons().some((b) => b.textContent === '+ Anything else'), false, 'only one catch-all');
  click('+ Add range');
  assert.equal(form.state.ranges[1].level, 'Alert', 'a new range goes before the catch-all');
  assert.equal(form.state.ranges[0].level, 'Good');
  form.state.ranges[0].low = '1';
  form.state.ranges[0].label = 'fine';
  const built = form.buildTile();
  assert.equal(built.ok, true, built.reason);
  assert.deepEqual(unwrap(built.tile.ranges), [{ low: 1, level: 'Good', label: 'fine' }, { level: 'Alert' }]);
  form.state.ranges[0].low = 'ten';
  assert.match(form.buildTile().reason, /^Range 1: the low end must be a number/);
  form.state.ranges[0].low = '1';
  form.state.viz = 'bar';
  form.state.timeColumn = 'day';
  assert.equal(form.buildTile().tile.ranges, undefined, 'a chart carries no ranges');
  form.renderForm();
  assert.equal(byClass(form.formEl, 'icor-sqlv-range-row').length, 0, 'and shows none');
});

/* ------------------------------------------------ the stat tile fits 1x1 -- */

test('top to bottom: title on its own row, number, change line, then the pill in a footer', () => {
  const el = freshEl();
  lib.renderTile(el, { title: 'A much longer body fat title', viz: 'stat', ranges: BANDS }, { columns: ['value', 'change'], rows: [[99, 'down 0.3 vs. 30 days ago']] }, EXTRAS);
  const [title, body] = el.children;
  assert.ok(title.classSet.has('icor-sqlv-tile-title'), 'the title has its full row back');
  assert.equal(title.children.length, 0, 'nothing shares the title row');
  assert.equal(title.getAttribute('title'), 'A much longer body fat title', 'an ellipsized title keeps its full text on hover');
  assert.equal(byClass(el, 'icor-sqlv-tile-head').length, 0, 'the title-row head is gone');
  const stat = byClass(body, 'icor-sqlv-stat')[0];
  assert.deepEqual(stat.children.map((c) => [...c.classSet][0]), ['icor-sqlv-stat-value', 'icor-sqlv-stat-caption', 'icor-sqlv-stat-foot'], 'the footer comes last');
  const foot = stat.children[2];
  assert.deepEqual(foot.children.map((c) => [c.textContent, [...c.classSet][0]]), [['check in', 'icor-sqlv-level-pill']]);
  assert.equal(stat.children[1].getAttribute('title'), 'down 0.3 vs. 30 days ago', 'a clamped change line keeps its full text');
});

test('no label, no footer; a tile without a level has no footer either', () => {
  assert.equal(byClass(draw({ title: 'T', viz: 'stat', ranges: BANDS }, [[12]]), 'icor-sqlv-stat-foot').length, 0, 'Good has no label here');
  assert.equal(byClass(draw({ title: 'T', viz: 'stat' }, [[99]]), 'icor-sqlv-stat-foot').length, 0);
  assert.equal(byClass(draw({ title: 'T', viz: 'stat', ranges: [{ level: 'Renamed', label: 'x' }] }, [[99]]), 'icor-sqlv-stat-foot').length, 0,
    'a level the settings do not know shows no pill');
  const chart = freshEl();
  lib.renderTile(chart, { title: 'Chart', viz: 'line', x: 'x', y: ['value'] }, { columns: ['x', 'value'], rows: [['a', 1], ['b', 2]] }, EXTRAS);
  assert.ok(chart.children[0].classSet.has('icor-sqlv-tile-title'), 'charts are unchanged');
});

/* A fake layout: the stat's content height is the fixed parts plus the
 * change line's lines, which depend on the caption's class. */
function fitWorld(clientHeight) {
  const observers = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { this.cb([]); }
    disconnect() { this.gone = true; }
  }
  const fresh = loadPlugin({ globals: { ResizeObserver: FakeResizeObserver } });
  const stat = new fresh.obsidian.Modal({}).contentEl;
  const caption = stat.createDiv({ cls: 'icor-sqlv-stat-caption' });
  const lines = () => (caption.classSet.has('is-dropped') ? 0 : caption.classSet.has('is-clamped-1') ? 1 : 2);
  stat.isConnected = true;
  stat.clientHeight = clientHeight;
  Object.defineProperty(stat, 'scrollHeight', { get: () => 80 + lines() * 15 });
  return { fresh, stat, caption, observers };
}

test('the change line gives way in whole lines, two, then one, then none, and the rest never moves', () => {
  for (const [height, expected] of [[120, 2], [110, 2], [100, 1], [95, 1], [90, 0], [60, 0]]) {
    const { fresh, stat, caption } = fitWorld(height);
    fresh.lib.fitStatCaption(stat, caption);
    const lines = caption.classSet.has('is-dropped') ? 0 : caption.classSet.has('is-clamped-1') ? 1 : 2;
    assert.equal(lines, expected, 'at ' + height + 'px');
  }
});

test('the fit re-runs when the tile resizes and stops once the tile is gone', () => {
  const { fresh, stat, caption, observers } = fitWorld(90);
  fresh.lib.fitStatCaption(stat, caption);
  assert.ok(caption.classSet.has('is-dropped'));
  stat.clientHeight = 130;
  observers[0].cb([]);
  assert.equal(caption.classSet.has('is-dropped') || caption.classSet.has('is-clamped-1'), false, 'room again: two lines back');
  stat.isConnected = false;
  observers[0].cb([]);
  assert.equal(observers[0].gone, true);
});

test('the fit observer comes from the tile\'s own window and joins the view\'s observers', () => {
  const made = [];
  const recorder = (label) => class { constructor(cb) { this.cb = cb; this.label = label; made.push(this); } observe() {} disconnect() {} };
  const fresh = loadPlugin({ globals: { ResizeObserver: recorder('main') } });
  const tileEl = new fresh.obsidian.Modal({}).contentEl;
  tileEl.win = { ResizeObserver: recorder('popout') };
  const observers = [];
  fresh.lib.renderTile(tileEl, { title: 'Index', viz: 'stat' }, { columns: ['value', 'change'], rows: [[99, 'down 0.3']] }, { observers });
  assert.deepEqual(made.map((o) => o.label), ['popout'], 'a stat in a popout builds the popout\'s observer, never the main window\'s');
  assert.deepEqual(observers, made, 'the view can disconnect it on redraw and close');
});

test('without layout the fit is a no-op and the CSS clamp stands', () => {
  const stat = freshEl();
  const caption = stat.createDiv({ cls: 'icor-sqlv-stat-caption' });
  assert.equal(lib.fitStatCaption(stat, caption), undefined);
  assert.deepEqual([...caption.classSet], ['icor-sqlv-stat-caption']);
});

/* ------------------------------------------- per-widget colour override -- */

test('a per-widget colour changes only the colour; the level keeps its name', () => {
  const levels = lib.normalizeLevels(undefined);
  const tile = { ranges: BANDS, levelColors: { Alert: '#123456' } };
  const hit = lib.resolveLevel(99, tile, levels);
  assert.equal(hit.name, 'Alert');
  assert.equal(hit.color, '#123456');
  assert.equal(hit.overridden, true);
  assert.equal(lib.resolveLevel(12, tile, levels).color, 'var(--color-green)', 'other levels keep the settings colour');
  assert.equal(lib.resolveLevel(99, { ranges: BANDS, levelColors: { Alert: 'red; x' } }, levels).color, 'var(--color-red)',
    'a broken override falls back to the settings');
  const orphan = lib.resolveLevel(99, { ranges: [{ level: 'Gone' }], levelColors: { Gone: '#123456' } }, levels);
  assert.equal(orphan.known, false, 'an override never revives a level the settings do not have');
  const el = draw({ title: 'Index', viz: 'stat', ranges: BANDS, levelColors: { Alert: '#123456' } }, [[99]]);
  assert.equal(el.style['--sqlv-level-color'], '#123456');
  assert.match(el.getAttribute('aria-label'), /level Alert/);
});

test('the spec validator checks levelColors in plain words, and they survive the file', () => {
  const reason = (levelColors, extra) => parse(Object.assign(statTile({ ranges: BANDS, levelColors }), extra || {})).reason;
  assert.match(reason({ Alert: '#123456' }, { viz: 'line', x: 'a', y: 'b', ranges: undefined }), /^Tile 1: "levelColors" only work on a stat widget/);
  assert.match(reason(['#123456']), /^Tile 1: "levelColors" must be an object like/);
  assert.match(reason({ ' ': '#123456' }), /every name in "levelColors" must be a level name/);
  assert.match(reason({ Alert: 'red' }), /^Tile 1: the colour for "Alert" in "levelColors" must be a theme colour like "var\(--color-red\)" or a hex colour like "#d04040"\./);
  const ok = parse(statTile({ ranges: BANDS, levelColors: { Alert: '#123456', Good: 'var(--color-blue)' } }));
  assert.equal(ok.ok, true, ok.reason);
  const json = JSON.parse(lib.specToJson(ok.spec));
  assert.deepEqual(json.tiles[0].levelColors, { Alert: '#123456', Good: 'var(--color-blue)' });
  const built = parse({ viz: 'stat', ranges: BANDS, levelColors: { Alert: '#123456' }, source: { table: 't', metric: 'v', agg: 'avg' } });
  assert.deepEqual(unwrap(lib.prepareTileForRender(built.spec.tiles[0], { columns: ['value'], rows: [[1]] }).spec.levelColors), { Alert: '#123456' });
});

test('the edit screen marks an overridden widget and resets it to the settings', async () => {
  const parsed = parse(statTile({ ranges: BANDS }));
  const { form, spec } = await makeForm(parsed.spec.tiles[0]);
  form.open();
  const marks = () => byClass(form.formEl, 'icor-sqlv-level-override-mark');
  assert.equal(marks().length, 0, 'no override, no mark');
  assert.equal(byClass(form.formEl, 'icor-sqlv-level-color-row').length, 3, 'one colour row per settings level');
  /* Pick a theme colour for Alert on this widget only. */
  const alertSelect = [...walkEl(form.formEl)].find((e) => e.tagName === 'SELECT' && e.getAttribute('aria-label') === 'Colour of Alert on this widget');
  alertSelect.value = 'var(--color-purple)';
  alertSelect.handlers.change[0]();
  assert.equal(marks().length, 1, 'the widget is marked as changed');
  assert.equal(marks()[0].textContent, 'Changed for this widget');
  assert.ok(byClass(form.formEl, 'icor-sqlv-level-colors')[0].classSet.has('is-overridden'));
  assert.deepEqual(unwrap(form.buildTile().tile.levelColors), { Alert: 'var(--color-purple)' });
  await new Promise((r) => setTimeout(r, 500));
  await form.save();
  assert.deepEqual(unwrap(spec.tiles[0].levelColors), { Alert: 'var(--color-purple)' });

  /* Open it again: the override is shown, and Reset clears it. */
  const again = await makeForm(spec.tiles[0]);
  again.form.open();
  const reset = [...walkEl(again.form.formEl)].find((e) => e.tagName === 'BUTTON' && e.textContent === 'Reset to settings');
  assert.ok(reset, 'an overridden widget offers the way back');
  reset.handlers.click[0]();
  assert.equal(byClass(again.form.formEl, 'icor-sqlv-level-override-mark').length, 0);
  assert.equal(again.form.buildTile().tile.levelColors, undefined, 'back on the settings colours');
});

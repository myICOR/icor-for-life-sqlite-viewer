/* CHART OBSERVERS LIVE IN THE TILE'S WINDOW AND DIE WITH THE VIEW.
 *
 * Follow-up to the chart-fit fix (#5), from the Flint read before 0.6.1.
 * Two things are pinned here. First, every ResizeObserver the dashboards
 * build (one per chart tile, one on the grid) comes from the element's own
 * window, `el.win`, so a dashboard in a popout window gets the popout's
 * observer; the main window's may deliver late or never there, and a
 * measured chart would keep its first size. The global is the fallback.
 * Second, the per-tile observers are tracked on the view and disconnected
 * on every redraw and on close, beside the grid watcher, instead of waiting
 * for their own next callback. Each gate has a mutated copy of main.js next
 * to it that must fail, so none of them passes vacuously.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadPlugin, makeFakeAdapter } from './harness.mjs';

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
const byClass = (root, cls) => [...walkEl(root)].filter((e) => e.classSet && e.classSet.has(cls));

/* A ResizeObserver class that records which window it belongs to. */
function observerClass(label, log) {
  return class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.label = label; this.gone = false; log.push(this); }
    observe(el) { this.el = el; }
    disconnect() { this.gone = true; }
  };
}

/* The main window's observer is the global; the popout has its own. */
function windows() {
  const made = [];
  const MainRO = observerClass('main', made);
  const popout = { ResizeObserver: observerClass('popout', made) };
  return { made, MainRO, popout };
}

/* Replace one exact snippet of main.js; fail loudly if it is not there. */
function mutate(from, to) {
  assert.equal(source.split(from).length, 2, 'mutation anchor found exactly once: ' + from);
  return source.replace(from, to);
}

const ROWS = [['2026-01-01', 180], ['2026-01-02', 181], ['2026-01-03', 179]];

function drawChartTile({ win, globals, sourceOverride = null }) {
  const fresh = loadPlugin({ globals, sourceOverride });
  const tileEl = new fresh.obsidian.Modal({}).contentEl;
  if (win) tileEl.win = win;
  fresh.lib.renderTile(tileEl, { viz: 'line', x: 'day', y: ['weight'] }, { columns: ['day', 'weight'], rows: ROWS }, {});
  return { tileEl, box: byClass(tileEl, 'icor-sqlv-chart-box')[0] };
}

/* The dashboards view on a phone, drawing from the desktop cache: two
 * charts and one stat, so two tile observers and one grid observer. */
async function openDashboards({ win, sourceOverride = null } = {}) {
  const w = windows();
  const fresh = loadPlugin({ desktop: false, sourceOverride, globals: { ResizeObserver: w.MainRO } });
  const tiles = [
    { title: 'Line', viz: 'line', sql: 'SELECT 1', x: 'day', y: 'weight' },
    { title: 'Bar', viz: 'bar', sql: 'SELECT 1', x: 'day', y: 'weight' },
    { title: 'Stat', viz: 'stat', sql: 'SELECT 1' },
  ];
  const spec = { id: 'obs', title: 'Observers', database: '07 Databases/x.db', tiles };
  const cache = {
    dashboardId: 'obs', title: 'Observers', computedAt: new Date().toISOString(),
    tiles: tiles.map((t) => Object.assign({}, t, t.viz === 'stat'
      ? { columns: ['value'], rows: [[42]], ghost: null }
      : { y: ['weight'], columns: ['day', 'weight'], rows: ROWS, ghost: null })),
  };
  const adapter = makeFakeAdapter({
    '07 Databases/Dashboards/obs.json': JSON.stringify(spec),
    '07 Databases/Dashboard Cache/dashboards/obs.json': JSON.stringify(cache),
  }, { '07 Databases/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big.' });
  const view = plugin.viewFactories['icor-sqlite-viewer-dashboards']({ app });
  view.app = app;
  if (win !== undefined) view.contentEl.win = win === 'popout' ? w.popout : win;
  await view.onOpen();
  await settle();
  return Object.assign({ view }, w);
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const chartBoxes = (view) => byClass(view.contentEl, 'icor-sqlv-chart-box');

test('a chart tile in a popout builds its observer from the popout window', () => {
  const w = windows();
  const { box } = drawChartTile({ win: w.popout, globals: { ResizeObserver: w.MainRO } });
  assert.equal(w.made.length, 1);
  assert.equal(w.made[0].label, 'popout');
  assert.equal(w.made[0].el, box);
});

test('without a window on the element, the global observer is the fallback; with none at all, the chart still draws', () => {
  const w = windows();
  drawChartTile({ globals: { ResizeObserver: w.MainRO } });
  assert.deepEqual(w.made.map((o) => o.label), ['main']);
  const bare = drawChartTile({ globals: {} });
  assert.equal(byClass(bare.tileEl, 'icor-sqlv-chart-host')[0].children.length, 1, 'drawn at the fallback frame');
});

test('a dashboard in a popout: the grid watcher and every chart observer are the popout\'s', async () => {
  const d = await openDashboards({ win: 'popout' });
  assert.equal(chartBoxes(d.view).length, 2);
  assert.equal(d.view.gridRO.label, 'popout');
  assert.equal(d.view.tileROs.length, 2, 'two charts, two tracked observers; the stat has none');
  for (const o of d.view.tileROs) assert.equal(o.label, 'popout');
  assert.equal(d.made.filter((o) => o.label === 'main').length, 0, 'nothing built from the main window');
});

test('closing the view disconnects every tile observer beside the grid watcher', async () => {
  const d = await openDashboards();
  const tracked = d.view.tileROs.slice();
  const grid = d.view.gridRO;
  assert.equal(tracked.length, 2);
  assert.ok(tracked.every((o) => !o.gone), 'live while the view is open');
  await d.view.onClose();
  assert.ok(tracked.every((o) => o.gone), 'every tile observer disconnected on close');
  assert.equal(grid.gone, true);
  assert.equal(d.view.gridRO, null);
  assert.equal(d.view.tileROs.length, 0);
});

test('a redraw disconnects the old tiles\' observers and tracks only the new ones', async () => {
  const d = await openDashboards();
  const first = d.view.tileROs.slice();
  d.view.render();
  await settle();
  assert.ok(first.every((o) => o.gone), 'the old tiles\' observers are gone');
  assert.equal(d.view.tileROs.length, 2);
  assert.ok(d.view.tileROs.every((o) => !o.gone && !first.includes(o)));
});

test('negative controls: each gate fails against the old shape', async () => {
  /* Built from the global again: the popout gate goes red. */
  const noWin = mutate('const win = el && el.win;', 'const win = null;');
  const w = windows();
  drawChartTile({ win: w.popout, globals: { ResizeObserver: w.MainRO }, sourceOverride: noWin });
  assert.equal(w.made[0].label, 'main', 'without el.win the popout gets the main window\'s observer');
  const g = await openDashboards({ win: 'popout', sourceOverride: noWin });
  assert.equal(g.view.gridRO.label, 'main');

  /* Not tracked on close: the close gate goes red. */
  const noRelease = mutate('    if (this.gridRO) { this.gridRO.disconnect(); this.gridRO = null; }\n    this.releaseTileObservers();\n', '    if (this.gridRO) { this.gridRO.disconnect(); this.gridRO = null; }\n');
  const c = await openDashboards({ sourceOverride: noRelease });
  const tracked = c.view.tileROs.slice();
  await c.view.onClose();
  assert.ok(tracked.every((o) => !o.gone), 'without the release, close leaves them connected');

  /* Not released on redraw: the redraw gate goes red. */
  const noRedrawRelease = mutate('    const root = this.contentEl;\n    this.releaseTileObservers();\n', '    const root = this.contentEl;\n');
  const r = await openDashboards({ sourceOverride: noRedrawRelease });
  const before = r.view.tileROs.slice();
  r.view.render();
  await settle();
  assert.ok(before.every((o) => !o.gone), 'without the release, a redraw leaves them connected');
});

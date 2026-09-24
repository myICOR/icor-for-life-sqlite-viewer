/* CHARTS FIT THEIR TILE.
 *
 * The bug: a line or bar chart drew into a fixed 640 x 260 frame and was
 * stretched to the tile's width, so a wide, short tile (3 x 1, a body of
 * 533 x 121) rendered the chart 216 tall and the tile edge cut its bottom
 * off. These gates pin the fix: the chart is drawn to the measured size of
 * its area (the viewBox is the real width and height), everything drawn
 * lands inside it at every size, the axis labels thin out and then step
 * aside before anything could be cut, the legend steps aside before the
 * plot gets too short, and the chart redraws when the tile resizes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeFakeAdapter } from './harness.mjs';

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
const byClass = (root, cls) => [...walkEl(root)].filter((e) => e.classSet && e.classSet.has(cls));

/* A world with a fake ResizeObserver the gate can fire by hand. */
function world() {
  const observers = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe(el) { this.el = el; }
    disconnect() { this.gone = true; }
  }
  const fresh = loadPlugin({ globals: { ResizeObserver: FakeResizeObserver } });
  return { lib: fresh.lib, obsidian: fresh.obsidian, observers };
}

const DAYS = Array.from({ length: 180 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i));
  return [d.toISOString().slice(0, 10), 180 + Math.sin(i / 9) * 6, 178 + Math.cos(i / 7) * 5];
});

/* Draw a tile, then give its chart area a size and fire the observer. */
function drawAt(kind, W, H, { rows = DAYS, y = ['weight'], ghost = null, legendH = 18 } = {}) {
  const { lib, obsidian, observers } = world();
  const tileEl = new obsidian.Modal({}).contentEl;
  const columns = ['day', 'weight', 'other'];
  lib.renderTile(tileEl, { title: 'Weight (last 180 days)', viz: kind, x: 'day', y }, { columns, rows }, ghost ? { ghost } : {});
  const box = byClass(tileEl, 'icor-sqlv-chart-box')[0];
  const host = byClass(tileEl, 'icor-sqlv-chart-host')[0];
  const legend = byClass(tileEl, 'icor-sqlv-legend')[0] || null;
  box.isConnected = true;
  box.clientHeight = H + (legend ? legendH : 0);
  if (legend) legend.offsetHeight = legendH;
  host.clientWidth = W;
  host.clientHeight = H;
  observers.find((o) => o.el === box).cb([]);
  const svg = host.children[0];
  return { lib, tileEl, box, host, legend, svg, observers };
}

/* Everything drawn lies inside the W x H frame. Text is checked with the
 * same per-character estimate the layout uses. */
function assertInside(svg, W, H, lib, why) {
  const EPS = 0.51;
  for (const el of walkEl(svg)) {
    if (el === svg || !el.attrs) continue;
    const a = el.attrs;
    const num = (k) => (a[k] === undefined ? null : Number(a[k]));
    for (const k of ['x', 'x1', 'x2', 'cx']) if (num(k) !== null && el.tagName !== 'TEXT') assert.ok(num(k) >= -EPS && num(k) <= W + EPS, why + ': ' + el.tagName + ' ' + k + '=' + a[k]);
    for (const k of ['y', 'y1', 'y2', 'cy']) if (num(k) !== null) assert.ok(num(k) >= -EPS && num(k) <= H + EPS, why + ': ' + el.tagName + ' ' + k + '=' + a[k]);
    if (num('width') !== null && num('x') !== null) assert.ok(num('x') + num('width') <= W + EPS, why + ': width');
    if (num('height') !== null && num('y') !== null) assert.ok(num('y') + num('height') <= H + EPS, why + ': height');
    if (el.tagName === 'TEXT' && a.y !== undefined) {
      const half = (el.textContent.length * lib.TICK_CHAR_W) / 2;
      const x = Number(a.x);
      const [l, r] = a['text-anchor'] === 'end' ? [x - 2 * half, x] : [x - half, x + half];
      assert.ok(l >= -EPS && r <= W + EPS, why + ': label "' + el.textContent + '" at ' + x);
      assert.ok(Number(a.y) - 8 >= -EPS && Number(a.y) + 3 <= H + EPS, why + ': label "' + el.textContent + '" y ' + a.y);
    }
    if (el.tagName === 'PATH' && a.d) {
      const nums = a.d.match(/-?\d+(\.\d+)?/g).map(Number);
      if (/^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+)*$/.test(a.d)) {
        for (let i = 0; i < nums.length; i += 2) {
          assert.ok(nums[i] >= -EPS && nums[i] <= W + EPS, why + ': path x ' + nums[i]);
          assert.ok(nums[i + 1] >= -EPS && nums[i + 1] <= H + EPS, why + ': path y ' + nums[i + 1]);
        }
      } else {
        for (const v of nums) assert.ok(v >= -EPS && v <= Math.max(W, H) + EPS, why + ': path ' + v);
      }
    }
  }
}

const SIZES = [[533, 121], [144, 118], [310, 118], [700, 300], [1100, 560], [90, 60], [40, 30]];

test('THE BUG: a 3x1 tile draws the chart to its own 533 x 121, not a stretched 640 x 260', () => {
  const { svg, lib } = drawAt('line', 533, 121);
  assert.equal(svg.getAttribute('viewBox'), '0 0 533 121');
  assert.equal(svg.getAttribute('width'), '533');
  assert.equal(svg.getAttribute('height'), '121');
  assert.match(svg.getAttribute('class'), /is-measured/);
  assertInside(svg, 533, 121, lib, '533x121');
});

test('line and bar charts, with and without a ghost and a second series, fit at every size', () => {
  const ghost = { columns: ['x', 'value'], rows: DAYS.map((r) => [r[0], r[1] - 3]) };
  for (const [W, H] of SIZES) {
    for (const kind of ['line', 'bar']) {
      const rows = kind === 'bar' ? DAYS.slice(0, 30) : DAYS;
      const one = drawAt(kind, W, H, { rows, ghost });
      assertInside(one.svg, W, H, one.lib, kind + ' ' + W + 'x' + H);
      const two = drawAt(kind, W, H, { rows, y: ['weight', 'other'] });
      assertInside(two.svg, W, H, two.lib, kind + ' two series ' + W + 'x' + H);
    }
  }
});

test('axis labels thin out, then step aside, before anything is cut', () => {
  const { lib } = world();
  const labels = DAYS.map((r) => r[0]);
  const xOf = (L) => (i) => L.left + (i / (labels.length - 1)) * L.plotW;
  const wide = lib.chartLayout(1100, 300, 170, 190, true);
  const narrow = lib.chartLayout(310, 118, 170, 190, true);
  const wideN = lib.xLabelPlan(wide, labels, xOf(wide)).length;
  const narrowN = lib.xLabelPlan(narrow, labels, xOf(narrow)).length;
  assert.ok(wideN <= 7 && wideN >= 5, 'a wide chart shows up to seven dates, got ' + wideN);
  assert.ok(narrowN < wideN && narrowN >= 2, 'a narrow one fewer, got ' + narrowN);
  const short = lib.chartLayout(533, lib.CHART_MIN_X_H - 1, 170, 190, true);
  assert.equal(short.showX, false, 'too short for dates: no x labels');
  assert.equal(lib.xLabelPlan(short, labels, xOf(short)).length, 0);
  assert.equal(short.bottom, 4, 'and their room goes to the plot');
  const slim = lib.chartLayout(lib.CHART_MIN_Y_W - 1, 200, 170, 190, true);
  assert.equal(slim.showY, false, 'too narrow for values: no y labels');
  assert.equal(slim.left, 4);
  const tall = lib.chartLayout(533, 400, 170, 190, true);
  const flat = lib.chartLayout(533, 121, 170, 190, true);
  assert.ok(flat.scale.ticks.length < tall.scale.ticks.length, 'fewer gridlines on a short chart');
  for (const L of [wide, narrow, short, slim, tall, flat]) {
    assert.equal(L.left + L.plotW + L.right, L.W, 'the plot fills the width exactly');
    assert.equal(L.top + L.plotH + L.bottom, L.H, 'and the height');
  }
});

test('the legend is one line and steps aside before the plot gets too short', () => {
  const tall = drawAt('line', 533, 200, { y: ['weight', 'other'] });
  assert.ok(tall.legend, 'two series have a legend');
  assert.equal(tall.legend.classSet.has('is-hidden'), false);
  const short = drawAt('line', 533, 50, { y: ['weight', 'other'] });
  assert.equal(short.legend.classSet.has('is-hidden'), true, 'a 68px box keeps its plot and drops the legend');
  const names = byClass(tall.tileEl, 'icor-sqlv-legend-name').map((e) => e.textContent);
  assert.deepEqual(names, ['weight', 'other']);
  assert.equal(byClass(tall.tileEl, 'icor-sqlv-legend-item')[0].getAttribute('title'), 'weight', 'a cut name keeps its full text');
});

test('the chart redraws when the tile resizes, only when the size changes, and stops when the tile is gone', () => {
  const d = drawAt('line', 533, 121);
  const first = d.host.children[0];
  const observer = d.observers.find((o) => o.el === d.box);
  observer.cb([]);
  assert.equal(d.host.children[0], first, 'same size: no redraw');
  d.host.clientWidth = 360;
  d.host.clientHeight = 300;
  observer.cb([]);
  assert.equal(d.host.children.length, 1, 'the old drawing is replaced, not stacked');
  assert.equal(d.host.children[0].getAttribute('viewBox'), '0 0 360 300');
  assertInside(d.host.children[0], 360, 300, d.lib, 'after resize');
  d.box.isConnected = false;
  observer.cb([]);
  assert.equal(observer.gone, true);
});

test('with nothing to measure, the chart keeps the old 640 x 260 frame that scales to the width', () => {
  const { lib, obsidian } = world();
  const el = new obsidian.Modal({}).contentEl;
  lib.renderTile(el, { viz: 'line', x: 'day', y: ['weight'] }, { columns: ['day', 'weight'], rows: DAYS.slice(0, 5) }, {});
  const svg = byClass(el, 'icor-sqlv-chart-host')[0].children[0];
  assert.equal(svg.getAttribute('viewBox'), '0 0 640 260');
  assert.equal(svg.getAttribute('width'), null);
  assert.doesNotMatch(svg.getAttribute('class'), /is-measured/);
});

test('every tile title and the phone cache line are one line, with the full text on hover', async () => {
  const spec = { id: 'fit', title: 'Fit', database: '07 Databases/x.db', tiles: [{ title: 'A very long chart title that will not fit', viz: 'line', sql: 'SELECT 1 AS day, 2 AS weight', x: 'day', y: 'weight' }] };
  const cache = { dashboardId: 'fit', title: 'Fit', computedAt: new Date().toISOString(), tiles: [Object.assign({}, spec.tiles[0], { y: ['weight'], columns: ['day', 'weight'], rows: [['a', 1], ['b', 2]], ghost: null })] };
  const fresh = loadPlugin({ desktop: false });
  const adapter = makeFakeAdapter({
    '07 Databases/Dashboards/fit.json': JSON.stringify(spec),
    '07 Databases/Dashboard Cache/dashboards/fit.json': JSON.stringify(cache),
  }, { '07 Databases/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: null, reason: 'Too big.' });
  const view = plugin.viewFactories['icor-sqlite-viewer-dashboards']({ app });
  view.app = app;
  await view.onOpen();
  await new Promise((r) => setTimeout(r, 20));
  const title = byClass(view.contentEl, 'icor-sqlv-tile-title')[0];
  assert.equal(title.getAttribute('title'), 'A very long chart title that will not fit');
  const note = byClass(view.contentEl, 'icor-sqlv-cache-note')[0];
  assert.ok(note, 'the cache line carries its own class');
  assert.match(note.getAttribute('title'), /^Computed on desktop/);
});

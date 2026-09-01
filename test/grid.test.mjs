/* THE GRID.
 *
 * The dashboard layout is a pure engine: spans migrate from 0.2.x files
 * with sensible defaults, {x,y,w,h} persists through the spec round-trip,
 * the packing rule (anchor stays, overlaps push down, everything floats
 * up) is deterministic, spans clamp on narrow columns, and the + tile
 * shows only on an empty dashboard or in edit mode. The INKLINE series
 * rules are measured here too: single series writes in ink, lenses carry
 * categories, six or more degrade to top-4 plus Other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib } = loadPlugin();

/* --------------------------------------------------- spans and defaults -- */

test('span migration defaults: stat 1x1, chart 2x2, table 3x2, placed without overlap', () => {
  const tiles = [
    { viz: 'stat' },
    { viz: 'bar' },
    { viz: 'line' },
    { viz: 'table' },
  ];
  const layouts = lib.normalizeLayout(tiles, 6);
  assert.deepEqual(unwrap(layouts[0]), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(unwrap(layouts[1]), { x: 1, y: 0, w: 2, h: 2 });
  assert.deepEqual(unwrap(layouts[2]), { x: 3, y: 0, w: 2, h: 2 });
  assert.deepEqual(unwrap(layouts[3]), { x: 0, y: 2, w: 3, h: 2 }, 'the table does not fit the remaining row and wraps');
  for (let i = 0; i < layouts.length; i++) {
    for (let j = i + 1; j < layouts.length; j++) {
      assert.equal(lib.rectsCollide(layouts[i], layouts[j]), false, i + ' and ' + j + ' must not overlap');
    }
  }
});

test('a spec-carried layout is respected; only missing ones get defaults', () => {
  const tiles = [
    { viz: 'stat', layout: { x: 5, y: 0, w: 1, h: 1 } },
    { viz: 'bar' },
  ];
  const layouts = lib.normalizeLayout(tiles, 6);
  assert.deepEqual(unwrap(layouts[0]), { x: 5, y: 0, w: 1, h: 1 });
  assert.deepEqual(unwrap(layouts[1]), { x: 0, y: 0, w: 2, h: 2 });
});

test('layout persists through the spec round-trip', () => {
  const spec = {
    id: 'grid', title: 'Grid', database: '07 Data/x.db',
    globalTimeframe: { preset: '90d' },
    tiles: [{
      title: 'T', sql: 'SELECT 1 AS one', viz: 'stat', x: '', y: ['one'], unit: '', stack: false,
      layout: { x: 2, y: 1, w: 2, h: 1 },
    }],
  };
  const first = lib.parseDashboardSpec(lib.specToJson(spec));
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual(unwrap(first.spec.tiles[0].layout), { x: 2, y: 1, w: 2, h: 1 });
  const second = lib.parseDashboardSpec(lib.specToJson(first.spec));
  assert.deepEqual(unwrap(second.spec.tiles[0].layout), { x: 2, y: 1, w: 2, h: 1 });
});

test('a broken layout in a hand-edited file is refused in plain words', () => {
  const spec = {
    id: 'x', title: 'X', database: 'a.db',
    tiles: [{ sql: 'SELECT 1', viz: 'stat', layout: { x: -1, y: 0, w: 0, h: 1 } }],
  };
  const r = lib.parseDashboardSpec(JSON.stringify(spec));
  assert.equal(r.ok, false);
  assert.match(r.reason, /"layout"/);
});

/* --------------------------------------------------------- the packing -- */

test('packing: the anchor stays put, an overlapped widget is pushed down', () => {
  const layouts = [
    { x: 0, y: 0, w: 2, h: 2 }, /* the anchor, just moved here */
    { x: 0, y: 0, w: 2, h: 2 }, /* sat here before */
  ];
  const packed = lib.packLayout(layouts, 6, 0);
  assert.deepEqual(unwrap(packed[0]), { x: 0, y: 0, w: 2, h: 2 }, 'the anchor must not move');
  assert.deepEqual(unwrap(packed[1]), { x: 0, y: 2, w: 2, h: 2 }, 'the other widget is pushed below');
  assert.equal(lib.rectsCollide(packed[0], packed[1]), false);
});

test('packing: everything floats up into free space', () => {
  const layouts = [
    { x: 0, y: 5, w: 2, h: 1 },
    { x: 3, y: 9, w: 1, h: 1 },
  ];
  const packed = lib.packLayout(layouts, 6, -1);
  assert.equal(packed[0].y, 0, 'nothing above, so it rises to the top');
  assert.equal(packed[1].y, 0);
});

test('packing is deterministic and never leaves an overlap, across a messy sweep', () => {
  const layouts = [
    { x: 0, y: 0, w: 3, h: 2 }, { x: 1, y: 0, w: 2, h: 2 }, { x: 2, y: 1, w: 2, h: 1 },
    { x: 0, y: 1, w: 1, h: 3 }, { x: 4, y: 0, w: 2, h: 2 }, { x: 3, y: 2, w: 3, h: 1 },
  ];
  const a = lib.packLayout(layouts, 6, 1);
  const b = lib.packLayout(layouts, 6, 1);
  assert.deepEqual(unwrap(a), unwrap(b), 'same input, same packing');
  assert.deepEqual(unwrap(a[1]), { x: 1, y: 0, w: 2, h: 2 }, 'the anchor holds');
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      assert.equal(lib.rectsCollide(a[i], a[j]), false, i + ' and ' + j + ' overlap after packing');
    }
  }
});

/* ------------------------------------------------------------ clamping -- */

test('narrow columns clamp spans and positions: a 3x2 table on a 2-column phone becomes 2 wide', () => {
  assert.deepEqual(unwrap(lib.clampLayout({ x: 3, y: 0, w: 3, h: 2 }, 2)), { x: 0, y: 0, w: 2, h: 2 });
  assert.deepEqual(unwrap(lib.clampLayout({ x: 5, y: 2, w: 1, h: 1 }, 2)), { x: 1, y: 2, w: 1, h: 1 });
  const layouts = lib.normalizeLayout([
    { viz: 'table', layout: { x: 0, y: 0, w: 3, h: 2 } },
    { viz: 'stat', layout: { x: 3, y: 0, w: 1, h: 1 } },
  ], 2);
  assert.equal(layouts[0].w, 2);
  assert.equal(layouts[1].x <= 1, true);
  assert.equal(lib.rectsCollide(layouts[0], layouts[1]), false);
});

test('the column count follows the width: phones get 2, wide panes cap at 6', () => {
  assert.equal(lib.colsForWidth(375), 2);
  assert.equal(lib.colsForWidth(760), 4);
  assert.equal(lib.colsForWidth(1100), 6);
  assert.equal(lib.colsForWidth(3000), 6);
  assert.equal(lib.colsForWidth(0), 2);
});

/* -------------------------------------------------- add-tile visibility -- */

test('the + tile shows only on an empty dashboard or in edit mode', () => {
  assert.equal(lib.showAddTile(0, false), true, 'empty dashboard, view mode: show');
  assert.equal(lib.showAddTile(0, true), true, 'empty dashboard, edit mode: show');
  assert.equal(lib.showAddTile(4, true), true, 'widgets, edit mode: show');
  assert.equal(lib.showAddTile(4, false), false, 'widgets, view mode: never');
});

test('the dashboards view obeys the visibility rule end to end', async () => {
  const { makePlugin } = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/engagement.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['n'], rows: [[1]], ms: 1 });
  const view = plugin.viewFactories['icor-sqlite-viewer-dashboards']({ app });
  view.app = app;
  await view.onOpen();
  await new Promise((r) => setTimeout(r, 30));

  const addTiles = (root) => {
    const out = [];
    const walk = (el) => { if (el.classSet && el.classSet.has('icor-sqlv-add-tile')) out.push(el); for (const c of el.children || []) walk(c); };
    walk(root);
    return out;
  };
  assert.equal(addTiles(view.contentEl).length, 0, 'view mode with widgets: no + tile');
  view.editMode = true;
  view.render();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(addTiles(view.contentEl).length, 1, 'edit mode: the + tile shows');
});

/* --------------------------------------------------- the series palette -- */

test('the palette: one series writes in ink, categories take the four lenses, the rest stay faint', () => {
  assert.deepEqual(unwrap(lib.seriesPaletteFor(1)), ['var(--sqlv-series-1)']);
  assert.deepEqual(unwrap(lib.seriesPaletteFor(2)), ['var(--sqlv-series-2)', 'var(--sqlv-series-3)']);
  assert.deepEqual(unwrap(lib.seriesPaletteFor(5)), [
    'var(--sqlv-series-2)', 'var(--sqlv-series-3)', 'var(--sqlv-series-4)', 'var(--sqlv-series-5)', 'var(--sqlv-fg-faint)',
  ]);
  assert.equal(lib.seriesPaletteFor(9).filter((c) => c === 'var(--sqlv-fg-faint)').length, 5, 'no sixth hue is ever invented');
});

test('six or more series degrade to the top four by total plus Other', () => {
  const rows = [];
  for (let s = 1; s <= 7; s++) {
    rows.push(['d1', 'series' + s, s * 10]);
    rows.push(['d2', 'series' + s, s * 10]);
  }
  const wide = lib.pivotSeries({ columns: ['x', 'series', 'value'], rows });
  assert.deepEqual(unwrap(wide.columns), ['x', 'series7', 'series6', 'series5', 'series4', 'Other'],
    'top four by total keep their lenses, the rest aggregate');
  assert.deepEqual(unwrap(wide.rows[0]), ['d1', 70, 60, 50, 40, 10 + 20 + 30], 'Other is the sum of the folded series');
  const five = lib.pivotSeries({
    columns: ['x', 'series', 'value'],
    rows: [1, 2, 3, 4, 5].map((s) => ['d1', 's' + s, s]),
  });
  assert.equal(five.columns.length, 6, 'exactly five series render as themselves');
  assert.equal(five.columns.includes('Other'), false);
});

test('the token layer is consumed, not bypassed: no blue and no raw accent in the palette', () => {
  const all = [lib.seriesPaletteFor(1), lib.seriesPaletteFor(5)].flat().join(' ');
  assert.doesNotMatch(all, /color-blue|interactive-accent/);
});

/* ------------------------------------------------------- picker search -- */

test('picker search: case-insensitive, any word, label and detail both count', () => {
  assert.equal(lib.matchesNeedle('', 'health_metric', ''), true);
  assert.equal(lib.matchesNeedle('METRIC', 'health_metric', ''), true);
  assert.equal(lib.matchesNeedle('heart rate', 'resting_heart_rate', ''), true, 'both words must match somewhere');
  assert.equal(lib.matchesNeedle('heart xyz', 'resting_heart_rate', ''), false);
  assert.equal(lib.matchesNeedle('columns', 'apple_health_daily', '18 columns'), true, 'the detail column is searchable');
});

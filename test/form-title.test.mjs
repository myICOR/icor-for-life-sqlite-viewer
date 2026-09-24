/* THE WIDGET NAME OF A BUILT WIDGET.
 *
 * The bug: editing a built widget (one with a "source", not "sql") showed
 * only the Database and Table pickers. Every field after Table (value,
 * widget name, chart type, unit ...) is drawn from the table's columns,
 * and those were only loaded when the member reopened the Table picker,
 * so a built widget could not be renamed while an SQL tile could. These
 * gates pin the fix: the form loads the chosen table's columns when it
 * opens, the name is editable and saves, the auto-name is only the
 * default until one is typed, and a table whose columns cannot be read
 * still leaves the name editable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeFakeAdapter } from './harness.mjs';

function* walkEl(el) { yield el; for (const c of el.children || []) yield* walkEl(c); }
const byLabel = (root, label) => [...walkEl(root)].find((e) => e.getAttribute && e.getAttribute('aria-label') === label);
const textOf = (root) => [...walkEl(root)].map((e) => e.textContent || '').join(' ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BUILT = {
  title: 'Average reading', viz: 'stat', unit: 'u', compare: 'none', favorable: 'up',
  source: { table: 'readings', metric: 'qty', agg: 'avg', filters: [], timeColumn: 'day', timeframe: 'global' },
};

async function makeForm(tile, { schemaFails = false } = {}) {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/x.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  plugin.schemaFor = async () => {
    if (schemaFails) throw new Error('No catalog yet.');
    return { live: true, tables: [{ name: 'readings', columns: [{ name: 'day', type: 'TEXT' }, { name: 'qty', type: 'REAL' }] }] };
  };
  plugin.query.engineFor = async () => ({ engine: 'cli', size: 1 });
  plugin.query.query = async () => ({ columns: ['value'], rows: [[7]], ms: 1 });
  const spec = { id: 'd', title: 'D', database: '07 Data/x.db', globalTimeframe: { preset: '90d' }, tiles: tile ? [JSON.parse(JSON.stringify(tile))] : [], path: 'd.json' };
  const view = { saveAndRender: async (s) => { view.saved = s; } };
  const form = new fresh.PluginClass.modals.WidgetFormModal(plugin, view, spec, tile ? 0 : -1);
  return { form, spec, lib: fresh.lib };
}

test('THE BUG: editing a built widget shows its name field, filled with its name', async () => {
  const { form } = await makeForm(BUILT);
  form.open();
  await wait(20);
  const name = byLabel(form.formEl, 'Widget name');
  assert.ok(name, 'the Widget name field is there without reopening the Table picker');
  assert.equal(name.value, 'Average reading');
  assert.ok(byLabel(form.formEl, 'Chart type'), 'and so is the rest of the form');
});

test('a built widget is renamed and saved like any other, and the name survives the file', async () => {
  const { form, spec, lib } = await makeForm(BUILT);
  form.open();
  await wait(20);
  const name = byLabel(form.formEl, 'Widget name');
  name.value = 'Glucose, 7 days';
  name.handlers.input[0]();
  await wait(500);
  assert.equal(form.previewState, 'ok');
  await form.save();
  assert.equal(spec.tiles[0].title, 'Glucose, 7 days');
  assert.ok(spec.tiles[0].source, 'still a built widget');
  const reparsed = lib.parseDashboardSpec(lib.specToJson(spec));
  assert.equal(reparsed.ok, true, reparsed.reason);
  assert.equal(reparsed.spec.tiles[0].title, 'Glucose, 7 days');
});

test('the auto-name is only the default: it fills in while no name is typed, and a typed name stays', async () => {
  const { form } = await makeForm(null);
  form.open();
  Object.assign(form.state, { database: '07 Data/x.db', table: 'readings', metric: 'qty', agg: 'avg', viz: 'stat', timeColumn: 'day' });
  assert.equal(form.buildTile().tile.title, 'qty', 'no name typed: the suggestion');
  form.state.metric = 'day';
  assert.equal(form.buildTile().tile.title, 'day', 'the suggestion follows the value');
  form.state.title = 'My name';
  form.state.metric = 'qty';
  assert.equal(form.buildTile().tile.title, 'My name', 'a typed name is never overwritten');
});

test('when the table cannot be read here, the name stays editable and the form says why', async () => {
  const { form } = await makeForm(BUILT, { schemaFails: true });
  form.open();
  await wait(20);
  const name = byLabel(form.formEl, 'Widget name');
  assert.ok(name, 'the name can still be changed');
  assert.equal(name.value, 'Average reading');
  assert.match(textOf(form.formEl), /cannot be read here: No catalog yet\./);
  name.value = 'Renamed';
  name.handlers.input[0]();
  assert.equal(form.buildTile().tile.title, 'Renamed');
});

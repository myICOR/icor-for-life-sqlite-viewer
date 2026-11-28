/* THE FOLDER ADOPTION.
 *
 * 0.5.0 renames the default home from "07 Data" to "07 Databases". The
 * back-compat rule: when the configured data folder does not exist but
 * the legacy one does, the legacy trio is adopted for the session,
 * silently; a configured folder that exists always wins; nothing is ever
 * created just because it is the default. Measured pure (the rule) and
 * through the plugin (the wiring), in both directions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib, makePlugin } = loadPlugin();
const D = lib.DEFAULT_SETTINGS;

function settings(overrides) {
  return Object.assign({}, D, overrides);
}

test('default config, legacy vault: the legacy trio is adopted', () => {
  const adopted = lib.adoptLegacyFolders(settings({}), { '07 Databases': false, '07 Data': true });
  assert.deepEqual(unwrap(adopted), {
    dataFolder: '07 Data',
    dashboardFolder: '07 Data/Dashboards',
    cacheFolder: '07 Data/Dashboard Cache',
  });
});

test('default config, new vault: nothing is adopted', () => {
  assert.equal(lib.adoptLegacyFolders(settings({}), { '11 Databases': true, '05 Databases': true, '07 Databases': true, '07 Data': true }),
    null, 'the configured folder exists, so it wins even with the legacy folders present');
  assert.equal(lib.adoptLegacyFolders(settings({}), { '05 Databases': false, '07 Databases': false, '07 Data': false }),
    null, 'neither exists: keep the default, create nothing');
});

test('an explicit folder that exists always wins', () => {
  const s = settings({ dataFolder: 'My Data', dashboardFolder: 'My Data/Dash', cacheFolder: 'My Data/Cache' });
  assert.equal(lib.adoptLegacyFolders(s, { 'My Data': true, '07 Data': true }), null);
});

test('an explicit missing folder falls back to legacy for the data folder, but custom sub-folders are kept', () => {
  const s = settings({ dataFolder: 'Gone', dashboardFolder: 'Custom/Dash' });
  const adopted = lib.adoptLegacyFolders(s, { Gone: false, '07 Data': true });
  assert.equal(adopted.dataFolder, '07 Data');
  assert.equal(adopted.dashboardFolder, undefined, 'the customized dashboard folder is not touched');
  assert.equal(adopted.cacheFolder, '07 Data/Dashboard Cache', 'the default cache folder follows');
});

test('a vault already configured on 07 Data stays put without a loop', () => {
  const s = settings({ dataFolder: '07 Data', dashboardFolder: '07 Data/Dashboards', cacheFolder: '07 Data/Dashboard Cache' });
  assert.equal(lib.adoptLegacyFolders(s, { '07 Data': true }), null);
});

/* ------------------------------------------------- through the plugin -- */

async function bootPlugin(adapter) {
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  return plugin;
}

test('a legacy vault boots onto 07 Data and seeds its starters there', async () => {
  const fresh = loadPlugin();
  const adapter = makeFakeAdapter({}, { '07 Data/engagement.db': new Uint8Array([1]) });
  const app = { vault: { adapter, getFiles: () => [] }, workspace: { onLayoutReady: () => {}, on: () => ({}) } };
  const plugin = fresh.makePlugin(app);
  plugin.app = app;
  await plugin.onload();
  assert.equal(plugin.settings.dataFolder, '07 Data');
  assert.equal(plugin.settings.dashboardFolder, '07 Data/Dashboards');
  assert.equal(plugin.settings.cacheFolder, '07 Data/Dashboard Cache');
  await plugin.ensureStarterFiles();
  assert.equal(adapter.files.has('07 Data/Dashboards/engagement-overview.json'), true);
  assert.equal(adapter.files.has('07 Databases/Dashboards/engagement-overview.json'), false);
  /* Silent: the adoption is not persisted as if the member had set it. */
  assert.equal(plugin.saved, null, 'no settings write happened on load');
});

test('a new vault with 07 Databases boots onto it, and starters follow the folder', async () => {
  const adapter = makeFakeAdapter({}, { '07 Databases/engagement.db': new Uint8Array([1]) });
  const plugin = await bootPlugin(adapter);
  assert.equal(plugin.settings.dataFolder, '07 Databases');
  await plugin.ensureStarterFiles();
  assert.equal(adapter.files.has('07 Databases/Dashboards/engagement-overview.json'), true);
  const spec = JSON.parse(adapter.files.get('07 Databases/Dashboards/engagement-overview.json'));
  assert.equal(spec.database, '07 Databases/engagement.db', 'the starter points at the actual database');
  const readme = adapter.files.get('07 Databases/Dashboards/README.md');
  assert.match(readme, /07 Databases/);
  assert.doesNotMatch(readme, /07 Data\//, 'the folder README names the real home');
});

test('an empty vault boots onto the default and creates nothing', async () => {
  const adapter = makeFakeAdapter();
  const plugin = await bootPlugin(adapter);
  assert.equal(plugin.settings.dataFolder, '11 Databases');
  assert.equal(adapter.log.length, 0, 'loading never writes or creates folders');
});

/* The Workbench layout of ICOR for Life 3.0 (2026-11-28): the databases live in 11 Databases. A vault from before keeps
   05 Databases (early 3.0), 07 Databases (2.x) or 07 Data for the session, the same quiet adoption; a saved old default
   follows to 11 Databases once the vault has it. */
test('the Workbench layout: the default home is 11 Databases', () => {
  const s = settings({});
  assert.equal(s.dataFolder, '11 Databases');
  assert.equal(s.dashboardFolder, '11 Databases/Dashboards');
  assert.equal(s.cacheFolder, '11 Databases/Dashboard Cache');
});

test('the Workbench layout: a vault that still has 05 Databases keeps it, then 07 Databases, then 07 Data', () => {
  const none = { '11 Databases': false };
  assert.equal(JSON.stringify(lib.adoptLegacyFolders(settings({}), { ...none, '05 Databases': true, '07 Databases': true, '07 Data': true })),
    JSON.stringify({ dataFolder: '05 Databases', dashboardFolder: '05 Databases/Dashboards', cacheFolder: '05 Databases/Dashboard Cache' }));
  assert.equal(lib.adoptLegacyFolders(settings({}), { ...none, '05 Databases': false, '07 Databases': true, '07 Data': true }).dataFolder, '07 Databases');
  assert.equal(lib.adoptLegacyFolders(settings({}), { ...none, '05 Databases': false, '07 Databases': false, '07 Data': true }).dataFolder, '07 Data');
  assert.equal(lib.adoptLegacyFolders(settings({}), { '11 Databases': true, '05 Databases': true }), null);
});

test('the Workbench layout: a saved old default follows to 11 Databases once the vault has moved, and not before', () => {
  const old = settings({ dataFolder: '05 Databases', dashboardFolder: '05 Databases/Dashboards', cacheFolder: '05 Databases/Dashboard Cache' });
  assert.equal(JSON.stringify(lib.adoptLegacyFolders(old, { '05 Databases': false, '11 Databases': true })),
    JSON.stringify({ dataFolder: '11 Databases', dashboardFolder: '11 Databases/Dashboards', cacheFolder: '11 Databases/Dashboard Cache' }));
  assert.equal(lib.adoptLegacyFolders(old, { '05 Databases': true, '11 Databases': true }), null, 'still there: kept');
  assert.equal(lib.adoptLegacyFolders(old, { '05 Databases': false, '11 Databases': false }), null, 'nowhere to go yet');
  const custom = settings({ dataFolder: '05 Databases', dashboardFolder: 'Boards', cacheFolder: '05 Databases/Dashboard Cache' });
  const f = lib.adoptLegacyFolders(custom, { '11 Databases': true });
  assert.equal(f.dashboardFolder, undefined, 'a dashboard folder the member chose stays');
  assert.equal(f.cacheFolder, '11 Databases/Dashboard Cache');
});

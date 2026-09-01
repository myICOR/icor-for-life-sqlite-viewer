/* THE MIGRATION.
 *
 * "Move databases into 07 Data" is the one feature that changes the vault,
 * so its two halves are gated separately: the pure plan (who moves, who
 * stays, what travels along) and the execution against an injected adapter
 * (rename only, never overwrite, sidecars after their database). The
 * never-overwrite rule is measured twice, once in the plan and once at
 * execution, because the file system can change between the modal and the
 * click.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, unwrap, makeFakeAdapter } from './harness.mjs';

const { lib } = loadPlugin();

test('the plan: outsiders move to the top of 07 Data, insiders stay, sidecars travel', () => {
  const existing = new Set([
    'old/place/tracker.db',
    'old/place/tracker.db-wal',
    'old/place/tracker.db-shm',
    '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db',
    '07 Data/engagement.db',
  ]);
  const plan = lib.planMigration(
    ['old/place/tracker.db', '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db', '07 Data/engagement.db'],
    existing,
    '07 Data'
  );
  assert.deepEqual(unwrap(plan.moves), [
    {
      from: 'old/place/tracker.db',
      to: '07 Data/tracker.db',
      sidecars: [
        { from: 'old/place/tracker.db-wal', to: '07 Data/tracker.db-wal' },
        { from: 'old/place/tracker.db-shm', to: '07 Data/tracker.db-shm' },
      ],
    },
    { from: '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db', to: '07 Data/youtube-analytics.db', sidecars: [] },
  ]);
  assert.deepEqual(unwrap(plan.skips), [{ path: '07 Data/engagement.db', reason: 'already inside 07 Data' }]);
});

test('the plan never overwrites: a taken name is a skip, and two sources with one name move once', () => {
  const existing = new Set(['a/dup.db', 'b/dup.db', '07 Data/engagement.db', 'c/engagement.db']);
  const plan = lib.planMigration(['a/dup.db', 'b/dup.db', 'c/engagement.db'], existing, '07 Data');
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].from, 'a/dup.db');
  assert.equal(plan.skips.length, 2);
  assert.match(plan.skips[0].reason, /already exists/);
  assert.match(plan.skips[1].reason, /already exists/);
});

test('execution: renames only, creates the folder, moves sidecars with their database', async () => {
  const adapter = makeFakeAdapter({
    'old/tracker.db': 'DBBYTES',
    'old/tracker.db-wal': 'WAL',
    'old/tracker.db-shm': 'SHM',
  });
  const plan = lib.planMigration(['old/tracker.db'], new Set(adapter.files.keys()), '07 Data');
  const results = await lib.executeMigration(adapter, plan);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(adapter.files.get('07 Data/tracker.db'), 'DBBYTES');
  assert.equal(adapter.files.get('07 Data/tracker.db-wal'), 'WAL');
  assert.equal(adapter.files.get('07 Data/tracker.db-shm'), 'SHM');
  assert.equal(adapter.files.has('old/tracker.db'), false);
  const ops = adapter.log.map((l) => l[0]);
  assert.equal(ops.includes('write'), false, 'a migration writes nothing, it only renames');
});

test('execution: a target that appeared since the plan is skipped with a reason, not overwritten', async () => {
  const adapter = makeFakeAdapter({ 'old/x.db': 'ORIGINAL' });
  const plan = lib.planMigration(['old/x.db'], new Set(adapter.files.keys()), '07 Data');
  /* The race: someone puts a file at the target between plan and click. */
  adapter.files.set('07 Data/x.db', 'SOMEONE ELSE');
  const results = await lib.executeMigration(adapter, plan);
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /already exists/);
  assert.equal(adapter.files.get('07 Data/x.db'), 'SOMEONE ELSE', 'the existing file is untouched');
  assert.equal(adapter.files.get('old/x.db'), 'ORIGINAL', 'the source stays where it was');
});

test('execution: a source that vanished is reported, the rest still moves', async () => {
  const adapter = makeFakeAdapter({ 'b/second.db': 'B' });
  const plan = lib.planMigration(['a/first.db', 'b/second.db'],
    new Set(['a/first.db', ...adapter.files.keys()]), '07 Data');
  adapter.files.delete('a/first.db');
  const results = await lib.executeMigration(adapter, plan);
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /gone/);
  assert.equal(results[1].ok, true);
  assert.equal(adapter.files.get('07 Data/second.db'), 'B');
});

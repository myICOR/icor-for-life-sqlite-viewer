/* THE STATEMENT GATE.
 *
 * The whole read-only promise funnels through gateStatement, so this file
 * measures it in both directions: everything a member may run passes,
 * everything that could write, attach or smuggle a second statement is
 * refused, including the disguises (ATTACH in different case, a write verb
 * after a semicolon, keywords hidden in strings and comments that must NOT
 * trip the gate). The row cap is measured here too, because it edits the
 * SQL and an edit that broke a query would be a write of a different kind.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin } from './harness.mjs';

const { lib } = loadPlugin();

test('read statements pass: SELECT, WITH, PRAGMA, EXPLAIN, any case, leading noise allowed', () => {
  assert.equal(lib.gateStatement('SELECT 1').ok, true);
  assert.equal(lib.gateStatement('  select * from t').ok, true);
  assert.equal(lib.gateStatement('WITH a AS (SELECT 1) SELECT * FROM a').ok, true);
  assert.equal(lib.gateStatement('pragma table_info("health_metric")').ok, true);
  assert.equal(lib.gateStatement('EXPLAIN QUERY PLAN SELECT 1').ok, true);
  assert.equal(lib.gateStatement('-- a comment first\nSELECT 1').ok, true);
  assert.equal(lib.gateStatement('/* block */ SELECT 1').ok, true);
  assert.equal(lib.gateStatement('SELECT 1;').ok, true, 'one trailing semicolon is fine');
  assert.equal(lib.gateStatement('SELECT 1; \n  ').ok, true, 'trailing whitespace after the semicolon is fine');
});

test('write verbs are refused, with the reason in plain words', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'CREATE TABLE t (a)',
    'ALTER TABLE t ADD COLUMN b',
    'REPLACE INTO t VALUES (1)',
    'VACUUM',
    'begin transaction',
  ]) {
    const r = lib.gateStatement(sql);
    assert.equal(r.ok, false, sql + ' must be refused');
    assert.match(r.reason, /SELECT, WITH, PRAGMA or EXPLAIN/);
  }
});

test('a second statement is refused, even a read after a read', () => {
  const r = lib.gateStatement('SELECT 1; SELECT 2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /One statement at a time/);
  assert.equal(lib.gateStatement('SELECT 1; DROP TABLE t').ok, false);
  assert.equal(lib.gateStatement('PRAGMA user_version; VACUUM').ok, false);
});

test('ATTACH and DETACH are refused wherever they appear', () => {
  assert.equal(lib.gateStatement("ATTACH DATABASE 'x.db' AS other").ok, false);
  assert.equal(lib.gateStatement('attach database :m as m').ok, false);
  assert.equal(lib.gateStatement('DETACH other').ok, false);
  assert.equal(lib.gateStatement('SELECT 1 attach').ok, false,
    'the word attach anywhere outside a string or comment refuses, even where it is not valid SQL');
  assert.equal(lib.gateStatement('SELECT 1 -- attach\n').ok, true,
    'attach in a comment is a comment, not a command; the gate reads the statement, not the notes');
});

test('keywords inside string literals do NOT trip the gate, and strings hide semicolons', () => {
  assert.equal(lib.gateStatement("SELECT 'attach; drop table t' AS label").ok, true,
    'a string is data, not a statement');
  assert.equal(lib.gateStatement("SELECT * FROM t WHERE note = 'a;b;c'").ok, true);
  assert.equal(lib.gateStatement('SELECT "attach" FROM t').ok, true,
    'a quoted identifier named attach is a column, not a command');
  assert.equal(lib.gateStatement("SELECT 'it''s fine; really' AS x").ok, true,
    'escaped quotes inside the string are handled');
});

test('an unclosed quote or comment is refused in plain words', () => {
  const r = lib.gateStatement("SELECT 'oops");
  assert.equal(r.ok, false);
  assert.match(r.reason, /never closes/);
  assert.equal(lib.gateStatement('SELECT 1 /* forever').ok, false);
});

test('the empty and the blank query are refused', () => {
  assert.equal(lib.gateStatement('').ok, false);
  assert.equal(lib.gateStatement('   \n  ').ok, false);
  assert.equal(lib.gateStatement('-- only a comment').ok, false);
});

test('row cap: an uncapped SELECT gets a LIMIT, a capped one is left alone', () => {
  const r = lib.applyRowCap('SELECT * FROM health_metric', 500);
  assert.equal(r.capped, true);
  assert.match(r.sql, /LIMIT 500$/);
  const already = lib.applyRowCap('SELECT * FROM t LIMIT 10', 500);
  assert.equal(already.capped, false);
  assert.equal(already.sql, 'SELECT * FROM t LIMIT 10');
});

test('row cap: a trailing semicolon is removed before the LIMIT lands', () => {
  const r = lib.applyRowCap('SELECT * FROM t;', 50);
  assert.equal(r.sql, 'SELECT * FROM t LIMIT 50');
});

test('row cap: PRAGMA and EXPLAIN are never edited, and LIMIT in a string does not count as a LIMIT', () => {
  assert.equal(lib.applyRowCap('PRAGMA table_info(t)', 500).capped, false);
  assert.equal(lib.applyRowCap('EXPLAIN SELECT * FROM t', 500).capped, false);
  const hidden = lib.applyRowCap("SELECT 'no limit here' FROM t", 500);
  assert.equal(hidden.capped, true, "the word limit inside a string is data; the query still gets a real LIMIT");
});

test('browse queries: identifiers are quoted, filters become escaped LIKEs, paging is explicit', () => {
  const sql = lib.buildBrowseQuery('health_metric', {
    filters: { metric_name: 'step_count', source: "o'brien" },
    sortCol: 'local_date', sortDir: 'desc', limit: 50, offset: 100,
  });
  assert.match(sql, /^SELECT \* FROM "health_metric" WHERE /);
  assert.match(sql, /CAST\("metric_name" AS TEXT\) LIKE '%step\\_count%' ESCAPE '\\'/,
    'the underscore the member typed matches literally, so it is escaped');
  assert.match(sql, /'%o''brien%'/, "a single quote in a filter is doubled, never breaks out");
  assert.match(sql, /ORDER BY "local_date" DESC LIMIT 50 OFFSET 100$/);
  assert.equal(lib.gateStatement(sql).ok, true, 'what the browser builds passes its own gate');
});

test('browse queries: % and _ typed by the member match literally', () => {
  const sql = lib.buildBrowseQuery('t', { filters: { a: '50%' }, limit: 10, offset: 0 });
  assert.match(sql, /LIKE '%50\\%%' ESCAPE '\\'/);
});

test('a table or column named with a double quote cannot break out of its identifier', () => {
  const sql = lib.buildBrowseQuery('we"ird', { limit: 10, offset: 0 });
  assert.match(sql, /FROM "we""ird"/);
  assert.equal(lib.gateStatement(sql).ok, true);
});

test('count queries share the filter clause', () => {
  const sql = lib.buildCountQuery('t', { filters: { a: 'x' } });
  assert.equal(sql, 'SELECT COUNT(*) AS n FROM "t" WHERE CAST("a" AS TEXT) LIKE \'%x%\' ESCAPE \'\\\'');
});

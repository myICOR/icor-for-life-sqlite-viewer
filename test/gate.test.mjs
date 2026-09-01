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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

/* -------------------------------------------- the 0.5.1 hardening (M1) -- */

test("Vex's probes: a WITH clause cannot lead into a write", () => {
  for (const sql of [
    'WITH x AS (SELECT 1) DELETE FROM members',
    'WITH x AS (SELECT 1) INSERT INTO members VALUES (1)',
    "WITH x AS (SELECT 1) UPDATE members SET name='z'",
    'WITH x AS (SELECT 1) REPLACE INTO members VALUES (1)',
    'WITH x AS (SELECT 1) CREATE TABLE y (a)',
    'with recursive r as (select 1) drop table members',
    'EXPLAIN DELETE FROM t',
    'SELECT 1 UNION SELECT 2; VACUUM',
  ]) {
    const r = lib.gateStatement(sql);
    assert.equal(r.ok, false, sql + ' must be refused');
  }
});

test("Vex's probes: write PRAGMAs and every assignment form are refused", () => {
  for (const sql of [
    'PRAGMA journal_mode = DELETE',
    'PRAGMA user_version = 999',
    'PRAGMA writable_schema = ON',
    'pragma synchronous = off',
    'PRAGMA secure_delete = 1',
    'PRAGMA case_sensitive_like = 1',
    'PRAGMA journal_mode',
  ]) {
    const r = lib.gateStatement(sql);
    assert.equal(r.ok, false, sql + ' must be refused');
  }
  assert.match(lib.gateStatement('PRAGMA writable_schema = ON').reason, /PRAGMA/,
    'a refused PRAGMA names itself in the reason');
});

test('the read-only PRAGMAs still pass: introspection is the whole point', () => {
  for (const sql of [
    'PRAGMA table_info("health_metric")',
    'PRAGMA table_info(health_metric)',
    'PRAGMA index_list("t")',
    'PRAGMA index_info("idx")',
    'PRAGMA foreign_key_list("t")',
    'PRAGMA database_list',
    'PRAGMA user_version',
    'PRAGMA integrity_check',
    'PRAGMA page_count',
  ]) {
    assert.equal(lib.gateStatement(sql).ok, true, sql + ' must pass');
  }
});

/* ------------------------------------------- the 0.5.2 tightening (L5) -- */

test("Vex's L5 probes: the paren set form of a scalar PRAGMA is refused", () => {
  for (const sql of [
    'PRAGMA user_version(7)',
    'PRAGMA application_id(1)',
    'PRAGMA page_size(4096)',
    'PRAGMA max_page_count(100)',
    'PRAGMA journal_size_limit(1000)',
    'pragma user_version (7)',
    'PRAGMA schema_version(9)',
    'PRAGMA encoding("UTF-16")',
    'PRAGMA table_info = 1',
  ]) {
    const r = lib.gateStatement(sql);
    assert.equal(r.ok, false, sql + ' must be refused');
  }
  assert.match(lib.gateStatement('PRAGMA user_version(7)').reason, /PRAGMA/,
    'the refusal names PRAGMA in plain words');
});

test('the introspection parens and the bare scalar reads still pass', () => {
  for (const sql of [
    "PRAGMA table_info('t')",
    'PRAGMA table_xinfo(t)',
    'PRAGMA table_list(members)',
    'PRAGMA index_list("t")',
    'PRAGMA index_info("idx")',
    'PRAGMA index_xinfo("idx")',
    'PRAGMA foreign_key_list("t")',
    'PRAGMA integrity_check(10)',
    'PRAGMA quick_check(5)',
    'PRAGMA user_version',
    'PRAGMA application_id',
    'PRAGMA page_size',
  ]) {
    assert.equal(lib.gateStatement(sql).ok, true, sql + ' must pass');
  }
});

test('mutation run: with the value check stripped the paren set slips through, so the check owns its gate', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(resolve(repo, 'main.js'), 'utf8');
  const guard = "if (m && m[2] && (m[2] === '=' || !READ_PRAGMA_FUNCS.has(name))) {";
  assert.ok(source.includes(guard), 'the guard this mutation strips must exist in main.js');
  const mutated = source.replace(guard, 'if (false) {');
  const mutant = loadPlugin({ sourceOverride: mutated }).lib;
  assert.equal(mutant.gateStatement('PRAGMA user_version(7)').ok, true,
    'the mutant must allow the paren set, or the real refusal is not owned by this check');
  assert.equal(mutant.gateStatement('PRAGMA user_version = 999').ok, true,
    'the mutant must allow the = set too: both refusals live in the one guard');
  assert.equal(lib.gateStatement('PRAGMA user_version(7)').ok, false,
    'and the real gate refuses what the mutant allowed');
});

test('write verbs inside names and strings do not trip the hardened gate', () => {
  for (const sql of [
    'SELECT created_at, updated_at FROM t',
    'SELECT * FROM analyze_log WHERE inserted = 1',
    "SELECT 'please delete me' AS note FROM t",
    'SELECT "delete" FROM t',
    'SELECT vacuum_hours, replacement FROM maintenance',
    "SELECT * FROM pragma_table_info('t')",
  ]) {
    assert.equal(lib.gateStatement(sql).ok, true, sql + ' must pass');
  }
});

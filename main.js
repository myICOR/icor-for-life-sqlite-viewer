/* ICOR for Life - SQLite Viewer
 *
 * Open, browse and chart the SQLite databases that live inside the vault,
 * read-only, on every device.
 *
 * The shape, in one paragraph. A vault can carry real databases next to its
 * notes: an Apple Health archive of fifteen million rows, an engagement log,
 * an analytics snapshot store. This plugin opens them where they are. Click
 * a `.db` file and a browser opens: tables with row counts, the schema, the
 * data page by page, and a console for your own read-only SQL. Dashboards
 * are small JSON files in the vault; the plugin runs their queries and draws
 * the charts itself, in the vault's own colors. Nothing is ever written to
 * a database, by design and by a tested gate.
 *
 * THE ONE RULE: read, never write. Enforced twice. Every database is opened
 * read-only (the `-readonly` flag plus a `mode=ro` file URI on the desktop,
 * an in-memory copy on mobile), and every statement passes a gate first:
 * exactly one statement, starting with SELECT, WITH, PRAGMA or EXPLAIN,
 * with ATTACH refused outright. The gate lives in the pure library and is
 * measured in test/gate.test.mjs.
 *
 * Two engines, chosen per database:
 *
 *   ENGINE A (desktop): the system `sqlite3` command line tool, one process
 *   per query, results as JSON. This is how a 6 GB database answers in
 *   milliseconds: the file is never loaded, the indexes do the work. The
 *   SQL travels as an argument to execFile, never through a shell.
 *
 *   ENGINE B (mobile, and desktop fallback): sql.js, a WebAssembly build of
 *   SQLite vendored into the plugin folder. It loads the whole file into
 *   memory, so a size cap (default 200 MB) guards it, with a plain
 *   explanation when a database is over the cap.
 *
 * Databases over the cap still reach the phone through the DASHBOARD CACHE:
 * when a dashboard renders on the desktop, its query results are written as
 * JSON into the vault, Obsidian Sync carries them, and the phone renders
 * the same dashboard from the cache with a visible "computed on desktop"
 * line. The big file itself never travels.
 *
 * Three layers, top to bottom of this file:
 *
 *   1. A pure library: the statement gate, the row cap, query building for
 *      the browser, CSV export, dashboard spec parsing, migration planning,
 *      chart scales. No Obsidian, no fs. Exposed as
 *      `IcorSqliteViewerPlugin.lib` for the gates.
 *   2. The engines: the sqlite3 process runner and the sql.js loader. Every
 *      child_process and path handle arrives through a `deps` object built
 *      inside a function behind `Platform.isDesktopApp`, so the module
 *      loads clean on a phone and the gates can hand in a fake process
 *      runner and watch the arguments.
 *   3. The Obsidian surface: the database browser view, the dashboards
 *      view, the database index, the settings tab and the migration modal.
 *
 * Hand-written CommonJS, no build step, no runtime npm dependencies. The
 * one vendored exception is sql.js (sql-wasm.js + sql-wasm.wasm, pinned
 * 1.13.0, MIT, see THIRD-PARTY-NOTICES.md). Plain words in every string the
 * member reads.
 */

'use strict';

const {
  Plugin, PluginSettingTab, Setting, Modal, Notice, Platform, setIcon,
  ItemView, FileView, TFile, TFolder, normalizePath,
} = require('obsidian');

/* ------------------------------------------------------------ constants -- */

const MB = 1024 * 1024;
const DB_EXTS = new Set(['db', 'sqlite', 'sqlite3']);
const SIDECAR_RE = /\.(db|sqlite|sqlite3)-(wal|shm)$/i;
const SKIP_FOLDERS = new Set(['.obsidian', '.git', '.trash']);
const ALLOWED_KEYWORDS = new Set(['select', 'with', 'pragma', 'explain']);
/* Statement verbs that write. Refused anywhere they appear as words in a
 * stripped statement, because a WITH prefix can lead into any of them. */
const WRITE_VERBS_RE = /\b(insert|update|delete|replace|create|drop|alter|reindex|vacuum|analyze)\b/i;
/* The read-only PRAGMA allowlist (introspection only). Everything else,
 * and every assignment form, is refused. */
const READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo',
  'foreign_key_list', 'database_list', 'collation_list', 'function_list', 'pragma_list',
  'compile_options', 'freelist_count', 'page_count', 'page_size', 'max_page_count',
  'schema_version', 'user_version', 'data_version', 'application_id',
  'integrity_check', 'quick_check', 'encoding', 'journal_size_limit',
]);
/* The introspection PRAGMAs that genuinely take a parenthesized argument,
 * a table or index name or a row cap, never a value being set. For every
 * other allowlisted name SQLite reads "PRAGMA name(value)" as a set, the
 * same write as "PRAGMA name = value", so the paren form is refused. */
const READ_PRAGMA_FUNCS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo',
  'foreign_key_list', 'integrity_check', 'quick_check',
]);
const VIZ_KINDS = new Set(['line', 'bar', 'stat', 'table']);
const VIEW_BROWSER = 'icor-sqlite-viewer-browser';
const VIEW_DASHBOARDS = 'icor-sqlite-viewer-dashboards';
const VIEW_JSON = 'icor-sqlite-viewer-json';
/* A JSON file bigger than this is shown in part, never fully rendered. */
const JSON_RENDER_CAP = 2 * MB;
const JSON_SLICE = 200 * 1024;
const CLI_MAX_BUFFER = 64 * MB;
/* Chart series colors per the INKLINE spec (Iris, 2026-09-01): a single
 * series is the ink writing (paper-dim); two or more take the four
 * category lenses; anything past the lenses renders faint. styles.css
 * maps each token to the theme with an Obsidian fallback. */
const SERIES_TOKEN_SINGLE = 'var(--sqlv-series-1)';
const SERIES_TOKEN_LENSES = [
  'var(--sqlv-series-2)', 'var(--sqlv-series-3)',
  'var(--sqlv-series-4)', 'var(--sqlv-series-5)',
];
const SERIES_TOKEN_FAINT = 'var(--sqlv-fg-faint)';
/* At most this many series render; past it the rest aggregate as Other. */
const SERIES_CEILING = 5;

/* The stroke and fill for series i of n. Pure, so the rule is testable:
 * one series writes in ink, lenses carry categories, the fifth entry and
 * the Other bucket stay faint, and no sixth hue is ever invented. */
function seriesPaletteFor(count) {
  if (count <= 0) return [];
  if (count === 1) return [SERIES_TOKEN_SINGLE];
  const out = [];
  for (let i = 0; i < count; i++) out.push(i < SERIES_TOKEN_LENSES.length ? SERIES_TOKEN_LENSES[i] : SERIES_TOKEN_FAINT);
  return out;
}

/* ------------------------------------------------------ the grid rules -- */

/* The dashboard grid: square-ish cells, cell count derived from width. A
 * widget occupies w x h cells; its place is {x, y, w, h} in the spec. */
const GRID_MIN_COLS = 2;
const GRID_MAX_COLS = 6;
const GRID_UNIT_PX = 170;
const GRID_GAP_PX = 12;
const SPAN_CAP = 12;

/* Vaults from before 0.5.0 keep their "07 Data" home: when the configured
 * data folder does not exist but the legacy one does, the legacy folder is
 * adopted for this session, silently. A folder the member configured and
 * actually has always wins, and nothing is ever created just because it
 * is the default. Pure: existence arrives as a map. */
const LEGACY_DATA_FOLDER = '07 Data';

function adoptLegacyFolders(settings, existsMap) {
  if (existsMap[settings.dataFolder]) return null;
  if (settings.dataFolder === LEGACY_DATA_FOLDER) return null;
  if (!existsMap[LEGACY_DATA_FOLDER]) return null;
  const adopted = { dataFolder: LEGACY_DATA_FOLDER };
  if (settings.dashboardFolder === DEFAULT_SETTINGS.dashboardFolder) {
    adopted.dashboardFolder = LEGACY_DATA_FOLDER + '/Dashboards';
  }
  if (settings.cacheFolder === DEFAULT_SETTINGS.cacheFolder) {
    adopted.cacheFolder = LEGACY_DATA_FOLDER + '/Dashboard Cache';
  }
  return adopted;
}

const DEFAULT_SETTINGS = {
  pageSize: 50,
  rowCap: 500,
  queryTimeoutSec: 30,
  mobileCapMb: 200,
  dashboardFolder: '07 Databases/Dashboards',
  cacheFolder: '07 Databases/Dashboard Cache',
  dataFolder: '07 Databases',
  sqlite3Path: '',
  /* The mobile catalog carries structure only unless this is on. */
  catalogIncludeValues: false,
  /* The plugin claims .json files for its reader and the dashboards. */
  openJsonFiles: true,
};

/* ========================================================================
 * 1. THE PURE LIBRARY
 * ====================================================================== */

function extOf(path) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : '';
}

function baseName(path) { return path.split('/').pop(); }

function stemOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function formatBytes(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  return s + ' ' + units[i];
}

function formatNumber(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  const rounded = Math.round(v * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* "computed on desktop, 3 hours ago" - the honest line under a cached tile. */
function relativeTime(iso, nowMs) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'at an unknown time';
  const s = Math.max(0, Math.floor(((nowMs === undefined ? Date.now() : nowMs) - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : m + ' minutes ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : h + ' hours ago';
  const d = Math.floor(h / 24);
  if (d < 31) return d === 1 ? '1 day ago' : d + ' days ago';
  return 'on ' + iso.slice(0, 10);
}

/* --------------------------------------------------- the statement gate -- */

/* Blank out comments and the contents of every string and quoted identifier,
 * keeping the length, so the gate can look for keywords and semicolons
 * without being fooled by 'attach' inside a string. Handles 'text' with ''
 * escapes, "identifiers", `identifiers`, [identifiers], -- comments and
 * block comments. Returns null when a quote never closes. */
function stripSqlNoise(sql) {
  const src = String(sql);
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (src[j] === c) {
          if (src[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += c + ' '.repeat(j - i - 1) + c;
      i = j + 1;
    } else if (c === '[') {
      const j = src.indexOf(']', i + 1);
      if (j < 0) return null;
      out += '[' + ' '.repeat(j - i - 1) + ']';
      i = j + 1;
    } else if (c === '-' && src[i + 1] === '-') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += ' '.repeat(j - i);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) return null;
      out += ' '.repeat(j + 2 - i);
      i = j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function firstKeywordOf(stripped) {
  const m = /^\s*([a-zA-Z_]+)/.exec(stripped);
  return m ? m[1].toLowerCase() : '';
}

/* The gate every statement passes before any engine sees it. Exactly one
 * statement, read-only verbs only, no ATTACH. Returns { ok: true } or
 * { ok: false, reason } with the reason in plain words. */
function gateStatement(sql) {
  if (!sql || !String(sql).trim()) {
    return { ok: false, reason: 'The query is empty.' };
  }
  const stripped = stripSqlNoise(sql);
  if (stripped === null) {
    return { ok: false, reason: 'A quote or comment never closes. Check the query for an unmatched \' or /*.' };
  }
  if (!stripped.trim()) {
    return { ok: false, reason: 'The query is empty.' };
  }
  const semi = stripped.indexOf(';');
  if (semi >= 0 && stripped.slice(semi + 1).trim() !== '') {
    return { ok: false, reason: 'One statement at a time. Remove everything after the first semicolon.' };
  }
  const kw = firstKeywordOf(stripped);
  if (!ALLOWED_KEYWORDS.has(kw)) {
    return { ok: false, reason: 'Only read queries run here. Start with SELECT, WITH, PRAGMA or EXPLAIN.' };
  }
  if (/\b(attach|detach)\b/i.test(stripped)) {
    return { ok: false, reason: 'ATTACH is not allowed. This viewer reads one database at a time.' };
  }
  /* A WITH clause (or anything else) must not lead into a write. SQLite
   * accepts WITH x AS (...) DELETE/INSERT/UPDATE as one statement, so the
   * write verbs are refused wherever they appear as words in the stripped
   * statement. Identifiers and strings are already masked, so a column
   * named "delete" cannot trip this and a bare verb cannot hide. */
  if (WRITE_VERBS_RE.test(stripped)) {
    return { ok: false, reason: 'Only read queries run here. A statement that writes (INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, VACUUM and friends) is refused, even behind a WITH clause.' };
  }
  /* PRAGMA is a family, and half the family writes. Only the read-only
   * introspection PRAGMAs pass, and never a set form. SQLite spells a set
   * two ways, "PRAGMA name = value" and "PRAGMA name(value)", so a
   * parenthesized argument counts as a set for every scalar PRAGMA; parens
   * stay legal only for the introspection PRAGMAs that genuinely take an
   * argument, like table_info('t') or integrity_check(10). */
  if (kw === 'pragma') {
    const m = /^\s*pragma\s+([a-z0-9_]+)\s*(=|\()?/i.exec(stripped);
    const name = m && m[1] ? m[1].toLowerCase() : '';
    if (!READ_PRAGMAS.has(name)) {
      return { ok: false, reason: 'That PRAGMA can change the database. Only read-only PRAGMAs run here, for example table_info, index_list or integrity_check.' };
    }
    if (m && m[2] && (m[2] === '=' || !READ_PRAGMA_FUNCS.has(name))) {
      return { ok: false, reason: 'A PRAGMA given a value can change the database. Only the bare read form of ' + name + ' runs here.' };
    }
  }
  return { ok: true };
}

/* Add a LIMIT to a browsing query that has none, so a careless SELECT over
 * fifteen million rows comes back as a page, not a flood. PRAGMA and
 * EXPLAIN are left alone; a query that already limits itself is trusted. */
function applyRowCap(sql, cap) {
  const stripped = stripSqlNoise(sql);
  if (stripped === null) return { sql, capped: false };
  const kw = firstKeywordOf(stripped);
  if (kw !== 'select' && kw !== 'with') return { sql, capped: false };
  if (/\blimit\b/i.test(stripped)) return { sql, capped: false };
  const trimmed = String(sql).replace(/[\s;]+$/, '');
  return { sql: trimmed + ' LIMIT ' + Math.max(1, Math.floor(cap)), capped: true };
}

/* ------------------------------------------------------- result shaping -- */

/* `sqlite3 -json` prints an array of objects, or nothing at all for zero
 * rows. Key order follows column order, which JSON.parse preserves. */
function cliTable(stdout) {
  const text = String(stdout || '').trim();
  if (text === '') return { columns: [], rows: [] };
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) return { columns: [], rows: [] };
  const columns = Object.keys(parsed[0]);
  return { columns, rows: parsed.map((o) => columns.map((c) => o[c])) };
}

/* sql.js `exec` returns [{ columns, values }], or [] for zero rows. */
function wasmTable(result) {
  if (!Array.isArray(result) || result.length === 0) return { columns: [], rows: [] };
  return { columns: result[0].columns.slice(), rows: result[0].values.map((r) => r.slice()) };
}

function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------- query building -- */

function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function quoteLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

/* A per-column text filter becomes a LIKE over the text form of the value,
 * with the member's %, _ and \ treated as plain characters. */
function filterClause(column, text) {
  const pattern = '%' + String(text).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  return 'CAST(' + quoteIdent(column) + ' AS TEXT) LIKE ' + quoteLiteral(pattern) + " ESCAPE '\\'";
}

function whereOf(filters) {
  const parts = [];
  for (const [col, text] of Object.entries(filters || {})) {
    if (text !== '' && text !== null && text !== undefined) parts.push(filterClause(col, text));
  }
  return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}

function buildBrowseQuery(table, { filters, sortCol, sortDir, limit, offset } = {}) {
  let sql = 'SELECT * FROM ' + quoteIdent(table) + whereOf(filters);
  if (sortCol) sql += ' ORDER BY ' + quoteIdent(sortCol) + (sortDir === 'desc' ? ' DESC' : ' ASC');
  sql += ' LIMIT ' + Math.max(1, Math.floor(limit || 50));
  sql += ' OFFSET ' + Math.max(0, Math.floor(offset || 0));
  return sql;
}

function buildCountQuery(table, { filters } = {}) {
  return 'SELECT COUNT(*) AS n FROM ' + quoteIdent(table) + whereOf(filters);
}

/* -------------------------------------------------- the database index -- */

function isSidecarPath(path) { return SIDECAR_RE.test(path); }

function isDbPath(path) {
  if (isSidecarPath(path)) return false;
  return DB_EXTS.has(extOf(path));
}

function isSkippedPath(path) {
  return String(path).split('/').some((seg) => SKIP_FOLDERS.has(seg));
}

/* Every database in the vault, from a list of { path, size }. Sidecars and
 * the folders nobody means (.obsidian, .git, .trash) stay out. */
function findDatabases(files) {
  return files
    .filter((f) => isDbPath(f.path) && !isSkippedPath(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/* ---------------------------------------------------- dashboard specs -- */

/* A dashboard is a JSON file: { id, title, database?, globalTimeframe?,
 * tiles: [...] }. A tile is either a raw SQL tile
 * { title, sql, viz, x, y, unit?, stack? } or a built widget
 * { title, viz, unit?, stack?, source: { database?, table, metric, agg,
 * filter?, series?, groupBy?, timeColumn?, timeframe? } }. Raw SQL passes
 * the statement gate at parse time; built widgets get their SQL generated
 * by sqlForWidget, through the same gate at query time. */
function parseDashboardSpec(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'This file is not valid JSON. ' + e.message };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'A dashboard file must be a JSON object.' };
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(raw.id)) {
    return { ok: false, reason: 'The dashboard needs an "id": lowercase letters, digits and hyphens.' };
  }
  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    return { ok: false, reason: 'The dashboard needs a "title".' };
  }
  if (raw.database !== undefined && (typeof raw.database !== 'string' || !raw.database.trim())) {
    return { ok: false, reason: 'The "database" must be a vault path like "07 Databases/example.db".' };
  }
  if (!validTimeframe(raw.globalTimeframe, false)) {
    return { ok: false, reason: 'The "globalTimeframe" must be a preset like {"preset":"90d"} or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}.' };
  }
  if (!Array.isArray(raw.tiles)) {
    return { ok: false, reason: 'The dashboard needs a "tiles" list. An empty list is fine; the builder adds widgets to it.' };
  }
  const database = raw.database ? normalizePath(raw.database.trim()) : '';
  const tiles = [];
  for (let i = 0; i < raw.tiles.length; i++) {
    const t = raw.tiles[i];
    const at = 'Tile ' + (i + 1);
    if (!t || typeof t !== 'object') return { ok: false, reason: at + ' must be a JSON object.' };
    if (!VIZ_KINDS.has(t.viz)) return { ok: false, reason: at + ' needs a "viz" of line, bar, stat or table.' };

    let layout;
    if (t.layout !== undefined) {
      const l = t.layout;
      const wholeAtLeast = (v, min) => Number.isInteger(v) && v >= min;
      if (!l || typeof l !== 'object'
        || !wholeAtLeast(l.x, 0) || !wholeAtLeast(l.y, 0)
        || !wholeAtLeast(l.w, 1) || !wholeAtLeast(l.h, 1)
        || l.w > SPAN_CAP || l.h > SPAN_CAP) {
        return { ok: false, reason: at + ': "layout" must be {x, y, w, h} in whole grid cells, w and h at least 1 and at most ' + SPAN_CAP + '.' };
      }
      layout = { x: l.x, y: l.y, w: l.w, h: l.h };
    }

    if (t.source !== undefined) {
      /* A built widget. */
      if (t.viz === 'table') return { ok: false, reason: at + ': a built widget draws a line, bar or stat; use an SQL tile for a table.' };
      const check = checkWidgetSource(t.source, t.viz, at);
      if (!check.ok) return check;
      if (!t.source.database && !database) return { ok: false, reason: at + ' needs a database, on the widget or on the dashboard.' };
      const compare = t.compare === undefined ? 'none' : t.compare;
      if (!['none', 'previous', 'last_year'].includes(compare)) {
        return { ok: false, reason: at + ': "compare" must be none, previous or last_year.' };
      }
      if (compare !== 'none' && t.source.series) {
        return { ok: false, reason: at + ': a widget split into series cannot also compare periods. Remove the dimension or the comparison.' };
      }
      const favorable = t.favorable === undefined ? 'up' : t.favorable;
      if (favorable !== 'up' && favorable !== 'down') {
        return { ok: false, reason: at + ': "favorable" must be "up" or "down" (which direction counts as good).' };
      }
      tiles.push({
        title: typeof t.title === 'string' ? t.title : '',
        viz: t.viz,
        unit: typeof t.unit === 'string' ? t.unit : '',
        stack: t.stack === true,
        layout,
        compare,
        favorable,
        source: {
          database: t.source.database ? normalizePath(t.source.database) : '',
          table: t.source.table,
          metric: typeof t.source.metric === 'string' ? t.source.metric : '',
          agg: check.agg,
          filters: check.filters,
          series: t.source.series || undefined,
          groupBy: t.source.groupBy || undefined,
          timeColumn: t.source.timeColumn || undefined,
          timeframe: t.source.timeframe === undefined ? 'global' : t.source.timeframe,
        },
      });
      continue;
    }

    /* A raw SQL tile. */
    if (typeof t.sql !== 'string' || !t.sql.trim()) return { ok: false, reason: at + ' needs an "sql" query or a "source".' };
    const gate = gateStatement(t.sql);
    if (!gate.ok) return { ok: false, reason: at + ': ' + gate.reason };
    if (!database) return { ok: false, reason: at + ' is an SQL tile, so the dashboard needs a top-level "database".' };
    const y = Array.isArray(t.y) ? t.y.slice() : (typeof t.y === 'string' && t.y ? [t.y] : []);
    if (y.some((c) => typeof c !== 'string' || !c)) return { ok: false, reason: at + ': every "y" entry must be a column name.' };
    if ((t.viz === 'line' || t.viz === 'bar')) {
      if (typeof t.x !== 'string' || !t.x) return { ok: false, reason: at + ' needs an "x" column for a ' + t.viz + ' chart.' };
      if (y.length === 0) return { ok: false, reason: at + ' needs a "y" column for a ' + t.viz + ' chart.' };
    }
    tiles.push({
      title: typeof t.title === 'string' ? t.title : '',
      sql: t.sql,
      viz: t.viz,
      x: typeof t.x === 'string' ? t.x : '',
      y,
      unit: typeof t.unit === 'string' ? t.unit : '',
      stack: t.stack === true,
      layout,
    });
  }
  return {
    ok: true,
    spec: {
      id: raw.id,
      title: raw.title.trim(),
      database,
      globalTimeframe: raw.globalTimeframe || DEFAULT_GLOBAL_TIMEFRAME,
      tiles,
    },
  };
}

/* The database a tile actually reads. */
function tileDatabase(tile, spec) {
  return (tile.source && tile.source.database) || spec.database || '';
}

/* The SQL a tile actually runs. */
function tileSql(tile, spec) {
  return tile.source ? sqlForWidget(tile, spec.globalTimeframe) : tile.sql;
}

/* A parsed spec back to the JSON the builder saves. The inverse of
 * parseDashboardSpec for everything the plugin understands; unknown keys
 * from hand-edited files are not carried (the parser ignored them too). */
function specToJson(spec) {
  const out = { id: spec.id, title: spec.title };
  if (spec.database) out.database = spec.database;
  out.globalTimeframe = spec.globalTimeframe || DEFAULT_GLOBAL_TIMEFRAME;
  out.tiles = spec.tiles.map((t) => {
    const tile = {};
    if (t.title) tile.title = t.title;
    tile.viz = t.viz;
    if (t.unit) tile.unit = t.unit;
    if (t.stack) tile.stack = true;
    if (t.layout) tile.layout = { x: t.layout.x, y: t.layout.y, w: t.layout.w, h: t.layout.h };
    if (t.compare && t.compare !== 'none') tile.compare = t.compare;
    if (t.favorable && t.favorable !== 'up') tile.favorable = t.favorable;
    if (t.source) {
      const s = {};
      if (t.source.database) s.database = t.source.database;
      s.table = t.source.table;
      if (t.source.metric) s.metric = t.source.metric;
      s.agg = t.source.agg;
      if (t.source.filters && t.source.filters.length) {
        s.filters = t.source.filters.map((row) => {
          const out = { column: row.column, op: row.op };
          if (row.value !== undefined) out.value = row.value;
          return out;
        });
      }
      if (t.source.series) s.series = t.source.series;
      if (t.source.groupBy) s.groupBy = t.source.groupBy;
      if (t.source.timeColumn) s.timeColumn = t.source.timeColumn;
      s.timeframe = t.source.timeframe === undefined ? 'global' : t.source.timeframe;
      tile.source = s;
    } else {
      tile.sql = t.sql;
      if (t.x) tile.x = t.x;
      if (t.y && t.y.length) tile.y = t.y.length === 1 ? t.y[0] : t.y;
    }
    return tile;
  });
  return JSON.stringify(out, null, 2) + '\n';
}

/* Where a dashboard's computed results live in the vault, so Obsidian Sync
 * carries them to devices that cannot open the database itself. Since
 * 0.2.0 a dashboard can read several databases, so the cache is keyed by
 * dashboard id; cachePathFor stays for reading a 0.1.x cache. */
function cachePathFor(cacheFolder, dbPath, dashboardId) {
  return normalizePath(cacheFolder + '/' + stemOf(dbPath) + '/' + dashboardId + '.json');
}

function dashCachePath(cacheFolder, dashboardId) {
  return normalizePath(cacheFolder + '/dashboards/' + dashboardId + '.json');
}

/* The catalog a desktop writes next to the cache: enough schema for the
 * mobile picker when the database itself cannot be opened there. */
/* A short stable key for a database: the stem stays readable, the FNV-1a
 * hash of the full vault path keeps two same-named databases apart. */
function shortHash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function dbKeyOf(dbPath) {
  return stemOf(dbPath) + '-' + shortHash(normalizePath(dbPath));
}

function catalogPathFor(cacheFolder, dbPath) {
  return normalizePath(cacheFolder + '/catalogs/' + dbKeyOf(dbPath) + '.json');
}

/* Where a 0.5.0 catalog lived, read as a fallback until it regenerates. */
function legacyCatalogPathFor(cacheFolder, dbPath) {
  return normalizePath(cacheFolder + '/catalogs/' + stemOf(dbPath) + '.json');
}

/* ---------------------------------------------------- migration planning -- */

/* Plan the "Move databases into 07 Data" button: every database outside the
 * data folder moves to its top level, sidecars travel with their database,
 * nothing is ever overwritten. Pure: takes paths, returns the plan. */
function planMigration(dbPaths, existingPaths, targetRoot) {
  const root = normalizePath(targetRoot || '07 Databases');
  const moves = [];
  const skips = [];
  const claimed = new Set();
  for (const from of dbPaths) {
    if (from === root || from.startsWith(root + '/')) {
      skips.push({ path: from, reason: 'already inside ' + root });
      continue;
    }
    const to = root + '/' + baseName(from);
    if (existingPaths.has(to) || claimed.has(to)) {
      skips.push({ path: from, reason: 'a file named ' + baseName(from) + ' already exists in ' + root });
      continue;
    }
    claimed.add(to);
    const sidecars = [];
    for (const suffix of ['-wal', '-shm']) {
      if (existingPaths.has(from + suffix)) sidecars.push({ from: from + suffix, to: to + suffix });
    }
    moves.push({ from, to, sidecars });
  }
  return { moves, skips, targetRoot: root };
}

/* ---------------------------------------------------------- chart math -- */

/* A pleasant axis: round step sizes, ticks that land on round numbers. */
function niceScale(lo, hi, maxTicks) {
  let min = Number(lo);
  let max = Number(hi);
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;
  if (min > max) { const t = min; min = max; max = t; }
  if (min === max) { max = min === 0 ? 1 : min + Math.abs(min) * 0.1; }
  const span = max - min;
  const count = Math.max(2, maxTicks || 5);
  const rough = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (mag * m >= rough) { step = mag * m; break; }
  }
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 1e6; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return { min: start, max: end, step, ticks };
}

/* Stacked bar segments: for each row, each series' [base, top]. Negative
 * values are clamped to zero rather than drawn downward; a stacked chart of
 * hours or counts has no meaningful negative direction. */
function stackRows(rows, seriesIdx) {
  return rows.map((row) => {
    let base = 0;
    return seriesIdx.map((i) => {
      const v = Math.max(0, Number(row[i]) || 0);
      const seg = [base, base + v];
      base += v;
      return seg;
    });
  });
}

function columnIndex(columns, name) { return columns.indexOf(name); }

/* The value a stat tile shows: the named y column of the first row, or the
 * first column when no y is named. The next column, if any, is the caption. */
function statOf(table, tile) {
  if (!table.rows.length) return { value: null, caption: '' };
  const row = table.rows[0];
  const yName = tile.y && tile.y.length ? tile.y[0] : table.columns[0];
  const yIdx = Math.max(0, columnIndex(table.columns, yName));
  const captionIdx = table.columns.findIndex((c, i) => i !== yIdx);
  return { value: row[yIdx], caption: captionIdx >= 0 ? String(row[captionIdx] === null ? '' : row[captionIdx]) : '' };
}

/* ------------------------------------------- widgets built without SQL -- */

/* A structured widget names what it wants (database, table, metric,
 * aggregation, slices, time) and deterministic code turns that into SQL,
 * always through quoteIdent and quoteLiteral, always through the statement
 * gate. One render path for hand-written SQL tiles and built widgets. */

const AGGS = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX', count: 'COUNT', latest: 'LATEST' };
const AGG_LABELS = { sum: 'Add up', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count rows', latest: 'Latest value' };
const PRESETS = { '7d': { days: 7 }, '30d': { days: 30 }, '90d': { days: 90 }, '12m': { months: 12 }, all: null };
const PRESET_LABELS = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months', all: 'All time' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_GLOBAL_TIMEFRAME = { preset: '90d' };

/* Is this a usable timeframe value? 'global' means: follow the dashboard. */
function validTimeframe(tf, allowGlobal) {
  if (tf === undefined || tf === null) return true;
  if (tf === 'global') return !!allowGlobal;
  if (typeof tf !== 'object') return false;
  if (tf.preset !== undefined) return Object.prototype.hasOwnProperty.call(PRESETS, tf.preset);
  if (tf.from !== undefined || tf.to !== undefined) return DATE_RE.test(String(tf.from)) && DATE_RE.test(String(tf.to));
  return false;
}

/* A widget set to "global" takes the dashboard's range; a fixed one keeps
 * its own; nothing at all falls back to the dashboard as well. */
function resolveTimeframe(tf, globalTf) {
  const fallback = globalTf || DEFAULT_GLOBAL_TIMEFRAME;
  if (tf === undefined || tf === null || tf === 'global') return fallback;
  return tf;
}

/* The filter operators, in plain words. Each maps one filter row to one
 * SQL condition, always through quoteIdent and quoteLiteral. */
const FILTER_OPS = {
  eq: { label: 'is', sql: (c, v) => quoteIdent(c) + ' = ' + quoteLiteral(v) },
  ne: { label: 'is not', sql: (c, v) => quoteIdent(c) + ' <> ' + quoteLiteral(v) },
  contains: { label: 'contains', sql: (c, v) => filterClause(c, v) },
  not_contains: { label: 'does not contain', sql: (c, v) => 'NOT (' + filterClause(c, v) + ')' },
  gt: { label: 'greater than', sql: (c, v) => quoteIdent(c) + ' > ' + quoteLiteral(v) },
  gte: { label: 'at least', sql: (c, v) => quoteIdent(c) + ' >= ' + quoteLiteral(v) },
  lt: { label: 'less than', sql: (c, v) => quoteIdent(c) + ' < ' + quoteLiteral(v) },
  lte: { label: 'at most', sql: (c, v) => quoteIdent(c) + ' <= ' + quoteLiteral(v) },
  empty: { label: 'is empty', noValue: true, sql: (c) => '(' + quoteIdent(c) + " IS NULL OR " + quoteIdent(c) + " = '')" },
  not_empty: { label: 'is not empty', noValue: true, sql: (c) => '(' + quoteIdent(c) + " IS NOT NULL AND " + quoteIdent(c) + " <> '')" },
};

function filterConditionOf(row) {
  const op = FILTER_OPS[row.op || 'eq'];
  if (!op) return '';
  return op.sql(row.column, row.value);
}

/* Every filter row of a source as one AND chain. */
function filtersCondOf(s) {
  const rows = Array.isArray(s.filters) ? s.filters : [];
  return rows.map(filterConditionOf).filter(Boolean).join(' AND ');
}

/* The WHERE pieces for a timeframe. Presets anchor on the newest row the
 * table has (per filter), not on today, so a chart over a data set that
 * stopped updating still shows its last days instead of nothing.
 * `shift` widens the view backwards: 'previous' is the period before the
 * current one, 'year' is the same period one year earlier. */
function timeframeConditions({ table, timeColumn, frame, filterCond, shift }) {
  if (!timeColumn || !frame) return [];
  const col = quoteIdent(timeColumn);
  if (frame.preset !== undefined) {
    const span = PRESETS[frame.preset];
    if (!span) return []; /* 'all' has no previous period either */
    const step = span.days ? span.days + ' day' : span.months + ' month';
    const anchor = '(SELECT MAX(' + col + ') FROM ' + quoteIdent(table) + (filterCond ? ' WHERE ' + filterCond : '') + ')';
    if (shift === 'previous') {
      return [
        col + ' >= date(' + anchor + ", '-" + (span.days ? span.days * 2 + ' day' : span.months * 2 + ' month') + "')",
        col + ' < date(' + anchor + ", '-" + step + "')",
      ];
    }
    if (shift === 'year') {
      return [
        col + ' >= date(' + anchor + ", '-1 year', '-" + step + "')",
        col + " <= date(" + anchor + ", '-1 year')",
      ];
    }
    return [col + ' >= date(' + anchor + ", '-" + step + "')"];
  }
  if (shift === 'previous') {
    const spanDays = "(julianday(" + quoteLiteral(frame.to) + ") - julianday(" + quoteLiteral(frame.from) + ") + 1)";
    return [
      col + ' >= date(' + quoteLiteral(frame.from) + ", '-' || " + spanDays + " || ' day')",
      col + ' < ' + quoteLiteral(frame.from),
    ];
  }
  if (shift === 'year') {
    return [
      col + ' >= date(' + quoteLiteral(frame.from) + ", '-1 year')",
      col + ' <= date(' + quoteLiteral(frame.to) + ", '-1 year')",
    ];
  }
  return [
    col + ' >= ' + quoteLiteral(frame.from),
    col + ' <= ' + quoteLiteral(frame.to),
  ];
}

/* Descriptor to SQL. Charts come back as (x[, series], value); stats as a
 * single value row. Pure and deterministic: the same descriptor and the
 * same global range always produce the same string. `shift` produces the
 * comparison period's twin query. */
function sqlForWidget(tile, globalTf, shift) {
  const s = tile.source;
  const table = quoteIdent(s.table);
  const filterCond = filtersCondOf(s);
  const conds = filterCond ? [filterCond] : [];
  const frame = resolveTimeframe(s.timeframe, globalTf);
  conds.push(...timeframeConditions({ table: s.table, timeColumn: s.timeColumn, frame, filterCond, shift }));
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

  if (tile.viz === 'stat') {
    if (s.agg === 'latest') {
      return 'SELECT ' + quoteIdent(s.metric) + ' AS value' + (s.timeColumn ? ', ' + quoteIdent(s.timeColumn) + ' AS at' : '') +
        ' FROM ' + table + where +
        (s.timeColumn ? ' ORDER BY ' + quoteIdent(s.timeColumn) + ' DESC' : '') + ' LIMIT 1';
    }
    const expr = s.agg === 'count' ? 'COUNT(*)' : AGGS[s.agg] + '(' + quoteIdent(s.metric) + ')';
    return 'SELECT ' + expr + ' AS value FROM ' + table + where;
  }

  const groupBy = s.groupBy || s.timeColumn;
  const expr = s.agg === 'count' ? 'COUNT(*)' : AGGS[s.agg] + '(' + quoteIdent(s.metric) + ')';
  let sql = 'SELECT ' + quoteIdent(groupBy) + ' AS x';
  if (s.series) sql += ', ' + quoteIdent(s.series) + ' AS series';
  sql += ', ' + expr + ' AS value FROM ' + table + where;
  sql += ' GROUP BY ' + quoteIdent(groupBy) + (s.series ? ', ' + quoteIdent(s.series) : '');
  sql += ' ORDER BY ' + quoteIdent(groupBy);
  return sql;
}

/* Long (x, series, value) rows to wide columns, one per series, so the
 * chart renderer sees the same shape a hand-written multi-column query
 * produces. Series are ordered by total, biggest first, capped at 8. */
function pivotSeries(table) {
  const xi = columnIndex(table.columns, 'x');
  const si = columnIndex(table.columns, 'series');
  const vi = columnIndex(table.columns, 'value');
  if (xi < 0 || si < 0 || vi < 0) return table;
  const totals = new Map();
  for (const row of table.rows) {
    const key = String(row[si]);
    totals.set(key, (totals.get(key) || 0) + (Number(row[vi]) || 0));
  }
  const ranked = [...totals.keys()].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0));
  /* The extent is bounded by design, never by data: at six or more series
   * the top four keep their lenses and the rest aggregate as Other. */
  const degrade = ranked.length > SERIES_CEILING;
  const names = degrade ? ranked.slice(0, SERIES_CEILING - 1) : ranked;
  const index = new Map(names.map((n, i) => [n, i]));
  const otherSlot = degrade ? names.length : -1;
  const width = names.length + (degrade ? 1 : 0);
  const xOrder = [];
  const byX = new Map();
  for (const row of table.rows) {
    const x = row[xi];
    const key = String(x);
    if (!byX.has(key)) { byX.set(key, new Array(width).fill(null)); xOrder.push(x); }
    let slot = index.get(String(row[si]));
    if (slot === undefined) slot = otherSlot;
    if (slot >= 0) {
      const cells = byX.get(key);
      const v = Number(row[vi]);
      if (Number.isFinite(v)) cells[slot] = (cells[slot] || 0) + v;
    }
  }
  const columns = ['x', ...names];
  if (degrade) columns.push('Other');
  return { columns, rows: xOrder.map((x) => [x, ...byX.get(String(x))]) };
}

/* What the renderer needs for any tile: the tile's own axes for a raw SQL
 * tile, generated axes (and a pivot when there is a series) for a built
 * one. Pure, so the live path and the cache path share it. */
function prepareTileForRender(tile, table) {
  if (!tile.source) return { spec: tile, table };
  if (tile.viz === 'stat') {
    return { spec: { title: tile.title, viz: 'stat', y: ['value'], unit: tile.unit }, table };
  }
  if (tile.source.series) {
    const wide = pivotSeries(table);
    return {
      spec: { title: tile.title, viz: tile.viz, x: 'x', y: wide.columns.slice(1), unit: tile.unit, stack: tile.stack },
      table: wide,
    };
  }
  return { spec: { title: tile.title, viz: tile.viz, x: 'x', y: ['value'], unit: tile.unit, stack: false }, table };
}

/* Validate one structured source. Returns { ok } or { ok, reason }. */
function checkWidgetSource(s, viz, at) {
  if (!s || typeof s !== 'object') return { ok: false, reason: at + ': "source" must be an object.' };
  if (typeof s.table !== 'string' || !s.table) return { ok: false, reason: at + ' needs a "table".' };
  const agg = s.agg === undefined ? 'sum' : s.agg;
  if (!AGGS[agg]) return { ok: false, reason: at + ': "agg" must be one of sum, avg, min, max, count, latest.' };
  if (agg !== 'count' && (typeof s.metric !== 'string' || !s.metric)) return { ok: false, reason: at + ' needs a "metric" column.' };
  if (agg === 'latest' && viz !== 'stat') return { ok: false, reason: at + ': "latest" only works on a stat widget.' };
  const rawFilters = s.filters !== undefined ? s.filters
    : (s.filter !== undefined ? [Object.assign({ op: 'eq' }, s.filter)] : []);
  if (!Array.isArray(rawFilters)) return { ok: false, reason: at + ': "filters" must be a list of rows.' };
  const filters = [];
  for (const row of rawFilters) {
    if (!row || typeof row.column !== 'string' || !row.column) {
      return { ok: false, reason: at + ': every filter row needs a "column".' };
    }
    const op = row.op === undefined ? 'eq' : row.op;
    if (!FILTER_OPS[op]) {
      return { ok: false, reason: at + ': a filter "op" must be one of ' + Object.keys(FILTER_OPS).join(', ') + '.' };
    }
    if (!FILTER_OPS[op].noValue && (row.value === undefined || row.value === null)) {
      return { ok: false, reason: at + ': the filter on ' + row.column + ' needs a "value".' };
    }
    filters.push({ column: row.column, op, value: FILTER_OPS[op].noValue ? undefined : String(row.value) });
  }
  if (s.series !== undefined && (typeof s.series !== 'string' || !s.series)) return { ok: false, reason: at + ': "series" must be a column name.' };
  if (s.series && viz === 'stat') return { ok: false, reason: at + ': a stat widget cannot be split into series.' };
  if (s.groupBy !== undefined && (typeof s.groupBy !== 'string' || !s.groupBy)) return { ok: false, reason: at + ': "groupBy" must be a column name.' };
  if (s.timeColumn !== undefined && (typeof s.timeColumn !== 'string' || !s.timeColumn)) return { ok: false, reason: at + ': "timeColumn" must be a column name.' };
  if (!validTimeframe(s.timeframe, true)) return { ok: false, reason: at + ': "timeframe" must be "global", a preset like {"preset":"90d"}, or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}.' };
  if (viz !== 'stat' && !s.groupBy && !s.timeColumn) return { ok: false, reason: at + ' needs a "groupBy" or a "timeColumn" to chart over.' };
  if (s.database !== undefined && (typeof s.database !== 'string' || !s.database)) return { ok: false, reason: at + ': "database" must be a vault path.' };
  return { ok: true, agg, filters };
}

/* Column-type helpers for the picker and the catalog. */
function isNumericType(type) { return /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(String(type || '')); }
function isTextType(type) { const t = String(type || ''); return t === '' || /CHAR|TEXT|CLOB/i.test(t); }

/* A friendly guess at the time column: the names Tom's tables actually
 * use, most specific first. Just a default; the picker lets it change. */
function guessTimeColumn(columns) {
  const names = columns.map((c) => c.name);
  for (const exact of ['local_date', 'batch_id', 'snapshot_date', 'period_end']) {
    if (names.includes(exact)) return exact;
  }
  return names.find((n) => /date|_at$|^at$|timestamp|day|week|month/i.test(n)) || '';
}

/* Case-insensitive word match for the picker lists: every word the member
 * typed must appear somewhere in the label or the detail. */
function matchesNeedle(needle, label, detail) {
  const hay = (String(label || '') + ' ' + String(detail || '')).toLowerCase();
  return String(needle || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/* ----------------------------------------------------- the grid engine -- */

/* How many columns fit a container of this width, keeping cells roughly
 * GRID_UNIT_PX square. Phones get 2, wide panes get up to 6. */
function colsForWidth(width) {
  const w = Number(width) || 0;
  const cols = Math.floor((w + GRID_GAP_PX) / (GRID_UNIT_PX + GRID_GAP_PX));
  return Math.max(GRID_MIN_COLS, Math.min(GRID_MAX_COLS, cols));
}

/* The span a widget gets when its spec carries none (a 0.2.x file):
 * a stat is a small square, a chart a 2x2 block, a table a wide 3x2. */
function defaultSpanFor(tile) {
  if (tile.viz === 'stat') return { w: 1, h: 1 };
  if (tile.viz === 'table') return { w: 3, h: 2 };
  return { w: 2, h: 2 };
}

function clampLayout(l, cols) {
  const w = Math.max(1, Math.min(Math.floor(l.w) || 1, Math.min(cols, SPAN_CAP)));
  const h = Math.max(1, Math.min(Math.floor(l.h) || 1, SPAN_CAP));
  const x = Math.max(0, Math.min(Math.floor(l.x) || 0, cols - w));
  const y = Math.max(0, Math.floor(l.y) || 0);
  return { x, y, w, h };
}

function rectsCollide(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* First free spot for a w x h rectangle, scanning rows top to bottom. */
function findSpot(placed, size, cols) {
  const w = Math.min(size.w, cols);
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const candidate = { x, y, w, h: size.h };
      if (!placed.some((p) => rectsCollide(candidate, p))) return candidate;
    }
  }
}

/* THE PACKING RULE, in plain words: the widget being placed stays exactly
 * where it was put; every other widget that overlaps it is pushed DOWN
 * until nothing overlaps; then everything floats UP into the gaps, in
 * reading order. Deterministic: the same input always packs the same. */
function packLayout(layouts, cols, anchorIndex) {
  const clamped = layouts.map((l) => clampLayout(l, cols));
  const order = clamped.map((l, i) => i).sort((a, b) =>
    (clamped[a].y - clamped[b].y) || (clamped[a].x - clamped[b].x) || (a - b));
  const out = new Array(clamped.length);
  const placed = [];
  /* The anchor claims its ground first. */
  if (anchorIndex >= 0 && anchorIndex < clamped.length) {
    out[anchorIndex] = Object.assign({}, clamped[anchorIndex]);
    placed.push(out[anchorIndex]);
  }
  /* Everyone else lands in reading order, pushed down past any overlap. */
  for (const i of order) {
    if (i === anchorIndex) continue;
    const l = Object.assign({}, clamped[i]);
    while (placed.some((p) => rectsCollide(l, p))) l.y++;
    out[i] = l;
    placed.push(l);
  }
  /* Float up: in reading order, every widget except the anchor rises while
   * the space above it is free. */
  const upOrder = out.map((l, i) => i).sort((a, b) =>
    (out[a].y - out[b].y) || (out[a].x - out[b].x) || (a - b));
  for (const i of upOrder) {
    if (i === anchorIndex) continue;
    const l = out[i];
    while (l.y > 0) {
      const above = { x: l.x, y: l.y - 1, w: l.w, h: l.h };
      if (out.some((other, j) => j !== i && rectsCollide(above, other))) break;
      l.y--;
    }
  }
  return out;
}

/* Layouts for every tile: the spec's own {x,y,w,h} where present, a
 * sensible default spot where not (the 0.2.x migration), everything
 * clamped to the column count and packed without overlaps. */
function normalizeLayout(tiles, cols) {
  const layouts = [];
  const placed = [];
  for (const tile of tiles) {
    if (tile.layout) {
      const l = clampLayout(tile.layout, cols);
      layouts.push(l);
      placed.push(l);
    } else {
      const spot = findSpot(placed, defaultSpanFor(tile), cols);
      layouts.push(spot);
      placed.push(spot);
    }
  }
  return packLayout(layouts, cols, -1);
}

/* The + tile shows only on an empty dashboard or in edit mode: a full
 * dashboard at rest is widgets and nothing else. */
function showAddTile(tileCount, editMode) {
  return tileCount === 0 || editMode === true;
}

/* What reaches the developer console: a stable line naming the place and
 * the error class, never SQL text and never database content. The full
 * message stays in the on-screen error UI. */
function safeLogLine(context, e) {
  return 'ICOR SQLite Viewer: ' + context + ' (' + ((e && e.name) || 'Error') + ')';
}

/* The sqlite3 path setting runs whatever it points to, so its shape is
 * checked before it is saved: absolute, and the file name says sqlite3. */
function checkSqlite3Path(path) {
  const p = String(path || '').trim();
  if (!p) return { ok: true, empty: true };
  const absolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  if (!absolute) return { ok: false, reason: 'Use a full path, for example /usr/bin/sqlite3.' };
  const base = p.split(/[\\/]/).pop().toLowerCase();
  if (!base.includes('sqlite3')) return { ok: false, reason: 'The file name should contain sqlite3. The plugin runs whatever this points to, so it only accepts a binary that at least says it is sqlite3.' };
  return { ok: true, path: p };
}

/* --------------------------------------------------- comparison rules -- */

const COMPARE_LABELS = { none: 'No comparison', previous: 'Previous period', last_year: 'Same period last year' };

/* A widget can compare periods only when it has a time column, a bounded
 * frame, and no series split. */
function canCompare(tile, globalTf) {
  const s = tile.source;
  if (!s || !s.timeColumn || s.series) return false;
  const frame = resolveTimeframe(s.timeframe, globalTf);
  return !(frame.preset === 'all');
}

/* The comparison badge, and which direction is good. Good is a property
 * of the metric, never of the sign: weight going down is a win. */
function deltaBadge(current, previous, favorable) {
  if (current === null || current === undefined || current === '') return null;
  if (previous === null || previous === undefined || previous === '') return null;
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const diff = cur - prev;
  const direction = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat');
  let label;
  if (prev === 0) label = diff === 0 ? '0%' : (diff > 0 ? '+' : '-') + '100%';
  else {
    const pct = Math.round((diff / Math.abs(prev)) * 1000) / 10;
    label = (pct > 0 ? '+' : '') + formatNumber(pct) + '%';
  }
  const good = direction === 'flat' ? null : (direction === (favorable === 'down' ? 'down' : 'up'));
  return { direction, label, good, diff };
}

/* The preview gate as a state machine: a widget that never previewed
 * green does not save. Only 'ok' unlocks Save; any change makes the
 * preview stale again. */
function nextPreviewState(state, event) {
  if (event === 'change') return 'stale';
  if (event === 'run') return 'running';
  if (event === 'ok') return state === 'running' ? 'ok' : state;
  if (event === 'error') return state === 'running' ? 'error' : state;
  return state;
}

function canSave(previewState) { return previewState === 'ok'; }

/* Size presets for the form: names a member can pick without thinking in
 * grid cells. */
const SIZE_PRESETS = {
  small: { label: 'Small (a square)', w: 1, h: 1 },
  medium: { label: 'Medium', w: 2, h: 2 },
  wide: { label: 'Wide', w: 3, h: 2 },
  large: { label: 'Large', w: 3, h: 3 },
};

function sizePresetOf(layout) {
  if (!layout) return '';
  for (const [key, p] of Object.entries(SIZE_PRESETS)) {
    if (p.w === layout.w && p.h === layout.h) return key;
  }
  return '';
}

/* ========================================================================
 * 2. THE ENGINES
 * ====================================================================== */

/* Every Node handle the desktop engine needs, gathered in one place behind
 * the platform check, so the module loads clean on a phone and the gates
 * can hand in fakes. */
function makeDesktopDeps() {
  if (!Platform.isDesktopApp) return null;
  return {
    childProcess: require('child_process'),
    pathx: require('path'),
    fsx: require('fs'),
  };
}

/* SQLite accepts a file: URI; percent, question mark and hash are the only
 * characters that would change its meaning, so only those are encoded. */
function dbFileUri(absPath) {
  return 'file:' + String(absPath).replace(/[%?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '?mode=ro';
}

function detectCli(deps, bin) {
  return new Promise((resolve) => {
    let done = false;
    try {
      deps.childProcess.execFile(bin || 'sqlite3', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (done) return;
        done = true;
        if (err) resolve({ ok: false, reason: 'The sqlite3 command line tool was not found.' });
        else resolve({ ok: true, version: String(stdout).trim().split(' ')[0] });
      });
    } catch (e) {
      if (!done) { done = true; resolve({ ok: false, reason: 'The sqlite3 command line tool was not found.' }); }
    }
  });
}

/* ENGINE A: one sqlite3 process per query. The SQL is an argument, never a
 * shell string. Read-only twice over: the -readonly flag and mode=ro in the
 * URI. A busy timeout retries for a few seconds when another app is
 * writing to the database at that moment (live gate: the engagement loop
 * held a write lock and every tile failed with "database is locked").
 * A query that runs too long is killed, and says so in plain words. */
function cliQuery(deps, { bin, absPath, sql, timeoutMs, maxBuffer }) {
  return new Promise((resolve, reject) => {
    const args = ['-readonly', '-json', '-cmd', '.timeout 5000', dbFileUri(absPath), sql];
    deps.childProcess.execFile(
      bin || 'sqlite3',
      args,
      { timeout: timeoutMs || 30000, maxBuffer: maxBuffer || CLI_MAX_BUFFER, killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            reject(new Error('The query was stopped after ' + Math.round((timeoutMs || 30000) / 1000) + ' seconds. Narrow it down, for example with a date range or a LIMIT.'));
            return;
          }
          let detail = String(stderr || err.message || '').trim().replace(/^Error:\s*/i, '');
          if (/database is locked|database table is locked/i.test(detail)) {
            detail += '. Another app is writing to this database right now; try again in a moment.';
          }
          reject(new Error(detail || 'The query failed.'));
          return;
        }
        try {
          resolve(cliTable(stdout));
        } catch (e) {
          reject(new Error('The result could not be read as JSON. ' + e.message));
        }
      }
    );
  });
}

/* ENGINE B: sql.js. The whole database file is loaded into memory, so the
 * caller checks the size cap first. The wasm module loads once per session;
 * an open database is kept until the file on disk changes. */
class WasmEngine {
  constructor(plugin) {
    this.plugin = plugin;
    this.SQL = null;
    this.open = new Map(); /* dbPath -> { db, mtime, size } */
  }

  async init() {
    if (this.SQL) return;
    const adapter = this.plugin.app.vault.adapter;
    const dir = this.plugin.manifest.dir;
    const jsText = await adapter.read(dir + '/sql-wasm.js');
    const wasmBinary = await adapter.readBinary(dir + '/sql-wasm.wasm');
    const mod = { exports: {} };
    /* sql-wasm.js is a UMD build: given a `module` it exports initSqlJs.
     * `require`, `__dirname` and `__filename` ride along for its Node
     * branch (Electron computes them eagerly even though the wasm arrives
     * as bytes); a plain web view detects the web and never asks. */
    new Function('module', 'exports', 'require', '__dirname', '__filename', jsText)(
      mod, mod.exports, typeof require === 'function' ? require : undefined, '/', '/sql-wasm.js'
    );
    const initSqlJs = mod.exports;
    if (typeof initSqlJs !== 'function') throw new Error('The bundled sql-wasm.js did not load.');
    this.SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasmBinary) });
  }

  async database(dbPath) {
    const adapter = this.plugin.app.vault.adapter;
    const stat = await adapter.stat(dbPath);
    if (!stat) throw new Error('The database file was not found at ' + dbPath + '.');
    const cached = this.open.get(dbPath);
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) return cached.db;
    if (cached) { try { cached.db.close(); } catch (e) { /* already gone */ } this.open.delete(dbPath); }
    await this.init();
    const bytes = await adapter.readBinary(dbPath);
    const db = new this.SQL.Database(new Uint8Array(bytes));
    this.open.set(dbPath, { db, mtime: stat.mtime, size: stat.size });
    return db;
  }

  async query(dbPath, sql) {
    const db = await this.database(dbPath);
    return wasmTable(db.exec(sql));
  }

  closeAll() {
    for (const { db } of this.open.values()) { try { db.close(); } catch (e) { /* already gone */ } }
    this.open.clear();
  }
}

/* The one place a query happens. Gate first, cap second, engine third. */
class QueryService {
  constructor(plugin, deps) {
    this.plugin = plugin;
    this.deps = deps === undefined ? makeDesktopDeps() : deps;
    this.cli = null; /* { ok, version | reason } after detect() */
    this.wasm = new WasmEngine(plugin);
  }

  async detect() {
    if (!this.deps) { this.cli = { ok: false, reason: 'Not on a desktop.' }; return this.cli; }
    this.cli = await detectCli(this.deps, this.plugin.settings.sqlite3Path || 'sqlite3');
    return this.cli;
  }

  cliReady() { return !!(this.deps && this.cli && this.cli.ok); }

  /* Which engine answers for this database, or a plain reason why none can. */
  async engineFor(dbPath) {
    const adapter = this.plugin.app.vault.adapter;
    const stat = await adapter.stat(dbPath);
    if (!stat) return { engine: null, reason: 'The database file was not found at ' + dbPath + '.' };
    if (this.cliReady()) return { engine: 'cli', size: stat.size };
    const capBytes = this.plugin.settings.mobileCapMb * MB;
    if (stat.size <= capBytes) return { engine: 'wasm', size: stat.size };
    const where = this.deps
      ? 'The sqlite3 command line tool was not found, and this database is too big to load into memory'
      : 'This database is too big to load into memory on this device';
    return {
      engine: null,
      size: stat.size,
      reason: where + ' (' + formatBytes(stat.size) + ', the cap is ' + this.plugin.settings.mobileCapMb + ' MB). Dashboards for it still work from the desktop cache.',
    };
  }

  absPathOf(dbPath) {
    const adapter = this.plugin.app.vault.adapter;
    if (typeof adapter.getBasePath !== 'function') throw new Error('No file system path on this device.');
    return this.deps.pathx.join(adapter.getBasePath(), ...dbPath.split('/'));
  }

  /* Run one read-only statement. `cap` adds a LIMIT to an uncapped SELECT;
   * pass 0 to trust the query (the browser builds its own LIMIT). */
  async query(dbPath, sql, { cap } = {}) {
    const gate = gateStatement(sql);
    if (!gate.ok) throw new Error(gate.reason);
    let finalSql = sql;
    let capped = false;
    if (cap) {
      const r = applyRowCap(sql, cap);
      finalSql = r.sql;
      capped = r.capped;
    }
    const choice = await this.engineFor(dbPath);
    if (!choice.engine) throw new Error(choice.reason);
    const t0 = Date.now();
    let table;
    if (choice.engine === 'cli') {
      table = await cliQuery(this.deps, {
        bin: this.plugin.settings.sqlite3Path || 'sqlite3',
        absPath: this.absPathOf(dbPath),
        sql: finalSql,
        timeoutMs: this.plugin.settings.queryTimeoutSec * 1000,
      });
    } else {
      table = await this.wasm.query(dbPath, finalSql);
    }
    return { columns: table.columns, rows: table.rows, ms: Date.now() - t0, engine: choice.engine, capped };
  }
}

/* Move the databases a migration plan names, through the vault adapter,
 * never overwriting. Injected adapter = testable with a fake. */
async function executeMigration(adapter, plan) {
  const results = [];
  await ensureFolder(adapter, plan.targetRoot);
  for (const move of plan.moves) {
    if (!(await adapter.exists(move.from))) {
      results.push({ from: move.from, to: move.to, ok: false, reason: 'the file is gone' });
      continue;
    }
    if (await adapter.exists(move.to)) {
      results.push({ from: move.from, to: move.to, ok: false, reason: 'a file already exists at ' + move.to });
      continue;
    }
    await adapter.rename(move.from, move.to);
    for (const side of move.sidecars) {
      if ((await adapter.exists(side.from)) && !(await adapter.exists(side.to))) {
        await adapter.rename(side.from, side.to);
      }
    }
    results.push({ from: move.from, to: move.to, ok: true });
  }
  return results;
}

async function ensureFolder(adapter, folder) {
  const parts = normalizePath(folder).split('/');
  let path = '';
  for (const part of parts) {
    path = path ? path + '/' + part : part;
    if (!(await adapter.exists(path))) await adapter.mkdir(path);
  }
}

/* ========================================================================
 * 3. THE OBSIDIAN SURFACE
 * ====================================================================== */

/* ------------------------------------------------------------- charts -- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

const CHART_W = 640;
const CHART_H = 260;
const PAD = { top: 14, right: 14, bottom: 34, left: 52 };

function chartFrame(parentEl) {
  const svg = svgEl('svg', { viewBox: '0 0 ' + CHART_W + ' ' + CHART_H, class: 'icor-sqlv-chart', role: 'img' });
  parentEl.appendChild(svg);
  return svg;
}

function drawAxes(svg, scale, xLabels) {
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  for (const tick of scale.ticks) {
    const y = PAD.top + plotH - ((tick - scale.min) / (scale.max - scale.min)) * plotH;
    svg.appendChild(svgEl('line', { x1: PAD.left, y1: y, x2: PAD.left + plotW, y2: y, class: 'icor-sqlv-gridline' }));
    const label = svgEl('text', { x: PAD.left - 6, y: y + 3, 'text-anchor': 'end', class: 'icor-sqlv-tick' });
    label.textContent = formatNumber(tick);
    svg.appendChild(label);
  }
  /* The baseline is the axis; it separates, it does not frame. */
  svg.appendChild(svgEl('line', {
    x1: PAD.left, y1: PAD.top + plotH, x2: PAD.left + plotW, y2: PAD.top + plotH,
    class: 'icor-sqlv-baseline',
  }));
  const n = xLabels.length;
  if (n > 0) {
    const every = Math.max(1, Math.ceil(n / 7));
    for (let i = 0; i < n; i += every) {
      const x = PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
      const label = svgEl('text', { x, y: CHART_H - PAD.bottom + 16, 'text-anchor': 'middle', class: 'icor-sqlv-tick' });
      label.textContent = shortXLabel(xLabels[i]);
      svg.appendChild(label);
    }
  }
  return { plotW, plotH };
}

function shortXLabel(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : (s.length > 10 ? s.slice(0, 10) : s);
}

function legendFor(parentEl, names, palette) {
  if (names.length < 2) return;
  const legend = parentEl.createDiv({ cls: 'icor-sqlv-legend' });
  names.forEach((name, i) => {
    const item = legend.createSpan({ cls: 'icor-sqlv-legend-item' });
    const chip = item.createSpan({ cls: 'icor-sqlv-legend-chip' });
    chip.style.background = palette[i];
    item.createSpan({ text: name });
  });
}

/* A bar with only its top corners rounded; square when narrow. */
function barPath(x, y, w, h, r) {
  if (r <= 0 || h < r) {
    return 'M ' + x.toFixed(1) + ' ' + (y + h).toFixed(1) + ' V ' + y.toFixed(1) + ' H ' + (x + w).toFixed(1) + ' V ' + (y + h).toFixed(1) + ' Z';
  }
  return 'M ' + x.toFixed(1) + ' ' + (y + h).toFixed(1) +
    ' V ' + (y + r).toFixed(1) +
    ' Q ' + x.toFixed(1) + ' ' + y.toFixed(1) + ' ' + (x + r).toFixed(1) + ' ' + y.toFixed(1) +
    ' H ' + (x + w - r).toFixed(1) +
    ' Q ' + (x + w).toFixed(1) + ' ' + y.toFixed(1) + ' ' + (x + w).toFixed(1) + ' ' + (y + r).toFixed(1) +
    ' V ' + (y + h).toFixed(1) + ' Z';
}

/* The prior period as a dotted ghost, aligned point-for-point with the
 * current period. Dots mean "another time", a state, not a category. */
function drawGhost(svg, ghost, { xOf, yOf, scale, color }) {
  if (!ghost || !ghost.rows || !ghost.rows.length) return;
  const vi = columnIndex(ghost.columns, 'value');
  if (vi < 0) return;
  let d = '';
  ghost.rows.forEach((row, i) => {
    const v = Number(row[vi]);
    if (!Number.isFinite(v)) return;
    const y = Math.max(PAD.top, Math.min(yOf(scale.min), yOf(v)));
    d += (d ? ' L ' : 'M ') + xOf(i).toFixed(1) + ' ' + y.toFixed(1);
  });
  if (!d) return;
  const path = svgEl('path', {
    d, fill: 'none', 'stroke-width': 1.5, 'stroke-linecap': 'round',
    'stroke-dasharray': '2 4', class: 'icor-sqlv-ghost',
  });
  path.setAttribute('stroke', color);
  svg.appendChild(path);
}

function renderLineChart(parentEl, table, tile, extras) {
  const xIdx = columnIndex(table.columns, tile.x);
  const seriesNames = tile.y.filter((c) => columnIndex(table.columns, c) >= 0);
  const seriesIdx = seriesNames.map((c) => columnIndex(table.columns, c));
  if (xIdx < 0 || seriesIdx.length === 0 || table.rows.length === 0) {
    parentEl.createDiv({ cls: 'icor-sqlv-empty', text: 'No rows to draw.' });
    return;
  }
  const values = [];
  for (const row of table.rows) for (const i of seriesIdx) { const v = Number(row[i]); if (Number.isFinite(v)) values.push(v); }
  const ghost = extras && extras.ghost;
  if (ghost && ghost.rows) {
    const vi = columnIndex(ghost.columns || [], 'value');
    if (vi >= 0) for (const row of ghost.rows) { const v = Number(row[vi]); if (Number.isFinite(v)) values.push(v); }
  }
  /* A snug axis: a heart rate line living between 60 and 90 should use the
   * whole plot, not hover above an empty run down to zero. */
  const scale = niceScale(Math.min(...values), Math.max(...values), 5);
  const svg = chartFrame(parentEl);
  const xLabels = table.rows.map((r) => r[xIdx]);
  const { plotW, plotH } = drawAxes(svg, scale, xLabels);
  const n = table.rows.length;
  const xOf = (i) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;

  const palette = seriesPaletteFor(seriesIdx.length);
  seriesIdx.forEach((colIdx, s) => {
    let d = '';
    table.rows.forEach((row, i) => {
      const v = Number(row[colIdx]);
      if (!Number.isFinite(v)) return;
      d += (d ? ' L ' : 'M ') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1);
    });
    if (!d) return;
    /* Ruled, not drawn: this surface measures. */
    const path = svgEl('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    path.setAttribute('stroke', palette[s]);
    svg.appendChild(path);
  });
  if (ghost) drawGhost(svg, ghost, { xOf, yOf, scale, color: palette[0] });

  /* Hover: the pen points. A solid marker guide, marker dots on the
   * hovered points, and the values on a small chip. */
  const guide = svgEl('line', { y1: PAD.top, y2: PAD.top + plotH, class: 'icor-sqlv-guide', visibility: 'hidden' });
  const chip = svgEl('rect', { class: 'icor-sqlv-readout-chip', rx: 4, height: 18, visibility: 'hidden' });
  const readout = svgEl('text', { class: 'icor-sqlv-readout', visibility: 'hidden' });
  const dots = seriesIdx.map(() => {
    const dot = svgEl('circle', { r: 3, class: 'icor-sqlv-hover-dot', visibility: 'hidden' });
    svg.appendChild(dot);
    return dot;
  });
  svg.appendChild(guide);
  svg.appendChild(chip);
  svg.appendChild(readout);
  const hover = svgEl('rect', { x: PAD.left, y: PAD.top, width: plotW, height: plotH, fill: 'transparent' });
  svg.appendChild(hover);
  hover.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * CHART_W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - PAD.left) / plotW) * (n - 1))));
    const x = xOf(i);
    guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.setAttribute('visibility', 'visible');
    const parts = [String(xLabels[i])];
    seriesIdx.forEach((colIdx, s) => {
      const v = Number(table.rows[i][colIdx]);
      if (Number.isFinite(v)) {
        parts.push(seriesNames[s] + ' ' + formatNumber(v) + (tile.unit ? ' ' + tile.unit : ''));
        dots[s].setAttribute('cx', x); dots[s].setAttribute('cy', yOf(v)); dots[s].setAttribute('visibility', 'visible');
      } else {
        dots[s].setAttribute('visibility', 'hidden');
      }
    });
    readout.textContent = parts.join('  ·  ');
    const flip = x > CHART_W / 2;
    readout.setAttribute('x', flip ? x - 10 : x + 10);
    readout.setAttribute('y', PAD.top + 12);
    readout.setAttribute('text-anchor', flip ? 'end' : 'start');
    readout.setAttribute('visibility', 'visible');
    const textW = typeof readout.getComputedTextLength === 'function'
      ? readout.getComputedTextLength() : readout.textContent.length * 6;
    chip.setAttribute('width', Math.ceil(textW) + 12);
    chip.setAttribute('x', flip ? x - 16 - textW : x + 4);
    chip.setAttribute('y', PAD.top);
    chip.setAttribute('visibility', 'visible');
  });
  hover.addEventListener('mouseleave', () => {
    guide.setAttribute('visibility', 'hidden');
    chip.setAttribute('visibility', 'hidden');
    readout.setAttribute('visibility', 'hidden');
    for (const dot of dots) dot.setAttribute('visibility', 'hidden');
  });
  legendFor(parentEl, seriesNames, palette);
}

function renderBarChart(parentEl, table, tile, extras) {
  const xIdx = columnIndex(table.columns, tile.x);
  const seriesNames = tile.y.filter((c) => columnIndex(table.columns, c) >= 0);
  const seriesIdx = seriesNames.map((c) => columnIndex(table.columns, c));
  if (xIdx < 0 || seriesIdx.length === 0 || table.rows.length === 0) {
    parentEl.createDiv({ cls: 'icor-sqlv-empty', text: 'No rows to draw.' });
    return;
  }
  const stacked = tile.stack && seriesIdx.length > 1;
  let top = 0;
  if (stacked) {
    for (const segs of stackRows(table.rows, seriesIdx)) top = Math.max(top, segs[segs.length - 1][1]);
  } else {
    for (const row of table.rows) for (const i of seriesIdx) top = Math.max(top, Number(row[i]) || 0);
  }
  const scale = niceScale(0, top, 5);
  const svg = chartFrame(parentEl);
  const xLabels = table.rows.map((r) => r[xIdx]);
  const { plotW, plotH } = drawAxes(svg, scale, xLabels);
  const n = table.rows.length;
  const slot = plotW / n;
  const gap = Math.min(4, slot * 0.2);
  const yOf = (v) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const titleOf = (rowI, s, v) =>
    String(xLabels[rowI]) + ' · ' + seriesNames[s] + ' ' + formatNumber(v) + (tile.unit ? ' ' + tile.unit : '');

  const palette = seriesPaletteFor(seriesIdx.length);
  const ghost = extras && extras.ghost;
  if (stacked) {
    const stacks = stackRows(table.rows, seriesIdx);
    stacks.forEach((segs, rowI) => {
      const x = PAD.left + rowI * slot + gap / 2;
      const w = Math.max(1, slot - gap);
      segs.forEach(([lo, hi], s) => {
        if (hi <= lo) return;
        /* Segments separated by 1px of tile ground, not by stroke. */
        const yTop = yOf(hi);
        const pixelH = Math.max(0.5, yOf(lo) - yTop - (s < segs.length - 1 ? 0 : 0));
        const isTopmost = segs.slice(s + 1).every(([l2, h2]) => h2 <= l2);
        const inset = isTopmost ? 0 : 1;
        const bar = svgEl('rect', {
          x: x.toFixed(1), y: (yTop + inset).toFixed(1),
          width: w.toFixed(1), height: Math.max(0.5, pixelH - inset).toFixed(1),
        });
        bar.setAttribute('fill', palette[s]);
        const t = svgEl('title', {});
        t.textContent = titleOf(rowI, s, hi - lo);
        bar.appendChild(t);
        svg.appendChild(bar);
      });
    });
  } else {
    const inner = Math.max(1, (slot - gap) / seriesIdx.length);
    /* Flat tops when narrow, a 4px round at wide bars. */
    const r = inner >= 8 ? Math.min(4, inner / 2) : 0;
    table.rows.forEach((row, rowI) => {
      seriesIdx.forEach((colIdx, s) => {
        const v = Number(row[colIdx]) || 0;
        if (v <= 0) return;
        const x = PAD.left + rowI * slot + gap / 2 + s * inner;
        const h = Math.max(0.5, yOf(0) - yOf(v));
        const bar = svgEl('path', { d: barPath(x, yOf(v), inner, h, r) });
        bar.setAttribute('fill', palette[s]);
        const t = svgEl('title', {});
        t.textContent = titleOf(rowI, s, v);
        bar.appendChild(t);
        svg.appendChild(bar);
      });
    });
  }
  if (ghost) {
    const xOfBar = (i) => PAD.left + i * slot + slot / 2;
    drawGhost(svg, ghost, { xOf: xOfBar, yOf, scale, color: 'var(--sqlv-fg-dim)' });
  }
  legendFor(parentEl, seriesNames, palette);
}

function renderStatTile(parentEl, table, tile, extras) {
  const { value, caption } = statOf(table, tile);
  const wrap = parentEl.createDiv({ cls: 'icor-sqlv-stat' });
  if (value === null || value === undefined) {
    wrap.createDiv({ cls: 'icor-sqlv-stat-value', text: 'no data' });
    return;
  }
  const line = wrap.createDiv({ cls: 'icor-sqlv-stat-value' });
  line.createSpan({ text: formatNumber(typeof value === 'string' ? value : Number(value)) });
  if (tile.unit) line.createSpan({ cls: 'icor-sqlv-stat-unit', text: ' ' + tile.unit });
  /* The comparison badge: the triangle points where the number went; the
   * color says whether that direction is good FOR THIS metric. */
  if (extras && extras.ghost && extras.ghost.rows && extras.ghost.rows.length) {
    const prev = extras.ghost.rows[0][0];
    const badge = deltaBadge(value, prev, extras.favorable);
    if (badge) {
      const cls = badge.good === null ? 'is-flat' : (badge.good ? 'is-good' : 'is-bad');
      const pill = line.createSpan({ cls: 'icor-sqlv-delta ' + cls });
      pill.createSpan({ text: (badge.direction === 'up' ? '▲ ' : badge.direction === 'down' ? '▼ ' : '') + badge.label });
      pill.setAttribute('aria-label', 'Compared with the ' + (extras.compare === 'last_year' ? 'same period last year' : 'previous period') + ': ' + badge.label);
      pill.setAttribute('title', 'vs ' + formatNumber(Number(prev)) + (tile.unit ? ' ' + tile.unit : ''));
    }
  }
  if (caption) wrap.createDiv({ cls: 'icor-sqlv-stat-caption', text: caption });
}

function renderResultTable(parentEl, table, { maxRows } = {}) {
  const cap = maxRows || 200;
  const scroller = parentEl.createDiv({ cls: 'icor-sqlv-table-scroll' });
  const t = scroller.createEl('table', { cls: 'icor-sqlv-table' });
  const head = t.createEl('thead').createEl('tr');
  for (const col of table.columns) head.createEl('th', { text: col });
  const body = t.createEl('tbody');
  for (const row of table.rows.slice(0, cap)) {
    const tr = body.createEl('tr');
    row.forEach((v, i) => {
      const td = tr.createEl('td', { text: v === null || v === undefined ? '' : String(v) });
      if (typeof v === 'number') td.addClass('icor-sqlv-num');
    });
  }
  if (table.rows.length > cap) {
    parentEl.createDiv({ cls: 'icor-sqlv-note', text: 'Showing the first ' + cap + ' of ' + table.rows.length + ' rows.' });
  }
  return scroller;
}

function renderTile(tileEl, tileSpec, table, extras) {
  if (tileSpec.title) tileEl.createDiv({ cls: 'icor-sqlv-tile-title', text: tileSpec.title });
  const body = tileEl.createDiv({ cls: 'icor-sqlv-tile-body' });
  if (tileSpec.viz === 'stat') renderStatTile(body, table, tileSpec, extras);
  else if (tileSpec.viz === 'line') renderLineChart(body, table, tileSpec, extras);
  else if (tileSpec.viz === 'bar') renderBarChart(body, table, tileSpec, extras);
  else renderResultTable(body, table, { maxRows: 50 });
}

/* ---------------------------------------------------- the browser view -- */

class SqliteBrowserView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.allowNoFile = true;
    this.navigation = true;
    this.dbPath = null;
    this.tables = [];
    this.counts = new Map();
    this.active = null;
    this.tab = 'data';
    this.page = 0;
    this.sortCol = null;
    this.sortDir = 'asc';
    this.filters = {};
    this.filtersVisible = false;
    this.focusFilters = false;
    this.funnelEl = null;
    this.consoleSql = '';
    this.consoleResult = null;
    this.engineInfo = null;
  }

  getViewType() { return VIEW_BROWSER; }
  getIcon() { return 'database'; }
  getDisplayText() { return this.file ? this.file.name : 'SQLite browser'; }
  canAcceptExtension(ext) { return DB_EXTS.has(String(ext).toLowerCase()); }

  async onLoadFile(file) {
    await this.setDatabase(file.path);
  }

  async onUnloadFile() {
    this.dbPath = null;
    this.tables = [];
    this.counts.clear();
    this.active = null;
  }

  async setDatabase(dbPath) {
    this.dbPath = dbPath;
    this.tables = [];
    this.counts.clear();
    this.active = null;
    this.page = 0;
    this.sortCol = null;
    this.filters = {};
    this.consoleResult = null;
    this.engineInfo = await this.plugin.query.engineFor(dbPath);
    if (this.engineInfo.engine) {
      try {
        const res = await this.plugin.query.query(dbPath,
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
        this.tables = res.rows.map(([name, type]) => ({ name, type }));
        if (this.tables.length) this.active = this.tables[0].name;
      } catch (e) {
        this.engineInfo = { engine: null, reason: e.message };
      }
    }
    this.render();
    this.fillCounts();
  }

  async fillCounts() {
    const dbPath = this.dbPath;
    for (const t of this.tables) {
      if (this.dbPath !== dbPath) return;
      if (this.counts.has(t.name)) continue;
      try {
        const res = await this.plugin.query.query(dbPath, buildCountQuery(t.name));
        this.counts.set(t.name, res.rows.length ? Number(res.rows[0][0]) : 0);
      } catch (e) {
        this.counts.set(t.name, null);
      }
      this.renderRailCounts();
    }
  }

  async onOpen() {
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('icor-sqlv-root');
    /* INKLINE's plugin-owned control boundary: inside a subtree carrying
     * data-ink-plugin the theme's element-level input and button skins
     * stand down, and this plugin owns its own controls. Other themes see
     * the explicit resets in styles.css. */
    root.setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');

    if (!this.dbPath) {
      const empty = root.createDiv({ cls: 'icor-sqlv-blank' });
      empty.createDiv({ text: 'Open a database to browse it.' });
      const btn = empty.createEl('button', { text: 'List the databases in this vault' });
      btn.addEventListener('click', () => new DatabaseIndexModal(this.plugin, (path) => this.openDb(path)).open());
      return;
    }

    const header = root.createDiv({ cls: 'icor-sqlv-header' });
    header.createSpan({ cls: 'icor-sqlv-header-name', text: baseName(this.dbPath) });
    const sub = [];
    if (this.engineInfo && this.engineInfo.size !== undefined) sub.push(formatBytes(this.engineInfo.size));
    if (this.engineInfo && this.engineInfo.engine === 'cli') sub.push('read-only, sqlite3');
    if (this.engineInfo && this.engineInfo.engine === 'wasm') sub.push('read-only, in memory');
    header.createSpan({ cls: 'icor-sqlv-header-sub', text: sub.join(' · ') });

    if (!this.engineInfo || !this.engineInfo.engine) {
      root.createDiv({ cls: 'icor-sqlv-error', text: (this.engineInfo && this.engineInfo.reason) || 'This database cannot be opened here.' });
      return;
    }

    const split = root.createDiv({ cls: 'icor-sqlv-split' });
    this.railEl = split.createDiv({ cls: 'icor-sqlv-rail' });
    this.mainEl = split.createDiv({ cls: 'icor-sqlv-main' });
    this.renderRail();
    this.renderMain();
  }

  renderRail() {
    const rail = this.railEl;
    rail.empty();
    rail.createDiv({ cls: 'icor-sqlv-rail-heading', text: 'Tables' });
    this.rowEls = new Map();
    for (const t of this.tables) {
      const row = rail.createDiv({ cls: 'icor-sqlv-rail-row' + (t.name === this.active ? ' is-active' : '') });
      row.createSpan({ cls: 'icor-sqlv-rail-name', text: t.name + (t.type === 'view' ? ' (view)' : '') });
      const count = row.createSpan({ cls: 'icor-sqlv-rail-count', text: this.countLabel(t.name) });
      this.rowEls.set(t.name, count);
      row.addEventListener('click', () => {
        this.active = t.name;
        this.page = 0;
        this.sortCol = null;
        this.filters = {};
        this.renderRail();
        this.renderMain();
      });
    }
    if (!this.tables.length) rail.createDiv({ cls: 'icor-sqlv-note', text: 'No tables.' });

    rail.createDiv({ cls: 'icor-sqlv-rail-heading', text: 'Databases in this vault' });
    for (const db of this.plugin.vaultDatabases()) {
      const row = rail.createDiv({ cls: 'icor-sqlv-rail-row' + (db.path === this.dbPath ? ' is-active' : '') });
      row.createSpan({ cls: 'icor-sqlv-rail-name', text: db.path });
      row.createSpan({ cls: 'icor-sqlv-rail-count', text: formatBytes(db.size) });
      if (db.path !== this.dbPath) row.addEventListener('click', () => this.openDb(db.path));
    }
  }

  countLabel(name) {
    if (!this.counts.has(name)) return '…';
    const n = this.counts.get(name);
    return n === null ? '?' : formatNumber(n);
  }

  renderRailCounts() {
    if (!this.rowEls) return;
    for (const [name, el] of this.rowEls) el.setText(this.countLabel(name));
  }

  async openDb(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.leaf.openFile(file);
    else await this.setDatabase(path);
  }

  hasActiveFilters() {
    return Object.values(this.filters || {}).some((v) => v !== '' && v !== null && v !== undefined);
  }

  /* Keep the funnel's dot honest after a filter changes without redrawing
   * the whole tab bar. */
  renderFunnelState() {
    if (!this.funnelEl) return;
    if (this.hasActiveFilters()) this.funnelEl.classList.add('has-filters');
    else this.funnelEl.classList.remove('has-filters');
  }

  renderMain() {
    const main = this.mainEl;
    main.empty();
    const tabs = main.createDiv({ cls: 'icor-sqlv-tabs' });
    for (const [id, label] of [['data', 'Data'], ['schema', 'Schema'], ['sql', 'SQL console']]) {
      const b = tabs.createEl('button', { text: label, cls: this.tab === id ? 'is-active' : '' });
      b.addEventListener('click', () => { this.tab = id; this.renderMain(); });
    }
    if (this.tab === 'data') {
      /* The funnel: filters live behind it, so the table at rest is just a
       * header and its rows. An accent dot says filters are active even
       * while the row is hidden, so a hidden filter never hides data
       * silently. */
      tabs.createDiv({ cls: 'icor-sqlv-tabs-spacer' });
      const funnel = tabs.createEl('button', { cls: 'icor-sqlv-funnel' + (this.hasActiveFilters() ? ' has-filters' : '') });
      this.funnelEl = funnel;
      setIcon(funnel, 'filter');
      funnel.setAttribute('aria-label', this.filtersVisible ? 'Hide the filter row' : 'Show the filter row');
      funnel.setAttribute('title', (this.filtersVisible ? 'Hide filters' : 'Filter columns') + (this.hasActiveFilters() ? ' (filters are active)' : ''));
      funnel.setAttribute('aria-pressed', this.filtersVisible ? 'true' : 'false');
      funnel.addEventListener('click', () => {
        this.filtersVisible = !this.filtersVisible;
        this.focusFilters = this.filtersVisible;
        this.renderMain();
      });
    }
    this.bodyEl = main.createDiv({ cls: 'icor-sqlv-body' });
    if (this.tab === 'data') this.renderData();
    else if (this.tab === 'schema') this.renderSchema();
    else this.renderConsole();
  }

  async renderData() {
    const body = this.bodyEl;
    body.empty();
    if (!this.active) { body.createDiv({ cls: 'icor-sqlv-note', text: 'No table selected.' }); return; }
    const pageSize = this.plugin.settings.pageSize;
    const sql = buildBrowseQuery(this.active, {
      filters: this.filters, sortCol: this.sortCol, sortDir: this.sortDir,
      limit: pageSize, offset: this.page * pageSize,
    });
    let res;
    try {
      res = await this.plugin.query.query(this.dbPath, sql);
    } catch (e) {
      body.createDiv({ cls: 'icor-sqlv-error', text: e.message });
      return;
    }
    if (this.tab !== 'data') return;
    body.empty();

    const scroller = body.createDiv({ cls: 'icor-sqlv-table-scroll icor-sqlv-grow' });
    const t = scroller.createEl('table', { cls: 'icor-sqlv-table' });
    const thead = t.createEl('thead');
    const headRow = thead.createEl('tr');
    for (const col of res.columns) {
      const th = headRow.createEl('th');
      const btn = th.createEl('button', { cls: 'icor-sqlv-sort' });
      btn.createSpan({ cls: 'icor-sqlv-sort-label', text: col });
      if (this.sortCol === col) btn.createSpan({ cls: 'icor-sqlv-sort-mark', text: this.sortDir === 'asc' ? '▴' : '▾' });
      btn.setAttribute('aria-label', 'Sort by ' + col);
      /* The full name survives a narrow column. */
      btn.setAttribute('title', col);
      btn.addEventListener('click', () => {
        if (this.sortCol === col) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        else { this.sortCol = col; this.sortDir = 'asc'; }
        this.page = 0;
        this.renderData();
      });
    }
    if (this.filtersVisible) {
      const filterRow = thead.createEl('tr', { cls: 'icor-sqlv-filter-row' });
      let firstInput = null;
      for (const col of res.columns) {
        const th = filterRow.createEl('th');
        const input = th.createEl('input', { type: 'text', cls: 'icor-sqlv-filter', value: this.filters[col] || '' });
        if (!firstInput) firstInput = input;
        input.setAttribute('placeholder', 'filter');
        input.setAttribute('aria-label', 'Filter ' + col);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            this.filters[col] = input.value.trim();
            this.page = 0;
            this.renderData();
            this.renderFunnelState();
          }
        });
      }
      if (this.focusFilters && firstInput && typeof firstInput.focus === 'function') {
        this.focusFilters = false;
        firstInput.focus();
      }
    }
    const tbody = t.createEl('tbody');
    for (const row of res.rows) {
      const tr = tbody.createEl('tr');
      row.forEach((v) => {
        const td = tr.createEl('td', { text: v === null || v === undefined ? '' : String(v) });
        if (typeof v === 'number') td.addClass('icor-sqlv-num');
      });
    }
    if (!res.rows.length) body.createDiv({ cls: 'icor-sqlv-note', text: 'No rows match.' });

    const pager = body.createDiv({ cls: 'icor-sqlv-pager' });
    const prev = pager.createEl('button', { text: 'Previous' });
    prev.disabled = this.page === 0;
    prev.addEventListener('click', () => { this.page = Math.max(0, this.page - 1); this.renderData(); });
    const info = pager.createSpan({ cls: 'icor-sqlv-pager-info', text: 'Rows ' + (this.page * pageSize + 1) + ' to ' + (this.page * pageSize + res.rows.length) });
    const next = pager.createEl('button', { text: 'Next' });
    next.disabled = res.rows.length < pageSize;
    next.addEventListener('click', () => { this.page += 1; this.renderData(); });
    if (Object.values(this.filters).some((v) => v)) {
      const clear = pager.createEl('button', { text: 'Clear filters' });
      clear.addEventListener('click', () => { this.filters = {}; this.page = 0; this.renderData(); this.renderFunnelState(); });
    }
    /* Total, filled in when the count comes back. */
    this.plugin.query.query(this.dbPath, buildCountQuery(this.active, { filters: this.filters }))
      .then((c) => {
        if (this.tab !== 'data' || !c.rows.length) return;
        info.setText('Rows ' + (this.page * pageSize + (res.rows.length ? 1 : 0)) + ' to ' + (this.page * pageSize + res.rows.length) + ' of ' + formatNumber(Number(c.rows[0][0])));
      })
      .catch(() => { /* the page already shows without a total */ });
  }

  async renderSchema() {
    const body = this.bodyEl;
    body.empty();
    if (!this.active) { body.createDiv({ cls: 'icor-sqlv-note', text: 'No table selected.' }); return; }
    try {
      const cols = await this.plugin.query.query(this.dbPath, 'PRAGMA table_info(' + quoteIdent(this.active) + ')');
      body.createDiv({ cls: 'icor-sqlv-section-title', text: 'Columns of ' + this.active });
      renderResultTable(body, cols, { maxRows: 500 });
      const idx = await this.plugin.query.query(this.dbPath, 'PRAGMA index_list(' + quoteIdent(this.active) + ')');
      if (idx.rows.length) {
        body.createDiv({ cls: 'icor-sqlv-section-title', text: 'Indexes' });
        const nameIdx = columnIndex(idx.columns, 'name');
        const uniqueIdx = columnIndex(idx.columns, 'unique');
        const listing = { columns: ['index', 'columns', 'unique'], rows: [] };
        for (const row of idx.rows) {
          const indexName = row[nameIdx];
          const info = await this.plugin.query.query(this.dbPath, 'PRAGMA index_info(' + quoteIdent(indexName) + ')');
          const colNameIdx = columnIndex(info.columns, 'name');
          listing.rows.push([indexName, info.rows.map((r) => r[colNameIdx]).join(', '), row[uniqueIdx] ? 'yes' : 'no']);
        }
        renderResultTable(body, listing, { maxRows: 200 });
      }
    } catch (e) {
      body.createDiv({ cls: 'icor-sqlv-error', text: e.message });
    }
  }

  renderConsole() {
    const body = this.bodyEl;
    body.empty();
    const intro = body.createDiv({ cls: 'icor-sqlv-note' });
    intro.setText('Read-only SQL. One statement, starting with SELECT, WITH, PRAGMA or EXPLAIN. A SELECT with no LIMIT gets one of ' + this.plugin.settings.rowCap + ' rows.');
    const area = body.createEl('textarea', { cls: 'icor-sqlv-console' });
    area.value = this.consoleSql;
    area.setAttribute('rows', '5');
    area.setAttribute('placeholder', "SELECT * FROM " + (this.active ? quoteIdent(this.active) : 'my_table') + ' LIMIT 20');
    area.setAttribute('aria-label', 'SQL query');
    const bar = body.createDiv({ cls: 'icor-sqlv-console-bar' });
    const run = bar.createEl('button', { text: 'Run', cls: 'mod-cta' });
    const hint = bar.createSpan({ cls: 'icor-sqlv-note', text: Platform.isMacOS ? 'Cmd+Enter runs it' : 'Ctrl+Enter runs it' });
    const out = body.createDiv({ cls: 'icor-sqlv-console-out icor-sqlv-grow' });

    const execute = async () => {
      this.consoleSql = area.value;
      out.empty();
      run.disabled = true;
      try {
        const res = await this.plugin.query.query(this.dbPath, area.value, { cap: this.plugin.settings.rowCap });
        this.consoleResult = res;
        const meta = out.createDiv({ cls: 'icor-sqlv-console-meta' });
        meta.createSpan({ text: formatNumber(res.rows.length) + (res.rows.length === 1 ? ' row' : ' rows') + ' in ' + res.ms + ' ms' + (res.capped ? ', capped at ' + this.plugin.settings.rowCap : '') });
        const copy = meta.createEl('button', { text: 'Copy as CSV' });
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText(toCsv(res.columns, res.rows));
          new Notice('Copied ' + res.rows.length + ' rows as CSV.');
        });
        renderResultTable(out, res, { maxRows: this.plugin.settings.rowCap });
      } catch (e) {
        this.consoleResult = null;
        out.createDiv({ cls: 'icor-sqlv-error', text: e.message });
      }
      run.disabled = false;
    };
    run.addEventListener('click', execute);
    area.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); execute(); }
    });
    if (this.consoleResult) {
      const res = this.consoleResult;
      const meta = out.createDiv({ cls: 'icor-sqlv-console-meta' });
      meta.createSpan({ text: formatNumber(res.rows.length) + (res.rows.length === 1 ? ' row' : ' rows') + ' in ' + res.ms + ' ms' });
      renderResultTable(out, res, { maxRows: this.plugin.settings.rowCap });
    }
  }
}

/* -------------------------------------------------- the dashboards view -- */

class SqliteDashboardsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
    this.specs = [];
    this.errors = [];
    this.activeId = null;
    this.editMode = false;
    this.gridState = null;
    this.gridRO = null;
    this.dragging = false;
  }

  getViewType() { return VIEW_DASHBOARDS; }
  getIcon() { return 'bar-chart-3'; }
  getDisplayText() { return 'Dashboards'; }

  async onOpen() {
    try {
      await this.reload();
    } catch (e) {
      this.showFailure(e);
    }
  }

  async reload() {
    let { specs, errors } = await this.plugin.loadDashboardSpecs();
    /* An empty folder heals itself: seed the starters (a write happens
     * only for a file that is missing) and look again, so a view opened
     * before the first seeding does not stay empty. */
    if (!specs.length && !errors.length) {
      try {
        await this.plugin.ensureStarterFiles();
        ({ specs, errors } = await this.plugin.loadDashboardSpecs());
      } catch (e) {
        errors = [{ path: this.plugin.settings.dashboardFolder, reason: e.message }];
      }
    }
    this.specs = specs;
    this.errors = errors;
    if (!this.activeId || !this.specs.some((s) => s.id === this.activeId)) {
      this.activeId = this.specs.length ? this.specs[0].id : null;
    }
    this.render();
  }

  /* A dashboard is never allowed to fail into a blank pane. Whatever went
   * wrong is written into the view, in plain words plus the raw detail. */
  showFailure(e, host) {
    const el = (host || this.contentEl).createDiv({ cls: 'icor-sqlv-error' });
    el.createDiv({ text: 'The dashboards could not be drawn. This is a plugin problem, not a data problem.' });
    el.createDiv({ text: String((e && e.message) || e) });
    if (e && e.stack) el.createDiv({ cls: 'icor-sqlv-error-detail', text: String(e.stack).split('\n').slice(0, 4).join('\n') });
    console.error(safeLogLine('dashboards failed to render', e));
  }

  async saveAndRender(spec) {
    await this.plugin.saveDashboardSpec(spec);
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('icor-sqlv-root');
    /* INKLINE's plugin-owned control boundary: inside a subtree carrying
     * data-ink-plugin the theme's element-level input and button skins
     * stand down, and this plugin owns its own controls. Other themes see
     * the explicit resets in styles.css. */
    root.setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');
    const bar = root.createDiv({ cls: 'icor-sqlv-dash-bar' });
    if (this.specs.length) {
      const select = bar.createEl('select', { cls: 'dropdown' });
      select.setAttribute('aria-label', 'Dashboard');
      for (const spec of this.specs) {
        const opt = select.createEl('option', { text: spec.title });
        opt.value = spec.id;
        if (spec.id === this.activeId) opt.selected = true;
      }
      select.addEventListener('change', () => { this.activeId = select.value; this.render(); });
    }
    const newBtn = bar.createEl('button', { text: 'New dashboard' });
    newBtn.addEventListener('click', async () => {
      const spec = await this.plugin.createDashboard();
      this.activeId = spec.id;
      await this.reload();
    });
    const refresh = bar.createEl('button', { text: 'Refresh' });
    refresh.addEventListener('click', () => this.reload());

    for (const err of this.errors) {
      root.createDiv({ cls: 'icor-sqlv-error', text: err.path + ': ' + err.reason });
    }
    if (!this.specs.length) {
      const empty = root.createDiv({ cls: 'icor-sqlv-blank' });
      empty.createDiv({ text: 'No dashboards yet.' });
      const start = empty.createEl('button', { text: 'Create your first dashboard', cls: 'mod-cta' });
      start.addEventListener('click', async () => {
        const spec = await this.plugin.createDashboard();
        this.activeId = spec.id;
        await this.reload();
      });
      return;
    }
    const spec = this.specs.find((s) => s.id === this.activeId);
    if (spec) {
      /* Un-awaited on purpose so the frame paints first, but never allowed
       * to fail silently: a rejection lands in the view as text. */
      this.renderDashboard(root, spec).catch((e) => this.showFailure(e, root));
    }
  }

  async renderDashboard(root, spec) {
    const host = root.createDiv({ cls: 'icor-sqlv-dash' });
    this.renderHeader(host, spec);
    const status = host.createDiv({ cls: 'icor-sqlv-note icor-sqlv-dash-status' });
    const grid = host.createDiv({ cls: 'icor-sqlv-grid' });
    this.gridState = { spec, grid, cols: 0, cellH: 0, tileEls: [], layouts: [], addEl: null };
    this.setupGridGeometry();
    this.watchGridWidth();
    try {
      await this.renderDashboardInto(spec, status, grid);
    } catch (e) {
      this.showFailure(e, host);
    }
    this.placeAddTile();
  }

  /* Square-ish cells: the column count follows the pane width, the row
   * height follows the resulting cell width. */
  setupGridGeometry() {
    const gs = this.gridState;
    if (!gs) return;
    const width = gs.grid.clientWidth || 1080;
    gs.cols = colsForWidth(width);
    gs.cellH = Math.max(90, Math.floor((width - (gs.cols - 1) * GRID_GAP_PX) / gs.cols));
    gs.grid.style.gridTemplateColumns = 'repeat(' + gs.cols + ', minmax(0, 1fr))';
    gs.grid.style.gridAutoRows = gs.cellH + 'px';
  }

  watchGridWidth() {
    if (this.gridRO) { this.gridRO.disconnect(); this.gridRO = null; }
    if (typeof ResizeObserver === 'undefined' || !this.gridState) return;
    this.gridRO = new ResizeObserver(() => {
      const gs = this.gridState;
      if (!gs || this.dragging) return;
      const cols = colsForWidth(gs.grid.clientWidth || 1080);
      if (cols === gs.cols) return;
      this.setupGridGeometry();
      gs.layouts = normalizeLayout(gs.spec.tiles, gs.cols);
      this.applyGridDisplay();
      this.placeAddTile();
    });
    this.gridRO.observe(this.gridState.grid);
  }

  async onClose() {
    if (this.gridRO) { this.gridRO.disconnect(); this.gridRO = null; }
  }

  applyGridDisplay(preview) {
    const gs = this.gridState;
    if (!gs) return;
    const layouts = preview || gs.layouts;
    gs.tileEls.forEach((el, i) => {
      const l = layouts[i];
      if (!el || !l) return;
      el.style.gridColumn = (l.x + 1) + ' / span ' + l.w;
      el.style.gridRow = (l.y + 1) + ' / span ' + l.h;
    });
  }

  /* The + tile: only on an empty dashboard or in edit mode, in the first
   * free 2x1 slot. */
  placeAddTile() {
    const gs = this.gridState;
    if (!gs) return;
    if (gs.addEl) { if (gs.addEl.parentElement) gs.addEl.parentElement.removeChild(gs.addEl); gs.addEl = null; }
    if (!showAddTile(gs.spec.tiles.length, this.editMode)) return;
    const spot = findSpot(gs.layouts, { w: 2, h: 1 }, gs.cols);
    const add = gs.grid.createDiv({ cls: 'icor-sqlv-tile icor-sqlv-add-tile' });
    add.setAttribute('role', 'button');
    add.setAttribute('tabindex', '0');
    add.setAttribute('aria-label', 'Add a widget');
    add.style.gridColumn = (spot.x + 1) + ' / span ' + spot.w;
    add.style.gridRow = (spot.y + 1) + ' / span ' + spot.h;
    const plus = add.createDiv({ cls: 'icor-sqlv-add-plus' });
    setIcon(plus, 'plus');
    add.createDiv({ cls: 'icor-sqlv-add-text', text: 'Add widget' });
    const start = () => new WidgetFormModal(this.plugin, this, gs.spec, -1).open();
    add.addEventListener('click', start);
    add.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); start(); } });
    gs.addEl = add;
  }

  /* The dashboard header: the title, editable in place, and the global
   * range every widget set to "follow the dashboard" obeys. */
  renderHeader(host, spec) {
    const header = host.createDiv({ cls: 'icor-sqlv-dash-header' });
    const titleWrap = header.createDiv({ cls: 'icor-sqlv-dash-title' });
    const title = titleWrap.createEl('h2', { text: spec.title, cls: 'icor-sqlv-dash-title-text' });
    title.setAttribute('title', 'Click to rename');
    title.setAttribute('role', 'button');
    title.setAttribute('tabindex', '0');
    title.setAttribute('aria-label', 'Rename dashboard ' + spec.title);
    const startRename = () => {
      titleWrap.empty();
      const input = titleWrap.createEl('input', { type: 'text', cls: 'icor-sqlv-dash-title-input', value: spec.title });
      input.setAttribute('aria-label', 'Dashboard title');
      const commit = async () => {
        const next = input.value.trim();
        if (next && next !== spec.title) {
          spec.title = next;
          await this.saveAndRender(spec);
        } else {
          this.render();
        }
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); this.render(); }
      });
      input.addEventListener('blur', commit);
      input.focus();
      if (typeof input.select === 'function') input.select();
    };
    title.addEventListener('click', startRename);
    title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); startRename(); } });

    const range = header.createDiv({ cls: 'icor-sqlv-range' });
    range.createSpan({ cls: 'icor-sqlv-range-label', text: 'Range' });
    const select = range.createEl('select', { cls: 'dropdown' });
    select.setAttribute('aria-label', 'Time range for the whole dashboard');
    const current = spec.globalTimeframe || DEFAULT_GLOBAL_TIMEFRAME;
    for (const [key, label] of Object.entries(PRESET_LABELS)) {
      const opt = select.createEl('option', { text: label });
      opt.value = key;
      if (current.preset === key) opt.selected = true;
    }
    const customOpt = select.createEl('option', { text: 'Custom range' });
    customOpt.value = 'custom';
    if (current.from) customOpt.selected = true;
    const customWrap = range.createDiv({ cls: 'icor-sqlv-range-custom' });
    const buildCustom = () => {
      customWrap.empty();
      const from = customWrap.createEl('input', { type: 'date', value: current.from || '' });
      from.setAttribute('aria-label', 'From date');
      const to = customWrap.createEl('input', { type: 'date', value: current.to || '' });
      to.setAttribute('aria-label', 'To date');
      const apply = customWrap.createEl('button', { text: 'Apply' });
      apply.addEventListener('click', async () => {
        if (DATE_RE.test(from.value) && DATE_RE.test(to.value)) {
          spec.globalTimeframe = { from: from.value, to: to.value };
          await this.saveAndRender(spec);
        } else {
          new Notice('Pick both dates first.');
        }
      });
    };
    if (current.from) buildCustom();
    select.addEventListener('change', async () => {
      if (select.value === 'custom') { buildCustom(); return; }
      spec.globalTimeframe = { preset: select.value };
      await this.saveAndRender(spec);
    });

    const editBtn = header.createEl('button', { cls: 'icor-sqlv-edit-toggle' + (this.editMode ? ' is-on' : '') });
    setIcon(editBtn, this.editMode ? 'check' : 'pencil');
    editBtn.createSpan({ text: this.editMode ? 'Done' : 'Edit' });
    editBtn.setAttribute('aria-pressed', this.editMode ? 'true' : 'false');
    editBtn.setAttribute('aria-label', this.editMode ? 'Leave edit mode' : 'Edit this dashboard: move, resize, add and remove widgets');
    editBtn.addEventListener('click', () => {
      this.editMode = !this.editMode;
      this.render();
    });
  }

  /* Move by dragging the tile, resize by dragging the corner handle.
   * Pointer events, so mouse and touch behave the same; the CSS sets
   * touch-action: none on these surfaces so the pane does not scroll
   * while a widget is in hand. */
  attachEditHandles(tileEl, index) {
    const surface = tileEl.createDiv({ cls: 'icor-sqlv-drag-surface' });
    surface.setAttribute('aria-label', 'Drag to move this widget');
    surface.setAttribute('title', 'Drag to move');
    surface.addEventListener('pointerdown', (ev) => this.startDrag(ev, index, 'move', surface));
    const handle = tileEl.createDiv({ cls: 'icor-sqlv-resize-handle' });
    handle.setAttribute('aria-label', 'Drag to resize this widget');
    handle.setAttribute('title', 'Drag to resize');
    handle.addEventListener('pointerdown', (ev) => this.startDrag(ev, index, 'resize', handle));
  }

  startDrag(ev, index, mode, surface) {
    const gs = this.gridState;
    if (!this.editMode || !gs || this.dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.dragging = true;
    if (typeof surface.setPointerCapture === 'function') {
      try { surface.setPointerCapture(ev.pointerId); } catch (e) { /* capture is best effort */ }
    }
    const startX = ev.clientX;
    const startY = ev.clientY;
    const base = gs.layouts.map((l) => Object.assign({}, l));
    const origin = Object.assign({}, base[index]);
    const width = gs.grid.clientWidth || gs.cols * GRID_UNIT_PX;
    const cellW = width / gs.cols;
    const cellH = gs.cellH + GRID_GAP_PX;
    const tileEl = gs.tileEls[index];
    tileEl.classList.add('is-dragging');
    let placeholder = null;
    let hole = null;
    if (mode === 'move') {
      /* Two dashed states while a widget is in hand: the hole it left
       * behind (hairline) and the cell it would land in (marker). */
      hole = gs.grid.createDiv({ cls: 'icor-sqlv-drag-hole' });
      hole.style.gridColumn = (origin.x + 1) + ' / span ' + origin.w;
      hole.style.gridRow = (origin.y + 1) + ' / span ' + origin.h;
      placeholder = gs.grid.createDiv({ cls: 'icor-sqlv-drop-cell' });
    }
    let preview = base;

    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      const dCol = Math.round(dx / cellW);
      const dRow = Math.round(dy / cellH);
      const candidate = Object.assign({}, origin);
      if (mode === 'move') {
        candidate.x = origin.x + dCol;
        candidate.y = Math.max(0, origin.y + dRow);
      } else {
        candidate.w = Math.max(1, origin.w + dCol);
        candidate.h = Math.max(1, origin.h + dRow);
      }
      const next = base.map((l, j) => (j === index ? candidate : Object.assign({}, l)));
      preview = packLayout(next, gs.cols, index);
      this.applyGridDisplay(preview);
      if (mode === 'move') {
        /* The tile itself follows the pointer from its old cell; the
         * placeholder shows the exact cell it would land in. */
        const p = preview[index];
        placeholder.style.gridColumn = (p.x + 1) + ' / span ' + p.w;
        placeholder.style.gridRow = (p.y + 1) + ' / span ' + p.h;
        tileEl.style.gridColumn = (origin.x + 1) + ' / span ' + origin.w;
        tileEl.style.gridRow = (origin.y + 1) + ' / span ' + origin.h;
        tileEl.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      }
    };

    const cleanup = () => {
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', commit);
      surface.removeEventListener('pointercancel', cancel);
      tileEl.classList.remove('is-dragging');
      tileEl.style.transform = '';
      if (placeholder && placeholder.parentElement) placeholder.parentElement.removeChild(placeholder);
      if (hole && hole.parentElement) hole.parentElement.removeChild(hole);
      this.dragging = false;
    };

    const commit = async () => {
      cleanup();
      gs.layouts = preview;
      this.applyGridDisplay();
      this.placeAddTile();
      gs.spec.tiles.forEach((t, j) => { t.layout = Object.assign({}, gs.layouts[j]); });
      try {
        await this.plugin.saveDashboardSpec(gs.spec);
      } catch (e) {
        new Notice('The layout could not be saved: ' + e.message);
      }
    };

    const cancel = () => {
      cleanup();
      this.applyGridDisplay();
    };

    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', commit);
    surface.addEventListener('pointercancel', cancel);
  }

  /* Edit and remove, in the corner of every widget. */
  addTileActions(tileEl, spec, index) {
    const tile = spec.tiles[index];
    const actions = tileEl.createDiv({ cls: 'icor-sqlv-tile-actions' });
    const edit = actions.createEl('button', { cls: 'icor-sqlv-tile-action' });
    setIcon(edit, 'pencil');
    edit.setAttribute('aria-label', 'Edit this widget');
    edit.setAttribute('title', 'Edit');
    edit.addEventListener('click', () => {
      new WidgetFormModal(this.plugin, this, spec, index).open();
    });
    const remove = actions.createEl('button', { cls: 'icor-sqlv-tile-action' });
    setIcon(remove, 'trash-2');
    remove.setAttribute('aria-label', 'Remove this widget');
    remove.setAttribute('title', 'Remove');
    remove.addEventListener('click', () => {
      new ConfirmModal(this.plugin.app, {
        title: 'Remove this widget?',
        body: 'The widget "' + (tile.title || 'Untitled') + '" is removed from the dashboard. The data it showed is not touched.',
        cta: 'Remove',
        onConfirm: async () => {
          spec.tiles.splice(index, 1);
          await this.saveAndRender(spec);
        },
      }).open();
    });
  }

  async renderDashboardInto(spec, status, grid) {
    const cache = await this.plugin.readDashboardCache(spec);
    const engines = new Map();
    const engineOf = async (db) => {
      if (!engines.has(db)) engines.set(db, await this.plugin.query.engineFor(db));
      return engines.get(db);
    };
    const cachedTiles = [];
    let failed = 0;
    let fromCache = 0;
    const t0 = Date.now();
    const gs = this.gridState;
    gs.layouts = normalizeLayout(spec.tiles, gs.cols);

    for (let i = 0; i < spec.tiles.length; i++) {
      const tile = spec.tiles[i];
      status.setText('Running query ' + (i + 1) + ' of ' + spec.tiles.length + (tile.title ? ': ' + tile.title : '') + ' …');
      const tileEl = grid.createDiv({ cls: 'icor-sqlv-tile' + (tile.viz === 'stat' ? ' is-stat' : '') + (this.editMode ? ' is-editing' : '') });
      gs.tileEls[i] = tileEl;
      const l = gs.layouts[i];
      tileEl.style.gridColumn = (l.x + 1) + ' / span ' + l.w;
      tileEl.style.gridRow = (l.y + 1) + ' / span ' + l.h;
      if (this.editMode) {
        this.addTileActions(tileEl, spec, i);
        this.attachEditHandles(tileEl, i);
      }
      const db = tileDatabase(tile, spec);
      if (!db) {
        failed++;
        tileEl.createDiv({ cls: 'icor-sqlv-error', text: 'This widget names no database. Edit it and pick one.' });
        continue;
      }
      const choice = await engineOf(db);
      if (choice.engine) {
        try {
          const sql = tileSql(tile, spec);
          const res = await this.plugin.query.query(db, sql, { cap: 5000 });
          /* The comparison period rides as a second, twin query. */
          let ghost = null;
          if (tile.source && tile.compare && tile.compare !== 'none' && canCompare(tile, spec.globalTimeframe)) {
            const shift = tile.compare === 'last_year' ? 'year' : 'previous';
            const ghostRes = await this.plugin.query.query(db, sqlForWidget(tile, spec.globalTimeframe, shift), { cap: 5000 });
            ghost = { columns: ghostRes.columns, rows: ghostRes.rows };
          }
          const prepared = prepareTileForRender(tile, res);
          renderTile(tileEl, prepared.spec, prepared.table, { ghost, compare: tile.compare, favorable: tile.favorable });
          cachedTiles.push(Object.assign({}, tile, { columns: res.columns, rows: res.rows, ghost }));
          this.plugin.maybeWriteCatalog(db);
        } catch (e) {
          failed++;
          if (tile.title) tileEl.createDiv({ cls: 'icor-sqlv-tile-title', text: tile.title });
          tileEl.createDiv({ cls: 'icor-sqlv-error', text: e.message });
        }
        continue;
      }
      /* No engine for this database on this device: the desktop cache. */
      const cachedTile = cache && cache.tiles[i];
      if (cachedTile) {
        try {
          const prepared = prepareTileForRender(cachedTile, { columns: cachedTile.columns, rows: cachedTile.rows });
          renderTile(tileEl, prepared.spec, prepared.table, { ghost: cachedTile.ghost || null, compare: cachedTile.compare, favorable: cachedTile.favorable });
          tileEl.createDiv({ cls: 'icor-sqlv-note', text: 'Computed on desktop, ' + relativeTime(cache.computedAt) + '.' });
          fromCache++;
        } catch (e) {
          failed++;
          tileEl.createDiv({ cls: 'icor-sqlv-error', text: e.message });
        }
      } else {
        if (tile.title) tileEl.createDiv({ cls: 'icor-sqlv-tile-title', text: tile.title });
        tileEl.createDiv({ cls: 'icor-sqlv-note', text: (choice.reason || 'This database cannot be opened here.') + ' No cached result yet. Open this dashboard once on the desktop and sync.' });
      }
    }

    if (!spec.tiles.length) {
      status.setText('An empty dashboard. Add the first widget with the + tile.');
      return;
    }
    let line;
    if (failed) {
      line = failed + ' of ' + spec.tiles.length + ' widgets failed; the errors are shown in their tiles.';
    } else if (fromCache === spec.tiles.length) {
      line = 'Computed on desktop, ' + (cache ? relativeTime(cache.computedAt) : 'at an unknown time') + '.';
    } else if (fromCache > 0) {
      line = (spec.tiles.length - fromCache) + ' live, ' + fromCache + ' from the desktop cache.';
    } else {
      line = spec.tiles.length + (spec.tiles.length === 1 ? ' query' : ' queries') + ' in ' + (Date.now() - t0) + ' ms.';
    }
    /* The cache the phone renders from. Only a fully live, fully healthy
     * run is worth freezing; anything less would overwrite a good cache. */
    if (!failed && !fromCache && Platform.isDesktopApp) {
      try {
        await this.plugin.writeDashboardCache(spec, cachedTiles);
      } catch (e) {
        line += ' The cache could not be written: ' + e.message;
      }
    }
    status.setText(line);
  }
}

/* ------------------------------------------------------ builder modals -- */

/* A plain confirm dialog, so nothing ever falls back to window.confirm. */
class ConfirmModal extends Modal {
  constructor(app, { title, body, cta, onConfirm }) {
    super(app);
    this.opts = { title, body, cta, onConfirm };
  }
  onOpen() {
    this.titleEl.setText(this.opts.title);
    (this.modalEl || this.contentEl).setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');
    this.contentEl.empty();
    this.contentEl.createDiv({ text: this.opts.body });
    const bar = this.contentEl.createDiv({ cls: 'icor-sqlv-console-bar icor-sqlv-modal-bar' });
    const go = bar.createEl('button', { text: this.opts.cta, cls: 'mod-warning' });
    go.addEventListener('click', async () => { this.close(); await this.opts.onConfirm(); });
    const cancel = bar.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------- the widget form -- */

/* A cancelable delay with injected timers, so the preview debounce is a
 * pure mechanism the gates can drive with fake clocks. */
function makeDebounce(ms, schedule, cancel) {
  let handle = null;
  return {
    bump(fn) {
      if (handle !== null) cancel(handle);
      handle = schedule(() => { handle = null; fn(); }, ms);
    },
    stop() { if (handle !== null) { cancel(handle); handle = null; } },
  };
}

/* The shared searchable list (the 0.3.0 component, now standalone):
 * search on top for long lists, grouped rows, arrows and Enter. */
function searchList(body, { items, search = true, autofocus = true, placeholder = 'Type to narrow the list' }) {
  let input = null;
  if (search && items.length > 4) {
    input = body.createEl('input', { type: 'text', cls: 'icor-sqlv-wizard-search' });
    input.setAttribute('placeholder', placeholder);
    input.setAttribute('aria-label', placeholder);
  }
  const host = body.createDiv({ cls: 'icor-sqlv-wizard-listhost' });
  let active = -1;
  let visible = [];
  const draw = () => {
    host.empty();
    const needle = input ? input.value.trim() : '';
    visible = items.filter((item) => matchesNeedle(needle, item.label, item.detail));
    if (active >= visible.length) active = visible.length - 1;
    let lastGroup;
    let listEl = null;
    visible.forEach((item, i) => {
      if (item.group !== lastGroup || !listEl) {
        if (item.group && item.group !== lastGroup) host.createDiv({ cls: 'icor-sqlv-wizard-group', text: item.group });
        listEl = host.createDiv({ cls: 'icor-sqlv-wizard-list' });
        lastGroup = item.group;
      }
      const rowEl = listEl.createDiv({ cls: 'icor-sqlv-wizard-row' + (item.selected ? ' is-selected' : '') + (i === active ? ' is-keyboard' : '') });
      rowEl.setAttribute('role', 'button');
      rowEl.setAttribute('tabindex', '0');
      rowEl.createDiv({ cls: 'icor-sqlv-wizard-row-label', text: item.label });
      if (item.detail) rowEl.createDiv({ cls: 'icor-sqlv-wizard-row-detail', text: item.detail });
      const pick = () => item.onPick();
      rowEl.addEventListener('click', pick);
      rowEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    });
    if (!visible.length) host.createDiv({ cls: 'icor-sqlv-empty', text: 'Nothing matches.' });
  };
  if (input) {
    input.addEventListener('input', () => { active = -1; draw(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(visible.length - 1, active + 1); draw(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        const pick = visible[Math.max(0, active)] || visible[0];
        if (pick) pick.onPick();
      }
    });
  }
  draw();
  if (input && autofocus && typeof input.focus === 'function') input.focus();
  return { input };
}

/* THE WIDGET FORM. One settings page that reads top to bottom like a
 * sentence: which database, which table, which value, when, split by
 * what, narrowed how, added up how, compared with what, called what,
 * drawn how, how big, over which period. A live preview runs beside it
 * through the normal read-only engines, and only a green preview can
 * save. SQL is optional and folded away under Advanced; turning a
 * widget into plain SQL is a one-way door and says so. */
class WidgetFormModal extends Modal {
  constructor(plugin, view, spec, editIndex) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
    this.spec = spec;
    this.editIndex = editIndex;
    const existing = editIndex >= 0 ? spec.tiles[editIndex] : null;
    const src = existing && existing.source ? existing.source : null;
    this.state = {
      mode: existing && !existing.source ? 'sql' : 'form',
      database: (src && src.database) || spec.database || '',
      table: (src && src.table) || '',
      metric: (src && src.metric) || '',
      agg: (src && src.agg) || 'sum',
      series: (src && src.series) || '',
      timeColumn: (src && src.timeColumn) || '',
      timeframe: src ? (src.timeframe === undefined ? 'global' : src.timeframe) : 'global',
      filters: src && src.filters ? src.filters.map((f) => Object.assign({}, f)) : [],
      compare: (existing && existing.compare) || 'none',
      favorable: (existing && existing.favorable) || 'up',
      viz: existing ? existing.viz : 'line',
      stack: existing ? !!existing.stack : false,
      title: existing ? existing.title : '',
      unit: existing ? existing.unit : '',
      sizeKey: existing && existing.layout ? sizePresetOf(existing.layout) : (existing ? '' : 'medium'),
      sqlText: existing && existing.sql ? existing.sql : '',
      x: existing && existing.x ? existing.x : 'x',
      y: existing && existing.y && existing.y.length ? existing.y.join(', ') : 'value',
      advancedOpen: false,
    };
    this.schema = null;
    this.schemaFor = '';
    this.openPicker = '';
    this.previewState = 'stale';
    this.previewError = '';
    this.previewSeq = 0;
    this.debounce = makeDebounce(400, (fn, ms) => setTimeout(fn, ms), (h) => clearTimeout(h));
  }

  onOpen() {
    this.modalEl.addClass('icor-sqlv-wizard-modal');
    this.modalEl.addClass('icor-sqlv-form-modal');
    this.modalEl.setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');
    this.titleEl.setText(this.editIndex >= 0 ? 'Edit widget' : 'New widget');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('icor-sqlv-form');
    const panes = contentEl.createDiv({ cls: 'icor-sqlv-form-panes' });
    this.formEl = panes.createDiv({ cls: 'icor-sqlv-form-fields' });
    const side = panes.createDiv({ cls: 'icor-sqlv-form-side' });
    side.createDiv({ cls: 'icor-sqlv-wizard-group', text: 'Preview' });
    this.previewEl = side.createDiv({ cls: 'icor-sqlv-form-preview' });
    this.previewNote = side.createDiv({ cls: 'icor-sqlv-note' });
    const bar = contentEl.createDiv({ cls: 'icor-sqlv-console-bar icor-sqlv-modal-bar' });
    this.saveBtn = bar.createEl('button', { text: this.editIndex >= 0 ? 'Save widget' : 'Add widget', cls: 'mod-cta' });
    this.saveBtn.addEventListener('click', () => this.save());
    const cancel = bar.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    this.renderForm();
    this.touch();
  }

  onClose() {
    this.debounce.stop();
    this.contentEl.empty();
  }

  /* Any change makes the preview stale and re-arms the debounce. */
  touch() {
    this.previewState = nextPreviewState(this.previewState, 'change');
    this.syncGate();
    this.debounce.bump(() => this.runPreview());
  }

  syncGate() {
    if (!this.saveBtn) return;
    this.saveBtn.disabled = !canSave(this.previewState);
    if (this.previewNote) {
      if (this.previewState === 'ok') this.previewNote.setText('The preview ran. Save is open.');
      else if (this.previewState === 'running') this.previewNote.setText('Running the preview …');
      else if (this.previewState === 'error') this.previewNote.setText(this.previewError);
      else this.previewNote.setText('The preview runs after each change; a widget saves only after its preview worked.');
    }
  }

  async ensureSchema() {
    if (this.schema && this.schemaFor === this.state.database) return this.schema;
    this.schema = await this.plugin.schemaFor(this.state.database);
    this.schemaFor = this.state.database;
    return this.schema;
  }

  tableInfo() {
    return this.schema ? this.schema.tables.find((t) => t.name === this.state.table) : null;
  }

  /* The state as a tile, or a plain-words reason. */
  buildTile() {
    const s = this.state;
    if (s.mode === 'sql') {
      if (!s.sqlText.trim()) return { ok: false, reason: 'The SQL is empty.' };
      const gate = gateStatement(s.sqlText);
      if (!gate.ok) return { ok: false, reason: gate.reason };
      const y = s.y.split(',').map((v) => v.trim()).filter(Boolean);
      const tile = {
        title: s.title || 'SQL widget',
        sql: s.sqlText,
        viz: s.viz,
        x: s.x.trim(),
        y,
        unit: s.unit,
        stack: s.stack && y.length > 1,
      };
      if ((tile.viz === 'line' || tile.viz === 'bar') && (!tile.x || !y.length)) {
        return { ok: false, reason: 'A ' + tile.viz + ' chart needs the x column and at least one y column.' };
      }
      return { ok: true, tile };
    }
    if (!s.database) return { ok: false, reason: 'Pick a database first.' };
    if (!s.table) return { ok: false, reason: 'Pick a table.' };
    if (s.agg !== 'count' && !s.metric) return { ok: false, reason: 'Pick a value to measure.' };
    const filters = [];
    for (const row of s.filters) {
      if (!row.column) continue;
      if (!FILTER_OPS[row.op || 'eq'].noValue && (row.value === undefined || row.value === '')) {
        return { ok: false, reason: 'The filter on ' + row.column + ' still needs a value.' };
      }
      filters.push({ column: row.column, op: row.op || 'eq', value: row.value });
    }
    const source = {
      table: s.table,
      metric: s.agg === 'count' ? '' : s.metric,
      agg: s.agg,
      filters,
      series: s.series || undefined,
      timeColumn: s.timeColumn || undefined,
      timeframe: s.timeframe,
    };
    if (s.database && s.database !== this.spec.database) source.database = s.database;
    const viz = s.agg === 'latest' ? 'stat' : s.viz;
    const tile = {
      title: s.title || this.suggestedTitle(),
      viz,
      unit: s.unit,
      stack: s.stack && !!s.series && viz === 'bar',
      compare: s.series ? 'none' : s.compare,
      favorable: s.favorable,
      source,
    };
    if (viz !== 'stat' && !source.timeColumn && !source.groupBy) {
      return { ok: false, reason: 'A chart needs a date column. Pick one, or choose the stat widget.' };
    }
    const check = checkWidgetSource(source, viz, 'This widget');
    if (!check.ok) return check;
    source.filters = check.filters;
    return { ok: true, tile };
  }

  suggestedTitle() {
    const s = this.state;
    const eq = s.filters.find((f) => f.op === 'eq' && f.value);
    const what = eq ? eq.value : (s.agg === 'count' ? 'Rows' : s.metric);
    const how = s.agg === 'count' ? 'count' : (AGG_LABELS[s.agg] || '').toLowerCase();
    return what ? (what + (how && s.viz !== 'stat' ? ', ' + how : '')) : 'New widget';
  }

  async runPreview() {
    const seq = ++this.previewSeq;
    const built = this.buildTile();
    if (!built.ok) {
      this.previewState = 'error';
      this.previewError = built.reason;
      this.previewEl.empty();
      this.syncGate();
      return;
    }
    this.previewState = nextPreviewState(this.previewState, 'run');
    this.syncGate();
    try {
      const tile = built.tile;
      const db = tileDatabase(tile, this.spec);
      const sql = tileSql(tile, this.spec.globalTimeframe ? this.spec : { globalTimeframe: DEFAULT_GLOBAL_TIMEFRAME });
      const res = await this.plugin.query.query(db, sql, { cap: 500 });
      let ghost = null;
      if (tile.source && tile.compare && tile.compare !== 'none' && canCompare(tile, this.spec.globalTimeframe)) {
        const shift = tile.compare === 'last_year' ? 'year' : 'previous';
        const ghostRes = await this.plugin.query.query(db, sqlForWidget(tile, this.spec.globalTimeframe, shift), { cap: 500 });
        ghost = { columns: ghostRes.columns, rows: ghostRes.rows };
      }
      if (seq !== this.previewSeq) return;
      this.previewEl.empty();
      const tileEl = this.previewEl.createDiv({ cls: 'icor-sqlv-tile is-preview' + (tile.viz === 'stat' ? ' is-stat' : '') });
      const prepared = prepareTileForRender(tile, res);
      renderTile(tileEl, prepared.spec, prepared.table, { ghost, compare: tile.compare, favorable: tile.favorable });
      if (!res.rows.length) this.previewEl.createDiv({ cls: 'icor-sqlv-note', text: 'The query ran but returned no rows. Check the filters and the period.' });
      this.previewState = nextPreviewState(this.previewState, 'ok');
      this.syncGate();
    } catch (e) {
      if (seq !== this.previewSeq) return;
      this.previewState = nextPreviewState(this.previewState, 'error');
      this.previewError = e.message;
      this.previewEl.empty();
      this.previewEl.createDiv({ cls: 'icor-sqlv-error', text: e.message });
      this.syncGate();
    }
  }

  /* ---------------------------------------------------- form fields -- */

  field(parent, { label, required, optional }) {
    const row = parent.createDiv({ cls: 'icor-sqlv-field' });
    const lab = row.createDiv({ cls: 'icor-sqlv-field-label' });
    lab.createSpan({ text: label });
    if (required) lab.createSpan({ cls: 'icor-sqlv-field-required', text: ' (required)' });
    if (optional) lab.createSpan({ cls: 'icor-sqlv-field-optional', text: ' (optional)' });
    return row;
  }

  /* A searchable picker that expands inline under its field. */
  pickerField(parent, { key, label, required, optional, valueText, placeholder, getItems }) {
    const row = this.field(parent, { label, required, optional });
    const btn = row.createEl('button', { cls: 'icor-sqlv-picker' + (valueText ? '' : ' is-empty') });
    btn.createSpan({ text: valueText || placeholder });
    btn.createSpan({ cls: 'icor-sqlv-picker-chev', text: '▾' });
    btn.setAttribute('aria-label', label + (valueText ? ': ' + valueText : ''));
    btn.setAttribute('aria-expanded', this.openPicker === key ? 'true' : 'false');
    btn.addEventListener('click', () => {
      this.openPicker = this.openPicker === key ? '' : key;
      this.renderForm();
    });
    if (this.openPicker === key) {
      const panel = row.createDiv({ cls: 'icor-sqlv-picker-panel' });
      panel.createDiv({ cls: 'icor-sqlv-note', text: 'Loading …' });
      Promise.resolve(getItems()).then((items) => {
        if (this.openPicker !== key) return;
        panel.empty();
        searchList(panel, { items });
      }).catch((e) => {
        panel.empty();
        panel.createDiv({ cls: 'icor-sqlv-error', text: e.message });
      });
    }
    return row;
  }

  nativeSelect(parent, { label, optional, options, value, onChange, ariaLabel }) {
    const row = this.field(parent, { label, optional });
    const select = row.createEl('select', { cls: 'dropdown' });
    select.setAttribute('aria-label', ariaLabel || label);
    for (const [val, text] of options) {
      const opt = select.createEl('option', { text });
      opt.value = val;
      if (val === value) opt.selected = true;
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  textInput(parent, { label, optional, value, placeholder, onInput, ariaLabel }) {
    const row = this.field(parent, { label, optional });
    const input = row.createEl('input', { type: 'text', cls: 'icor-sqlv-wizard-input', value: value || '' });
    if (placeholder) input.setAttribute('placeholder', placeholder);
    input.setAttribute('aria-label', ariaLabel || label);
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  pick(mutate) {
    mutate();
    this.openPicker = '';
    this.renderForm();
    this.touch();
  }

  renderForm() {
    const s = this.state;
    const form = this.formEl;
    form.empty();

    if (s.mode === 'sql') { this.renderSqlForm(form); return; }

    this.pickerField(form, {
      key: 'database', label: 'Database', required: true,
      valueText: s.database ? baseName(s.database) : '',
      placeholder: 'Pick a database',
      getItems: () => this.plugin.vaultDatabases().map((db) => ({
        label: baseName(db.path), detail: db.path + '  ·  ' + formatBytes(db.size),
        selected: db.path === s.database,
        onPick: () => this.pick(() => {
          if (s.database !== db.path) { s.table = ''; s.metric = ''; s.series = ''; s.timeColumn = ''; s.filters = []; this.schema = null; }
          s.database = db.path;
          this.openPicker = 'table';
        }),
      })),
    });

    if (s.database) {
      this.pickerField(form, {
        key: 'table', label: 'Table', required: true,
        valueText: s.table, placeholder: 'Pick a table',
        getItems: async () => (await this.ensureSchema()).tables.map((t) => ({
          label: t.name, detail: t.columns.length + ' columns',
          selected: t.name === s.table,
          onPick: () => this.pick(() => {
            if (s.table !== t.name) {
              s.metric = ''; s.series = ''; s.filters = [];
              s.timeColumn = guessTimeColumn(t.columns);
            }
            s.table = t.name;
          }),
        })),
      });
    }

    const table = this.tableInfo();
    if (s.table && table) {
      const numbers = table.columns.filter((c) => isNumericType(c.type));
      const texts = table.columns.filter((c) => isTextType(c.type));

      this.pickerField(form, {
        key: 'metric', label: 'Value', required: true,
        valueText: s.agg === 'count' ? 'Count rows' : s.metric,
        placeholder: 'What to measure',
        getItems: () => {
          const items = [{
            label: 'Count rows', detail: 'how many rows match',
            selected: s.agg === 'count',
            onPick: () => this.pick(() => { s.metric = ''; s.agg = 'count'; }),
          }];
          for (const c of numbers) {
            items.push({
              group: 'Numbers', label: c.name, detail: c.type,
              selected: s.agg !== 'count' && s.metric === c.name,
              onPick: () => this.pick(() => { s.metric = c.name; if (s.agg === 'count') s.agg = 'sum'; }),
            });
          }
          return items;
        },
      });

      this.pickerField(form, {
        key: 'timeColumn', label: 'Date', optional: true,
        valueText: s.timeColumn, placeholder: 'Which column holds the time',
        getItems: () => [{
          label: 'None', detail: 'no time axis',
          selected: !s.timeColumn,
          onPick: () => this.pick(() => { s.timeColumn = ''; s.compare = 'none'; }),
        }].concat(table.columns.filter((c) => isTextType(c.type) || /INT/i.test(String(c.type))).map((c) => ({
          label: c.name,
          selected: s.timeColumn === c.name,
          onPick: () => this.pick(() => { s.timeColumn = c.name; }),
        }))),
      });

      this.pickerField(form, {
        key: 'series', label: 'Dimension', optional: true,
        valueText: s.series ? 'By ' + s.series : '',
        placeholder: 'Split into series',
        getItems: () => [{
          label: 'No split',
          selected: !s.series,
          onPick: () => this.pick(() => { s.series = ''; }),
        }].concat(texts.map((c) => ({
          label: 'By ' + c.name,
          selected: s.series === c.name,
          onPick: () => this.pick(() => { s.series = c.name; s.compare = 'none'; if (s.viz === 'stat') s.viz = 'bar'; }),
        }))),
      });

      this.renderFilters(form, table, texts);

      this.nativeSelect(form, {
        label: 'Add it up', options: Object.entries(AGG_LABELS).map(([k, v]) => [k, v]),
        value: s.agg,
        onChange: (v) => { s.agg = v; if (v === 'latest') s.viz = 'stat'; this.renderForm(); this.touch(); },
      });

      if (s.timeColumn && !s.series) {
        this.nativeSelect(form, {
          label: 'Compare with', optional: true,
          options: Object.entries(COMPARE_LABELS).map(([k, v]) => [k, v]),
          value: s.compare,
          onChange: (v) => { s.compare = v; this.renderForm(); this.touch(); },
        });
        if (s.compare !== 'none') {
          this.nativeSelect(form, {
            label: 'Good direction',
            options: [['up', 'Up is good'], ['down', 'Down is good (weight, resting heart rate)']],
            value: s.favorable,
            onChange: (v) => { s.favorable = v; this.touch(); },
            ariaLabel: 'Which direction counts as good for this metric',
          });
        }
      }

      this.textInput(form, {
        label: 'Widget name', value: s.title, placeholder: this.suggestedTitle(),
        onInput: (v) => { s.title = v; this.touch(); },
      });

      const vizOptions = s.agg === 'latest' ? [['stat', 'One big number']]
        : [['line', 'Line chart'], ['bar', 'Bar chart'], ['stat', 'One big number']];
      this.nativeSelect(form, {
        label: 'Chart type', options: vizOptions, value: s.viz,
        onChange: (v) => { s.viz = v; this.renderForm(); this.touch(); },
      });
      if (s.series && s.viz === 'bar') {
        const stackRow = form.createDiv({ cls: 'icor-sqlv-wizard-toggle' });
        const cb = stackRow.createEl('input', { type: 'checkbox' });
        cb.checked = s.stack;
        cb.setAttribute('id', 'icor-sqlv-stack');
        const lbl = stackRow.createEl('label', { text: 'Stack the series on top of each other' });
        lbl.setAttribute('for', 'icor-sqlv-stack');
        cb.addEventListener('change', () => { s.stack = cb.checked; this.touch(); });
      }

      this.nativeSelect(form, {
        label: 'Size', options: [['', 'Keep as is']].concat(Object.entries(SIZE_PRESETS).map(([k, p]) => [k, p.label])).slice(this.editIndex >= 0 ? 0 : 1),
        value: s.sizeKey,
        onChange: (v) => { s.sizeKey = v; },
        ariaLabel: 'Widget size on the grid',
      });

      this.nativeSelect(form, {
        label: 'Time frame',
        options: [['global', 'Follow the dashboard']].concat(Object.entries(PRESET_LABELS).map(([k, v]) => [k, v])),
        value: s.timeframe === 'global' ? 'global' : (s.timeframe && s.timeframe.preset) || 'global',
        onChange: (v) => { s.timeframe = v === 'global' ? 'global' : { preset: v }; this.touch(); },
        ariaLabel: 'Time frame for this widget',
      });

      this.textInput(form, {
        label: 'Unit', optional: true, value: s.unit, placeholder: 'kg, steps, kcal …',
        onInput: (v) => { s.unit = v; this.touch(); },
      });

      this.renderAdvanced(form);
    }
  }

  renderFilters(form, table, texts) {
    const s = this.state;
    const wrap = this.field(form, { label: 'Filter data', optional: true });
    const rows = wrap.createDiv({ cls: 'icor-sqlv-filter-rows' });
    s.filters.forEach((row, i) => {
      const rowEl = rows.createDiv({ cls: 'icor-sqlv-filter-row-edit' });
      const col = rowEl.createEl('select', { cls: 'dropdown' });
      col.setAttribute('aria-label', 'Filter column');
      for (const c of table.columns) {
        const opt = col.createEl('option', { text: c.name });
        opt.value = c.name;
        if (c.name === row.column) opt.selected = true;
      }
      col.addEventListener('change', () => { row.column = col.value; row.value = ''; this.renderForm(); this.touch(); });
      const op = rowEl.createEl('select', { cls: 'dropdown' });
      op.setAttribute('aria-label', 'Filter condition');
      for (const [key, def] of Object.entries(FILTER_OPS)) {
        const opt = op.createEl('option', { text: def.label });
        opt.value = key;
        if (key === (row.op || 'eq')) opt.selected = true;
      }
      op.addEventListener('change', () => { row.op = op.value; this.renderForm(); this.touch(); });
      if (!FILTER_OPS[row.op || 'eq'].noValue) {
        const isCategory = texts.some((c) => c.name === row.column) && (row.op || 'eq') === 'eq';
        if (isCategory) {
          const btn = rowEl.createEl('button', { cls: 'icor-sqlv-picker' + (row.value ? '' : ' is-empty') });
          btn.createSpan({ text: row.value || 'Pick a value' });
          btn.createSpan({ cls: 'icor-sqlv-picker-chev', text: '▾' });
          btn.setAttribute('aria-label', 'Filter value for ' + row.column);
          btn.addEventListener('click', () => {
            this.openPicker = this.openPicker === 'filter-' + i ? '' : 'filter-' + i;
            this.renderForm();
          });
        } else {
          const input = rowEl.createEl('input', { type: 'text', cls: 'icor-sqlv-wizard-input', value: row.value === undefined ? '' : String(row.value) });
          input.setAttribute('aria-label', 'Filter value for ' + row.column);
          input.addEventListener('input', () => { row.value = input.value; this.touch(); });
        }
      }
      const remove = rowEl.createEl('button', { cls: 'icor-sqlv-tile-action icor-sqlv-filter-remove' });
      setIcon(remove, 'x');
      remove.setAttribute('aria-label', 'Remove this filter');
      remove.addEventListener('click', () => { s.filters.splice(i, 1); this.renderForm(); this.touch(); });
      if (this.openPicker === 'filter-' + i) {
        const panel = rows.createDiv({ cls: 'icor-sqlv-picker-panel' });
        panel.createDiv({ cls: 'icor-sqlv-note', text: 'Loading values …' });
        this.plugin.distinctValues(s.database, s.table, row.column).then((values) => {
          if (this.openPicker !== 'filter-' + i) return;
          panel.empty();
          if (values.truncated) panel.createDiv({ cls: 'icor-sqlv-note', text: 'Showing the first 200 values.' });
          searchList(panel, {
            items: values.values.map((v) => ({
              label: v, selected: row.value === v,
              onPick: () => this.pick(() => { row.value = v; }),
            })),
          });
        }).catch((e) => {
          /* No value list on this device: degrade to typed entry, with the
           * column named, instead of a dead end. */
          if (this.openPicker !== 'filter-' + i) return;
          panel.empty();
          panel.createDiv({ cls: 'icor-sqlv-note', text: e.message });
          const input = panel.createEl('input', { type: 'text', cls: 'icor-sqlv-wizard-input', value: row.value || '' });
          input.setAttribute('placeholder', 'Exact value of ' + row.column);
          input.setAttribute('aria-label', 'Exact value of ' + row.column);
          const use = panel.createEl('button', { text: 'Use this value' });
          use.addEventListener('click', () => this.pick(() => { row.value = input.value; }));
          if (typeof input.focus === 'function') input.focus();
        });
      }
    });
    const add = wrap.createEl('button', { text: '+ Add filter', cls: 'icor-sqlv-add-filter' });
    add.addEventListener('click', () => {
      s.filters.push({ column: (texts[0] && texts[0].name) || (table.columns[0] && table.columns[0].name) || '', op: 'eq', value: '' });
      this.renderForm();
    });
    if (s.filters.length > 1) wrap.createDiv({ cls: 'icor-sqlv-note', text: 'All filter rows must match (AND).' });
  }

  renderAdvanced(form) {
    const s = this.state;
    const adv = form.createDiv({ cls: 'icor-sqlv-advanced' });
    const toggle = adv.createEl('button', { cls: 'icor-sqlv-advanced-toggle', text: (s.advancedOpen ? '▾' : '▸') + ' Advanced' });
    toggle.setAttribute('aria-expanded', s.advancedOpen ? 'true' : 'false');
    toggle.addEventListener('click', () => { s.advancedOpen = !s.advancedOpen; this.renderForm(); });
    if (!s.advancedOpen) return;
    const built = this.buildTile();
    const pre = adv.createEl('pre', { cls: 'icor-sqlv-sql-pre' });
    pre.setText(built.ok ? tileSql(built.tile, this.spec) : 'The form is not complete yet: ' + built.reason);
    const note = adv.createDiv({ cls: 'icor-sqlv-note', text: 'This is the query the widget runs, read-only. Editing it as SQL is a one-way door: the form fields go away for this widget and only the SQL stays.' });
    const convert = adv.createEl('button', { text: 'Edit as SQL' });
    if (s.series) {
      convert.disabled = true;
      adv.createDiv({ cls: 'icor-sqlv-note', text: 'A widget split into series cannot convert: its chart needs the split the form provides. Remove the dimension first.' });
    }
    convert.addEventListener('click', () => {
      if (!built.ok) { new Notice('Finish the form first: ' + built.reason); return; }
      new ConfirmModal(this.plugin.app, {
        title: 'Edit as SQL?',
        body: 'This widget becomes a plain SQL query. The form (value, date, filters, aggregation) goes away for it and cannot be brought back; the SQL stays editable. Nothing happens to your data.',
        cta: 'Edit as SQL',
        onConfirm: () => {
          s.mode = 'sql';
          s.sqlText = tileSql(built.tile, this.spec);
          s.viz = built.tile.viz;
          s.x = built.tile.viz === 'stat' ? '' : 'x';
          s.y = 'value';
          s.title = s.title || built.tile.title;
          this.renderForm();
          this.touch();
        },
      }).open();
    });
    void note;
  }

  renderSqlForm(form) {
    const s = this.state;
    form.createDiv({ cls: 'icor-sqlv-note', text: 'This widget is written in SQL. It runs read-only: one statement, starting with SELECT, WITH, PRAGMA or EXPLAIN.' });
    this.textInput(form, {
      label: 'Widget name', value: s.title, placeholder: 'SQL widget',
      onInput: (v) => { s.title = v; this.touch(); },
    });
    const sqlField = this.field(form, { label: 'SQL', required: true });
    const area = sqlField.createEl('textarea', { cls: 'icor-sqlv-console' });
    area.value = s.sqlText;
    area.setAttribute('rows', '6');
    area.setAttribute('aria-label', 'SQL query');
    area.addEventListener('input', () => { s.sqlText = area.value; this.touch(); });
    this.nativeSelect(form, {
      label: 'Chart type',
      options: [['line', 'Line chart'], ['bar', 'Bar chart'], ['stat', 'One big number'], ['table', 'Table']],
      value: s.viz,
      onChange: (v) => { s.viz = v; this.renderForm(); this.touch(); },
    });
    if (s.viz === 'line' || s.viz === 'bar') {
      this.textInput(form, { label: 'X column', value: s.x, onInput: (v) => { s.x = v; this.touch(); } });
      this.textInput(form, { label: 'Y columns (comma-separated)', value: s.y, onInput: (v) => { s.y = v; this.touch(); } });
    }
    this.textInput(form, {
      label: 'Unit', optional: true, value: s.unit, placeholder: 'kg, steps, kcal …',
      onInput: (v) => { s.unit = v; this.touch(); },
    });
    this.nativeSelect(form, {
      label: 'Size', options: [['', 'Keep as is']].concat(Object.entries(SIZE_PRESETS).map(([k, p]) => [k, p.label])).slice(this.editIndex >= 0 ? 0 : 1),
      value: s.sizeKey,
      onChange: (v) => { s.sizeKey = v; },
      ariaLabel: 'Widget size on the grid',
    });
  }

  async save() {
    if (!canSave(this.previewState)) return;
    const built = this.buildTile();
    if (!built.ok) { new Notice(built.reason); return; }
    const tile = built.tile;
    const existing = this.editIndex >= 0 ? this.spec.tiles[this.editIndex] : null;
    if (this.state.sizeKey && SIZE_PRESETS[this.state.sizeKey]) {
      const p = SIZE_PRESETS[this.state.sizeKey];
      if (existing && existing.layout) {
        tile.layout = { x: existing.layout.x, y: existing.layout.y, w: p.w, h: p.h };
      } else {
        const layouts = normalizeLayout(this.spec.tiles, GRID_MAX_COLS);
        tile.layout = findSpot(layouts, { w: p.w, h: p.h }, GRID_MAX_COLS);
      }
    } else if (existing && existing.layout) {
      tile.layout = existing.layout;
    }
    if (this.editIndex >= 0) this.spec.tiles[this.editIndex] = tile;
    else this.spec.tiles.push(tile);
    this.close();
    await this.view.saveAndRender(this.spec);
  }
}

/* --------------------------------------------------- the index modal -- */

class DatabaseIndexModal extends Modal {
  constructor(plugin, onPick) {
    super(plugin.app);
    this.plugin = plugin;
    this.onPick = onPick || null;
  }

  onOpen() {
    this.titleEl.setText('Databases in this vault');
    (this.modalEl || this.contentEl).setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');
    const { contentEl } = this;
    contentEl.empty();
    const dbs = this.plugin.vaultDatabases();
    if (!dbs.length) {
      contentEl.createDiv({ text: 'No SQLite databases found. Files ending in .db, .sqlite or .sqlite3 would be listed here.' });
      return;
    }
    const list = contentEl.createDiv({ cls: 'icor-sqlv-index' });
    for (const db of dbs) {
      const row = list.createDiv({ cls: 'icor-sqlv-index-row' });
      const label = row.createDiv({ cls: 'icor-sqlv-index-path' });
      label.createSpan({ text: baseName(db.path) });
      label.createDiv({ cls: 'icor-sqlv-index-folder', text: db.path });
      row.createSpan({ cls: 'icor-sqlv-index-size', text: formatBytes(db.size) });
      row.addEventListener('click', async () => {
        this.close();
        if (this.onPick) this.onPick(db.path);
        else await this.plugin.openBrowserFor(db.path);
      });
    }
  }

  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------- the migration modal -- */

class MigrationModal extends Modal {
  constructor(plugin, plan) {
    super(plugin.app);
    this.plugin = plugin;
    this.plan = plan;
  }

  onOpen() {
    this.titleEl.setText('Move databases into ' + this.plan.targetRoot);
    (this.modalEl || this.contentEl).setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');
    const { contentEl } = this;
    contentEl.empty();

    if (!this.plan.moves.length) {
      contentEl.createDiv({ text: 'Nothing to move. Every database is already inside ' + this.plan.targetRoot + ', or its name is already taken there.' });
      for (const skip of this.plan.skips) {
        contentEl.createDiv({ cls: 'icor-sqlv-note', text: skip.path + ': ' + skip.reason });
      }
      return;
    }

    contentEl.createDiv({ text: 'These files would move. Nothing is copied, deleted or changed; the files are only moved.' });
    const list = contentEl.createDiv({ cls: 'icor-sqlv-move-list' });
    for (const move of this.plan.moves) {
      const row = list.createDiv({ cls: 'icor-sqlv-move-row' });
      row.createDiv({ text: move.from + '  →  ' + move.to });
      for (const side of move.sidecars) {
        row.createDiv({ cls: 'icor-sqlv-note', text: side.from + '  →  ' + side.to + '  (moves with its database)' });
      }
    }
    for (const skip of this.plan.skips) {
      contentEl.createDiv({ cls: 'icor-sqlv-note', text: 'Stays put: ' + skip.path + ' (' + skip.reason + ')' });
    }
    const warn = contentEl.createDiv({ cls: 'icor-sqlv-warn' });
    warn.createDiv({ text: 'Moving changes where the databases live. Tools outside Obsidian that connect to them may need the new path. No data is lost or modified.' });
    warn.createDiv({ text: 'Close other apps that are using a database before moving it.' });

    const bar = contentEl.createDiv({ cls: 'icor-sqlv-console-bar' });
    const go = bar.createEl('button', { text: 'Move ' + this.plan.moves.length + (this.plan.moves.length === 1 ? ' database' : ' databases'), cls: 'mod-cta' });
    const cancel = bar.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    go.addEventListener('click', async () => {
      go.disabled = true;
      const results = await executeMigration(this.plugin.app.vault.adapter, this.plan);
      contentEl.empty();
      this.titleEl.setText('Done');
      const moved = results.filter((r) => r.ok);
      const skipped = results.filter((r) => !r.ok);
      contentEl.createDiv({ text: moved.length + (moved.length === 1 ? ' database moved.' : ' databases moved.') });
      for (const r of moved) contentEl.createDiv({ cls: 'icor-sqlv-note', text: r.from + '  →  ' + r.to });
      for (const r of skipped) contentEl.createDiv({ cls: 'icor-sqlv-note', text: 'Skipped ' + r.from + ': ' + r.reason });
      const closeBtn = contentEl.createEl('button', { text: 'Close' });
      closeBtn.addEventListener('click', () => this.close());
    });
  }

  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------- the settings -- */

class SqliteViewerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const engineLine = () => {
      if (!Platform.isDesktopApp) return 'On this device the plugin reads databases with its built-in engine, up to the size cap below.';
      const cli = this.plugin.query.cli;
      if (cli && cli.ok) return 'The sqlite3 command line tool was found (version ' + cli.version + '). Big databases work at full speed.';
      return 'The sqlite3 command line tool was not found. Databases up to the size cap below still work with the built-in engine. On macOS sqlite3 ships with the system; set the path below if it lives somewhere unusual.';
    };
    containerEl.createDiv({ cls: 'icor-sqlv-note', text: engineLine() });

    new Setting(containerEl)
      .setName('Rows per page')
      .setDesc('How many rows the data browser shows at a time.')
      .addText((t) => t.setValue(String(this.plugin.settings.pageSize)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 5 && n <= 1000) { this.plugin.settings.pageSize = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl)
      .setName('Size cap for the built-in engine (MB)')
      .setDesc('The built-in engine loads the whole database file into memory. Files over this cap are not loaded; their dashboards render from the desktop cache instead.')
      .addText((t) => t.setValue(String(this.plugin.settings.mobileCapMb)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 4000) { this.plugin.settings.mobileCapMb = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl)
      .setName('Dashboards folder')
      .setDesc('Where dashboard files live. Each dashboard is one JSON file.')
      .addText((t) => t.setValue(this.plugin.settings.dashboardFolder).onChange(async (v) => {
        this.plugin.settings.dashboardFolder = normalizePath(v || DEFAULT_SETTINGS.dashboardFolder);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Dashboard cache folder')
      .setDesc('Where computed dashboard results are stored so phones and tablets can show them without opening the database.')
      .addText((t) => t.setValue(this.plugin.settings.cacheFolder).onChange(async (v) => {
        this.plugin.settings.cacheFolder = normalizePath(v || DEFAULT_SETTINGS.cacheFolder);
        await this.plugin.saveSettings();
      }));

    if (Platform.isDesktopApp) {
      new Setting(containerEl)
        .setName('Path to sqlite3')
        .setDesc('Leave empty to use the system sqlite3. Set a full path if yours lives somewhere unusual. Careful: the plugin runs whatever this points to, so only point it at a sqlite3 binary you trust.')
        .addText((t) => t.setValue(this.plugin.settings.sqlite3Path).onChange(async (v) => {
          const check = checkSqlite3Path(v);
          if (!check.ok) { new Notice(check.reason); return; }
          if (!check.empty) {
            const deps = this.plugin.query.deps;
            if (deps && deps.fsx && !deps.fsx.existsSync(check.path)) {
              new Notice('Nothing exists at that path. The setting was not saved.');
              return;
            }
          }
          this.plugin.settings.sqlite3Path = check.empty ? '' : check.path;
          await this.plugin.saveSettings();
          await this.plugin.query.detect();
        }));

      new Setting(containerEl)
        .setName('Query timeout (seconds)')
        .setDesc('A query that runs longer than this is stopped.')
        .addText((t) => t.setValue(String(this.plugin.settings.queryTimeoutSec)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 600) { this.plugin.settings.queryTimeoutSec = n; await this.plugin.saveSettings(); }
        }));
    }

    new Setting(containerEl)
      .setName('Include category values in the mobile catalog')
      .setDesc('Off by default. When on, the desktop writes the distinct values of small text columns (200 or fewer values, for example every metric name, workout type or category) into a plain JSON file in the cache folder, so phones can offer them as a picker. That file syncs with the vault and is readable and searchable like any note. Leave this off if a database holds values you would not put in a note, for example health or contact details; the phone picker then asks you to type the value instead.')
      .addToggle((t) => t.setValue(this.plugin.settings.catalogIncludeValues).onChange(async (v) => {
        this.plugin.settings.catalogIncludeValues = v;
        if (this.plugin.catalogged) this.plugin.catalogged.clear();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Open JSON files in the vault')
      .setDesc('When on, clicking a .json file opens it in this plugin: a dashboard file opens as its dashboard, any other JSON in a clean read-only viewer. Turn it off if another plugin should own .json files. Takes effect after the plugin reloads.')
      .addToggle((t) => t.setValue(this.plugin.settings.openJsonFiles).onChange(async (v) => {
        this.plugin.settings.openJsonFiles = v;
        await this.plugin.saveSettings();
        new Notice('Reload the plugin (or restart Obsidian) to apply this.');
      }));

    new Setting(containerEl).setName('Tidy up').setHeading();
    new Setting(containerEl)
      .setName('Move databases into ' + this.plugin.settings.dataFolder)
      .setDesc('Finds every database outside ' + this.plugin.settings.dataFolder + ' and offers to move it there, together with any -wal and -shm files that belong to it. You see the exact list first, and nothing moves until you confirm.')
      .addButton((b) => b.setButtonText('Review and move').onClick(() => {
        const dbs = this.plugin.vaultDatabases();
        const existing = new Set(this.app.vault.getFiles().map((f) => f.path));
        const plan = planMigration(dbs.map((d) => d.path), existing, this.plugin.settings.dataFolder);
        new MigrationModal(this.plugin, plan).open();
      }));
  }
}

/* ------------------------------------------------------ the JSON view -- */

/* Obsidian does not open .json files natively, so this plugin claims the
 * extension. A file that parses as a dashboard spec opens as its dashboard
 * in the builder; every other JSON gets a clean reader: pretty-printed,
 * read-only, monospace, with a copy button and an explicit switch to a
 * plain text editor that saves on blur or Cmd+S. A big file is shown in
 * part instead of freezing the pane. */
class JsonFileView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.allowNoFile = false;
    this.navigation = true;
    this.text = null;
    this.tooBig = false;
    this.editing = false;
  }

  getViewType() { return VIEW_JSON; }
  getIcon() { return 'braces'; }
  getDisplayText() { return this.file ? this.file.name : 'JSON'; }
  canAcceptExtension(ext) { return String(ext).toLowerCase() === 'json'; }

  async onLoadFile(file) {
    this.editing = false;
    this.tooBig = file.stat.size > JSON_RENDER_CAP;
    this.text = await this.app.vault.read(file);

    /* A dashboard spec does not belong in a raw reader: hand the leaf to
     * the builder, after this load settles. */
    if (!this.tooBig) {
      const parsed = parseDashboardSpec(this.text);
      if (parsed.ok) {
        const leaf = this.leaf;
        const id = parsed.spec.id;
        setTimeout(async () => {
          try {
            await leaf.setViewState({ type: VIEW_DASHBOARDS, active: true });
            const view = leaf.view;
            if (view && typeof view.reload === 'function') {
              view.activeId = id;
              await view.reload();
            }
          } catch (e) {
            console.error(safeLogLine('could not open the dashboard view', e));
          }
        }, 0);
        return;
      }
    }
    this.render();
  }

  async onUnloadFile() {
    this.text = null;
    this.editing = false;
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('icor-sqlv-root');
    root.setAttribute('data-ink-plugin', 'icor-for-life-sqlite-viewer');
    if (this.text === null) return;
    const host = root.createDiv({ cls: 'icor-sqlv-json' });
    const bar = host.createDiv({ cls: 'icor-sqlv-console-bar' });

    let parsed = null;
    let parseError = '';
    if (!this.tooBig) {
      try { parsed = JSON.parse(this.text); } catch (e) { parseError = e.message; }
    }

    if (this.editing) {
      const area = host.createEl('textarea', { cls: 'icor-sqlv-console icor-sqlv-json-editor' });
      area.value = this.text;
      area.setAttribute('aria-label', 'JSON text');
      const save = async () => {
        if (area.value === this.text) return;
        this.text = area.value;
        await this.app.vault.modify(this.file, this.text);
        new Notice('Saved ' + this.file.name + '.');
      };
      area.addEventListener('blur', save);
      area.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); save(); }
      });
      const done = bar.createEl('button', { text: 'Done editing', cls: 'mod-cta' });
      done.addEventListener('click', async () => { await save(); this.editing = false; this.render(); });
      if (typeof area.focus === 'function') area.focus();
      return;
    }

    const copy = bar.createEl('button', { text: 'Copy JSON' });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(this.text);
      new Notice('Copied ' + this.file.name + '.');
    });
    if (!this.tooBig) {
      const edit = bar.createEl('button', { text: 'Edit as text' });
      edit.addEventListener('click', () => { this.editing = true; this.render(); });
    }
    const note = bar.createSpan({ cls: 'icor-sqlv-note' });
    if (this.tooBig) {
      note.setText('A big file (' + formatBytes(this.text.length) + '). Showing the first part, read-only.');
    } else if (parseError) {
      note.setText('Not valid JSON: ' + parseError);
    } else {
      note.setText(formatBytes(this.text.length) + ', read-only');
    }

    const pre = host.createEl('pre', { cls: 'icor-sqlv-json-pre' });
    if (this.tooBig) {
      pre.setText(this.text.slice(0, JSON_SLICE) + '\n…');
    } else if (parsed !== null) {
      pre.setText(JSON.stringify(parsed, null, 2));
    } else {
      pre.setText(this.text);
    }
  }
}

/* ------------------------------------------------- the starter content -- */

const DASHBOARD_README = `---
title: Dashboards
doc_type: note
status: active
tags:
  - sqlite
  - dashboards
---

# Dashboards

Each JSON file in this folder is one dashboard for the ICOR for Life - SQLite
Viewer plugin. Open them with the "SQLite Viewer: Open dashboards" command or
the chart icon in the ribbon.

The easiest way to make a dashboard is the builder: open the dashboards
view, press "New dashboard", and add widgets with the + tile. The builder
writes these same files; editing them by hand stays fine.

## The file format

\`\`\`json
{
  "id": "my-dashboard",
  "title": "My Dashboard",
  "database": "07 Databases/example.db",
  "globalTimeframe": { "preset": "90d" },
  "tiles": [
    {
      "title": "Rows per day",
      "sql": "SELECT day, COUNT(*) AS rows FROM things GROUP BY day ORDER BY day",
      "viz": "line",
      "x": "day",
      "y": "rows",
      "unit": "rows"
    },
    {
      "title": "Daily steps",
      "viz": "bar",
      "unit": "steps",
      "source": {
        "table": "health_metric",
        "metric": "qty",
        "agg": "sum",
        "filter": { "column": "metric_name", "value": "step_count" },
        "timeColumn": "local_date",
        "timeframe": "global"
      }
    }
  ]
}
\`\`\`

- \`id\`: lowercase letters, digits and hyphens. Also names the cache file.
  Renaming the title is safe; the id stays.
- \`database\`: the path of the database inside the vault. A widget's
  \`source\` may carry its own \`database\` instead.
- \`globalTimeframe\`: the range the header picker shows. A preset
  (\`7d\`, \`30d\`, \`90d\`, \`12m\`, \`all\`) or \`{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}\`.
- A tile is either an \`sql\` tile or a built widget with a \`source\`.
- \`viz\`: \`line\`, \`bar\`, \`stat\` (one big number) or \`table\`
  (table only for SQL tiles).
- SQL tiles: \`x\` and \`y\` are column names from the query; \`y\` may be
  a list for a multi-series chart. \`stack\` stacks a bar chart.
- Built widgets: \`table\`, \`metric\` (a number column), \`agg\` (sum,
  avg, min, max, count, latest), optional \`filter\` (narrow the rows to
  one value of a category column), optional \`series\` (one line or bar
  per value of a column), optional \`groupBy\` (defaults to the time
  column), \`timeColumn\`, and \`timeframe\` (\`"global"\` follows the
  header picker; a preset or a from/to range is fixed). The plugin
  generates the SQL itself.
- \`unit\`: shown next to values, for example "kg" or "steps".
- \`layout\`: the widget's place on the grid, \`{"x":0,"y":0,"w":2,"h":2}\`
  in square cells. The edit mode (pencil button on the dashboard) writes
  this when you drag and resize; a widget without one gets a sensible
  default.

Only read queries run: one statement, starting with SELECT, WITH, PRAGMA or
EXPLAIN. The plugin never writes to a database.

## Phones and tablets

When a dashboard renders on the desktop, its results are saved under the
cache folder and synced like any note. A device that cannot open the
database itself shows the cached results, with a line saying when they were
computed. Small databases render live everywhere.
`;

const STARTER_DASHBOARDS = [
  {
    file: 'health-overview.json',
    spec: {
      id: 'health-overview',
      title: 'Health Overview',
      database: '07 Data/mypka-health.db',
      tiles: [
        {
          title: 'Latest body weight',
          viz: 'stat',
          unit: 'kg',
          y: 'weight_kg',
          sql: "SELECT ROUND(qty, 1) AS weight_kg, local_date FROM health_metric WHERE metric_name = 'weight_body_mass' ORDER BY local_date DESC, recorded_at_utc DESC LIMIT 1",
        },
        {
          title: 'Daily steps, last 90 days',
          viz: 'bar',
          x: 'local_date',
          y: 'steps',
          unit: 'steps',
          sql: "SELECT local_date, CAST(SUM(qty) AS INTEGER) AS steps FROM health_metric WHERE metric_name = 'step_count' AND local_date >= date((SELECT MAX(local_date) FROM health_metric WHERE metric_name = 'step_count'), '-90 day') GROUP BY local_date ORDER BY local_date",
        },
        {
          title: 'Heart rate, last 90 days',
          viz: 'line',
          x: 'local_date',
          y: ['resting', 'average'],
          unit: 'bpm',
          sql: "SELECT h.local_date AS local_date, (SELECT ROUND(AVG(m.qty), 1) FROM health_metric m WHERE m.metric_name = 'resting_heart_rate' AND m.local_date = h.local_date) AS resting, ROUND(AVG(h.hr_avg), 1) AS average FROM health_heart_rate h WHERE h.local_date >= date((SELECT MAX(local_date) FROM health_heart_rate), '-90 day') GROUP BY h.local_date ORDER BY h.local_date",
        },
        {
          title: 'Sleep by stage, last 30 days',
          viz: 'bar',
          stack: true,
          x: 'local_date',
          y: ['deep', 'core', 'rem', 'awake'],
          unit: 'hours',
          sql: "SELECT local_date, ROUND(deep_hr, 2) AS deep, ROUND(core_hr, 2) AS core, ROUND(rem_hr, 2) AS rem, ROUND(awake_hr, 2) AS awake FROM health_sleep WHERE local_date >= date((SELECT MAX(local_date) FROM health_sleep), '-30 day') ORDER BY local_date",
        },
        {
          title: 'Workout minutes per week, last 12 weeks',
          viz: 'bar',
          x: 'week',
          y: 'minutes',
          unit: 'min',
          sql: "SELECT strftime('%Y-W%W', local_date) AS week, CAST(SUM(duration_sec) / 60 AS INTEGER) AS minutes FROM health_workout WHERE local_date >= date((SELECT MAX(local_date) FROM health_workout), '-84 day') GROUP BY week ORDER BY week",
        },
        {
          title: 'Workout energy per week, last 12 weeks',
          viz: 'bar',
          x: 'week',
          y: 'kcal',
          unit: 'kcal',
          sql: "SELECT strftime('%Y-W%W', local_date) AS week, CAST(SUM(active_energy_kcal) AS INTEGER) AS kcal FROM health_workout WHERE local_date >= date((SELECT MAX(local_date) FROM health_workout), '-84 day') GROUP BY week ORDER BY week",
        },
      ],
    },
  },
  {
    file: 'engagement-overview.json',
    spec: {
      id: 'engagement-overview',
      title: 'Engagement Overview',
      database: '07 Data/engagement.db',
      tiles: [
        {
          title: 'Recommendations',
          viz: 'stat',
          y: 'total',
          sql: 'SELECT COUNT(*) AS total FROM engagement_posts',
        },
        {
          title: 'Posted',
          viz: 'stat',
          y: 'posted',
          sql: "SELECT COUNT(*) AS posted FROM engagement_posts WHERE status = 'posted'",
        },
        {
          title: 'Posted and skipped per day',
          viz: 'bar',
          stack: true,
          x: 'batch_id',
          y: ['posted', 'skipped', 'open'],
          sql: "SELECT batch_id, SUM(status = 'posted') AS posted, SUM(status = 'skipped') AS skipped, SUM(status = 'recommended') AS open FROM engagement_posts GROUP BY batch_id ORDER BY batch_id",
        },
        {
          title: 'By platform',
          viz: 'table',
          sql: "SELECT platform, COUNT(*) AS recommended, SUM(status = 'posted') AS posted, SUM(status = 'skipped') AS skipped FROM engagement_posts GROUP BY platform ORDER BY platform",
        },
      ],
    },
  },
  {
    file: 'youtube-overview.json',
    spec: {
      id: 'youtube-overview',
      title: 'YouTube Overview',
      database: '06 AI Team/AI Team Knowledge/Data/youtube-analytics.db',
      tiles: [
        {
          title: 'Views, latest window',
          viz: 'stat',
          y: 'views',
          sql: "SELECT views, period_start || ' to ' || period_end AS window FROM yt_channel_snapshots ORDER BY period_end DESC LIMIT 1",
        },
        {
          title: 'Net subscribers, latest window',
          viz: 'stat',
          y: 'net_subscribers',
          sql: 'SELECT subscribers_gained - subscribers_lost AS net_subscribers, period_start || \' to \' || period_end AS window FROM yt_channel_snapshots ORDER BY period_end DESC LIMIT 1',
        },
        {
          title: 'Views per snapshot window',
          viz: 'line',
          x: 'period_end',
          y: ['views'],
          sql: 'SELECT period_end, views FROM yt_channel_snapshots ORDER BY period_end',
        },
        {
          title: 'Top videos, latest snapshot',
          viz: 'table',
          sql: 'SELECT title, views, ROUND(avg_view_percentage, 1) AS avg_view_pct, likes, comments FROM yt_video_snapshots WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM yt_video_snapshots) ORDER BY views DESC LIMIT 10',
        },
      ],
    },
  },
];

/* ------------------------------------------------------- the plugin -- */

class IcorSqliteViewerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.adoptFoldersIfLegacy();
    this.query = new QueryService(this);
    this.query.detect();

    this.registerView(VIEW_BROWSER, (leaf) => new SqliteBrowserView(leaf, this));
    this.registerView(VIEW_DASHBOARDS, (leaf) => new SqliteDashboardsView(leaf, this));
    this.registerView(VIEW_JSON, (leaf) => new JsonFileView(leaf, this));
    try {
      this.registerExtensions(['db', 'sqlite', 'sqlite3'], VIEW_BROWSER);
    } catch (e) {
      new Notice('Another plugin already opens .db files. Use the "SQLite Viewer: List databases" command instead.');
    }
    if (this.settings.openJsonFiles) {
      try {
        this.registerExtensions(['json'], VIEW_JSON);
      } catch (e) {
        new Notice('Another plugin already opens .json files, so this plugin leaves them to it.');
      }
    }

    this.addRibbonIcon('bar-chart-3', 'Open dashboards', () => this.openDashboards());

    /* "New dashboard" next to New note and New folder in the folder menu.
     * Dashboards always land in the configured dashboards folder; a click
     * from somewhere else says so. */
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFolder)) return;
      menu.addItem((item) => {
        item.setTitle('New dashboard');
        item.setIcon('bar-chart-3');
        if (typeof item.setSection === 'function') item.setSection('action-primary');
        item.onClick(async () => {
          const spec = await this.createDashboard();
          const folder = this.settings.dashboardFolder;
          const near = file.path === folder || file.path === '/'
            || folder.startsWith(file.path + '/') || file.path.startsWith(folder + '/');
          if (!near) new Notice('New dashboard saved in ' + folder + '.');
          await this.openDashboards(spec.id);
        });
      });
    }));

    this.addCommand({ id: 'open-dashboards', name: 'Open dashboards', callback: () => this.openDashboards() });
    this.addCommand({
      id: 'new-dashboard',
      name: 'Create new dashboard',
      callback: async () => {
        const spec = await this.createDashboard();
        await this.openDashboards(spec.id);
      },
    });
    this.addCommand({ id: 'list-databases', name: 'List databases', callback: () => new DatabaseIndexModal(this).open() });
    this.addCommand({ id: 'open-browser', name: 'Open database browser', callback: () => this.openBrowserFor(null) });

    this.addSettingTab(new SqliteViewerSettingTab(this.app, this));

    /* Starter dashboards and the folder README, written once, only when
     * missing. The one write besides the dashboard cache. */
    this.app.workspace.onLayoutReady(() => { this.ensureStarterFiles().catch(() => {}); });
  }

  onunload() {
    if (this.query && this.query.wasm) this.query.wasm.closeAll();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /* The 0.5.0 rename: the default home moved from "07 Data" to
   * "07 Databases". A vault that still has the old folder and not the new
   * one keeps working against the old one, silently, for this session.
   * Nothing is written and nothing is created here. */
  async adoptFoldersIfLegacy() {
    const adapter = this.app.vault.adapter;
    const existsMap = {
      [this.settings.dataFolder]: await adapter.exists(this.settings.dataFolder),
      [LEGACY_DATA_FOLDER]: await adapter.exists(LEGACY_DATA_FOLDER),
    };
    const adopted = adoptLegacyFolders(this.settings, existsMap);
    if (adopted) Object.assign(this.settings, adopted);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  vaultDatabases() {
    return findDatabases(this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size })));
  }

  async openBrowserFor(dbPath) {
    const leaf = this.app.workspace.getLeaf(true);
    if (dbPath) {
      const file = this.app.vault.getAbstractFileByPath(dbPath);
      if (file instanceof TFile) { await leaf.openFile(file); return; }
    }
    await leaf.setViewState({ type: VIEW_BROWSER, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openDashboards(activeId) {
    const existing = this.app.workspace.getLeavesOfType(VIEW_DASHBOARDS);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      /* A revealed view re-reads the folder. Without this, a view that
       * opened before the starter files existed stayed empty forever. */
      const view = existing[0].view;
      if (view && typeof view.reload === 'function') {
        if (activeId) view.activeId = activeId;
        await view.reload();
      }
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_DASHBOARDS, active: true });
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (activeId && view && typeof view.reload === 'function') {
      view.activeId = activeId;
      await view.reload();
    }
  }

  async loadDashboardSpecs() {
    const adapter = this.app.vault.adapter;
    const folder = this.settings.dashboardFolder;
    const specs = [];
    const errors = [];
    if (!(await adapter.exists(folder))) return { specs, errors };
    const listing = await adapter.list(folder);
    for (const path of listing.files.sort()) {
      if (!path.toLowerCase().endsWith('.json')) continue;
      try {
        const parsed = parseDashboardSpec(await adapter.read(path));
        if (parsed.ok) { parsed.spec.path = path; specs.push(parsed.spec); }
        else errors.push({ path, reason: parsed.reason });
      } catch (e) {
        errors.push({ path, reason: e.message });
      }
    }
    return { specs, errors };
  }

  /* The builder writes a dashboard back to its own file; a new dashboard
   * gets a fresh file named after its id. */
  async saveDashboardSpec(spec) {
    const adapter = this.app.vault.adapter;
    await ensureFolder(adapter, this.settings.dashboardFolder);
    if (!spec.path) spec.path = normalizePath(this.settings.dashboardFolder + '/' + spec.id + '.json');
    await adapter.write(spec.path, specToJson(spec));
  }

  async createDashboard() {
    const { specs } = await this.loadDashboardSpecs();
    const taken = new Set(specs.map((s) => s.id));
    let n = 1;
    while (taken.has('dashboard-' + n)) n++;
    const spec = {
      id: 'dashboard-' + n,
      title: 'New dashboard',
      database: '',
      globalTimeframe: DEFAULT_GLOBAL_TIMEFRAME,
      tiles: [],
    };
    await this.saveDashboardSpec(spec);
    return spec;
  }

  async writeDashboardCache(spec, tiles) {
    const adapter = this.app.vault.adapter;
    const path = dashCachePath(this.settings.cacheFolder, spec.id);
    const folder = path.slice(0, path.lastIndexOf('/'));
    await ensureFolder(adapter, folder);
    const payload = {
      dashboardId: spec.id,
      title: spec.title,
      computedAt: new Date().toISOString(),
      tiles,
    };
    await adapter.write(path, JSON.stringify(payload, null, 2));
  }

  async readDashboardCache(spec) {
    const adapter = this.app.vault.adapter;
    const candidates = [dashCachePath(this.settings.cacheFolder, spec.id)];
    if (spec.database) candidates.push(cachePathFor(this.settings.cacheFolder, spec.database, spec.id));
    for (const path of candidates) {
      if (!(await adapter.exists(path))) continue;
      try {
        const cache = JSON.parse(await adapter.read(path));
        if (cache && Array.isArray(cache.tiles) && typeof cache.computedAt === 'string') return cache;
      } catch (e) { /* an unreadable cache reads as no cache */ }
    }
    return null;
  }

  /* Starters are seeded only for databases that exist in this vault: a
   * member without the health archive gets no broken health dashboard. */
  async ensureStarterFiles() {
    const adapter = this.app.vault.adapter;
    const folder = this.settings.dashboardFolder;
    await ensureFolder(adapter, folder);
    const readmePath = folder + '/README.md';
    if (!(await adapter.exists(readmePath))) {
      await adapter.write(readmePath, DASHBOARD_README.replace(/07 Databases/g, this.settings.dataFolder));
    }
    for (const starter of STARTER_DASHBOARDS) {
      const path = folder + '/' + starter.file;
      if (await adapter.exists(path)) continue;
      const spec = JSON.parse(JSON.stringify(starter.spec));
      if (spec.database.startsWith(LEGACY_DATA_FOLDER + '/')) {
        spec.database = this.settings.dataFolder + spec.database.slice(LEGACY_DATA_FOLDER.length);
      }
      if (!(await adapter.exists(spec.database))) continue;
      await adapter.write(path, JSON.stringify(spec, null, 2) + '\n');
    }
  }

  /* ------------------------------------------- schema for the picker -- */

  /* Tables, columns and types for one database: live when an engine can
   * open it, from the desktop-written catalog when it cannot. */
  async schemaFor(dbPath) {
    const choice = await this.query.engineFor(dbPath);
    if (choice.engine) {
      const tables = [];
      const res = await this.query.query(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      for (const [name] of res.rows) {
        const info = await this.query.query(dbPath, 'PRAGMA table_info(' + quoteIdent(name) + ')');
        const nameIdx = columnIndex(info.columns, 'name');
        const typeIdx = columnIndex(info.columns, 'type');
        tables.push({ name, columns: info.rows.map((r) => ({ name: r[nameIdx], type: r[typeIdx] })) });
      }
      return { live: true, tables };
    }
    const catalog = await this.readCatalog(dbPath);
    if (catalog) return { live: false, tables: catalog.tables, computedAt: catalog.computedAt };
    throw new Error((choice.reason || 'This database cannot be opened here.') + ' No catalog yet. Open the database once on the desktop and sync.');
  }

  /* The distinct values of one text column, for the tall-table picker. */
  async distinctValues(dbPath, table, column) {
    const choice = await this.query.engineFor(dbPath);
    if (choice.engine) {
      const res = await this.query.query(dbPath,
        'SELECT DISTINCT ' + quoteIdent(column) + ' FROM ' + quoteIdent(table) +
        ' WHERE ' + quoteIdent(column) + ' IS NOT NULL ORDER BY 1 LIMIT 201');
      return { values: res.rows.map((r) => String(r[0])), truncated: res.rows.length > 200 };
    }
    const catalog = await this.readCatalog(dbPath);
    const key = table + '.' + column;
    if (catalog && catalog.values && catalog.values[key]) {
      return { values: catalog.values[key], truncated: false };
    }
    throw new Error('The values of ' + column + ' are not listed on this device. The catalog carries them only when "Include category values in the mobile catalog" is on and the desktop has synced since. Type the exact value instead.');
  }

  async readCatalog(dbPath) {
    const adapter = this.app.vault.adapter;
    const candidates = [
      catalogPathFor(this.settings.cacheFolder, dbPath),
      legacyCatalogPathFor(this.settings.cacheFolder, dbPath),
    ];
    for (const path of candidates) {
      if (!(await adapter.exists(path))) continue;
      try {
        const catalog = JSON.parse(await adapter.read(path));
        /* A legacy stem-keyed file may belong to a same-named database in
         * another folder; trust it only when it names this database. */
        if (catalog && Array.isArray(catalog.tables) && (!catalog.database || catalog.database === dbPath)) return catalog;
      } catch (e) { /* an unreadable catalog reads as none */ }
    }
    return null;
  }

  /* On the desktop, after a database was successfully touched, write the
   * catalog the mobile picker needs: tables, columns, types, and the
   * distinct values of low-cardinality text columns. Once per session per
   * database, in the background, never blocking a render. */
  maybeWriteCatalog(dbPath) {
    if (!Platform.isDesktopApp) return;
    if (!this.catalogged) this.catalogged = new Set();
    if (this.catalogged.has(dbPath)) return;
    this.catalogged.add(dbPath);
    this.writeCatalog(dbPath).catch((e) => {
      console.error(safeLogLine('the catalog write failed', e));
      this.catalogged.delete(dbPath);
    });
  }

  async writeCatalog(dbPath) {
    const schema = await this.schemaFor(dbPath);
    if (!schema.live) return;
    /* Structure only by default. Raw values move into the synced catalog
     * only when the member turned the setting on (M2, Vex 2026-09-01). */
    const values = {};
    if (this.settings.catalogIncludeValues) {
      for (const table of schema.tables) {
        for (const col of table.columns) {
          if (!isTextType(col.type)) continue;
          try {
            const res = await this.query.query(dbPath,
              'SELECT DISTINCT ' + quoteIdent(col.name) + ' FROM ' + quoteIdent(table.name) +
              ' WHERE ' + quoteIdent(col.name) + ' IS NOT NULL LIMIT 201');
            if (res.rows.length > 0 && res.rows.length <= 200) {
              values[table.name + '.' + col.name] = res.rows.map((r) => String(r[0])).sort();
            }
          } catch (e) { /* a column that will not enumerate is left out */ }
        }
      }
    }
    const adapter = this.app.vault.adapter;
    const path = catalogPathFor(this.settings.cacheFolder, dbPath);
    await ensureFolder(adapter, path.slice(0, path.lastIndexOf('/')));
    await adapter.write(path, JSON.stringify({
      database: dbPath,
      computedAt: new Date().toISOString(),
      tables: schema.tables,
      values,
    }, null, 2));
  }
}

/* The pure library, exposed for the gates. */
IcorSqliteViewerPlugin.lib = {
  extOf, baseName, stemOf, formatBytes, formatNumber, relativeTime,
  stripSqlNoise, gateStatement, applyRowCap,
  cliTable, wasmTable, toCsv,
  quoteIdent, quoteLiteral, filterClause, buildBrowseQuery, buildCountQuery,
  isSidecarPath, isDbPath, isSkippedPath, findDatabases,
  parseDashboardSpec, cachePathFor, dashCachePath, catalogPathFor, planMigration,
  niceScale, stackRows, statOf,
  validTimeframe, resolveTimeframe, timeframeConditions, sqlForWidget,
  pivotSeries, prepareTileForRender, checkWidgetSource, specToJson,
  tileDatabase, tileSql, isNumericType, isTextType, guessTimeColumn,
  matchesNeedle, colsForWidth, defaultSpanFor, clampLayout, rectsCollide,
  findSpot, packLayout, normalizeLayout, showAddTile, seriesPaletteFor, barPath,
  FILTER_OPS, filterConditionOf, filtersCondOf, COMPARE_LABELS, canCompare,
  deltaBadge, nextPreviewState, canSave, SIZE_PRESETS, sizePresetOf, makeDebounce,
  adoptLegacyFolders, LEGACY_DATA_FOLDER,
  shortHash, dbKeyOf, legacyCatalogPathFor, safeLogLine, checkSqlite3Path, READ_PRAGMAS, READ_PRAGMA_FUNCS,
  dbFileUri, detectCli, cliQuery, executeMigration, ensureFolder,
  STARTER_DASHBOARDS, DEFAULT_SETTINGS, PRESET_LABELS, AGG_LABELS, DEFAULT_GLOBAL_TIMEFRAME,
};

/* The form modal, exposed for the gates only. */
IcorSqliteViewerPlugin.modals = { WidgetFormModal, ConfirmModal };

module.exports = IcorSqliteViewerPlugin;

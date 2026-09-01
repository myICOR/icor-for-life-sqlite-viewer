# ICOR for Life - SQLite Viewer

Open, browse and chart the SQLite databases that live inside your vault,
read-only, on every device. The 6 GB health archive answers in
milliseconds on the desktop; the phone shows the same dashboards from a
synced cache.

**Beta.** In daily use in a real vault; rough edges likely. Open an issue.

## The idea

A vault can carry real databases next to its notes: an Apple Health
archive, an engagement log, an analytics store. Notes are for knowledge;
millions of time-series rows are not knowledge, they are data, and data
wants SQL. This plugin brings the SQL to the vault instead of dragging the
data out of it.

Click a `.db`, `.sqlite` or `.sqlite3` file in the file explorer and a
browser opens: every table with its row count, the schema with its
indexes, the data page by page with sorting and per-column filters, and a
console for your own queries with a "Copy as CSV" button. Dashboards are
small JSON files in `07 Data/Dashboards/`; the plugin runs their queries
and draws line charts, bar charts, stat tiles and tables itself, in your
theme's own colors, light and dark.

## The one rule

**Read, never write. Enforced twice.**

Every statement passes a gate first: exactly one statement, starting with
SELECT, WITH, PRAGMA or EXPLAIN, with ATTACH refused. Then the database is
opened read-only on top of that: the desktop engine passes `-readonly` and
a `mode=ro` URI to sqlite3, and the mobile engine works on an in-memory
copy that cannot touch the file at all. The gate is tested, and the tests
include mutation runs that watched it fail when the rule was removed.

The plugin writes only three things, all inside the vault: the starter
dashboard files (once, only when missing), the dashboard cache, and its
own settings. A SELECT with no LIMIT gets one added (500 rows by default),
so a careless query over fifteen million rows comes back as a page, not a
freeze. Long queries are stopped after a timeout (30 seconds by default).

## Two engines

- **Desktop:** the system `sqlite3` command line tool, one process per
  query. The file is never loaded into memory, the indexes do the work,
  and a 6 GB database is as fast as a small one. macOS ships sqlite3 out
  of the box; on Windows and Linux, install it or let the plugin fall back.
- **Everywhere else** (and desktops without sqlite3): sql.js, a
  WebAssembly build of SQLite bundled with the plugin. It loads the whole
  file into memory, so a size cap guards it (200 MB by default, in the
  settings).

## Phones, tablets, and the big database

The big database never travels to the phone. When a dashboard renders on
the desktop, its query results are saved as JSON under
`07 Data/Dashboard Cache/` and sync like any note. A device that cannot
open the database shows the cached dashboard with a plain line: "Computed
on desktop, 2 hours ago." Databases under the size cap render live
everywhere.

## Dashboards

Each dashboard is one JSON file: which database, which queries, which
chart for each. The folder gets a README explaining the format, plus three
starter dashboards, on first load. Edit them freely; the plugin never
overwrites a file that exists. The format, in one glance:

```json
{
  "id": "health-overview",
  "title": "Health Overview",
  "database": "07 Data/mypka-health.db",
  "tiles": [
    {
      "title": "Daily steps, last 90 days",
      "sql": "SELECT local_date, CAST(SUM(qty) AS INTEGER) AS steps FROM health_metric WHERE metric_name = 'step_count' GROUP BY local_date ORDER BY local_date",
      "viz": "bar",
      "x": "local_date",
      "y": "steps",
      "unit": "steps"
    }
  ]
}
```

`viz` is `line`, `bar`, `stat` or `table`. `y` may be a list of columns
for a multi-series chart; `"stack": true` stacks a bar chart's series.
A tile's SQL passes the same read-only gate as everything else, at parse
time, before it is ever run.

## Moving databases into 07 Data

Settings carries one tidy-up button: "Move databases into 07 Data". It
lists every database found elsewhere in the vault with its old and new
path, and moves them only after you confirm. Moving changes where the
databases live; tools outside Obsidian that connect to them may need the
new path. No data is lost or modified, the files are only moved, together
with their `-wal` and `-shm` companion files. Close other apps that are
using a database before moving it. Nothing is ever overwritten.

## Commands

- **SQLite Viewer: Open dashboards** (also the chart icon in the ribbon)
- **SQLite Viewer: List databases** - every database in the vault, with
  size and location
- **SQLite Viewer: Open database browser**

## What it never does

- Never writes to a database. Not a byte, not a PRAGMA that would.
- Never sends anything anywhere. No network, no telemetry, no accounts.
- Never runs your SQL through a shell.
- Never deletes or overwrites a file.

## Install (manual, for now)

Copy `manifest.json`, `main.js`, `styles.css`, `sql-wasm.js` and
`sql-wasm.wasm` into
`<vault>/.obsidian/plugins/icor-for-life-sqlite-viewer/` and enable the
plugin in Settings, Community plugins.

## Tests

```
npm test
```

`node --test` against the pure library and the engines with injected
fakes: the statement gate, the row cap, query building, CSV export,
dashboard spec parsing, migration planning and execution, the process
runner's exact arguments, and an end-to-end query through the bundled
sql.js on real bytes.

## License

Source-available, personal use for ICOR for Life members; see LICENSE.
Not open source. sql.js is MIT licensed; see THIRD-PARTY-NOTICES.md.

Part of the ICOR for Life suite.

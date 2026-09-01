# Changelog

All notable changes to ICOR for Life - SQLite Viewer.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## [0.5.3] - 2026-09-01

### Fixed
- A community-directory install now works: Obsidian's installer downloads
  only `main.js`, `manifest.json` and `styles.css`, so the sql.js engine
  (`sql-wasm.js` + `sql-wasm.wasm`) is now embedded in `main.js` as
  base64, byte-identical to the standalone files. The standalone copies
  are preferred when installed alongside (manual installs); the embedded
  copies answer otherwise. Three new gates, including a simulated
  three-file install answering `SELECT 1`.

### Changed
- `main.js` grows to about 1.1 MB from the embedded engine; common for
  wasm plugins and the cost of a directory install that works everywhere.

## [0.5.2] - 2026-09-01

### Security
- The statement gate now refuses the paren set form of scalar PRAGMAs
  (`PRAGMA user_version(7)` and friends). Parens are allowed only for the
  introspection pragmas that genuinely take an argument. Closes the last
  audit finding (L5); three new gate tests.

## [0.5.1] - 2026-09-01

### Security
- The statement gate enforces read-only itself instead of leaning on the
  engine: write verbs are refused anywhere in the statement (including
  behind a `WITH` chain), and PRAGMA is an explicit read-only allowlist
  with assignments refused. (Audit M1)
- The catalog stores structure only by default; harvesting distinct column
  values into the synced catalog file is now an opt-in setting with a
  plain-words privacy warning. (Audit M2)
- The `.json` viewer can be handed back to other plugins via a setting. (L1)
- Console errors log a safe one-line summary, never SQL or row data. (L2)
- The custom `sqlite3` path setting validates the path and warns that the
  plugin runs whatever it points to. (L3)

### Fixed
- Catalog and cache files are keyed by filename plus a hash of the full
  vault path, so two same-named databases no longer collide. (L4)

## [0.5.0] - 2026-09-01

### Changed
- The home folder becomes `07 Databases`, with silent adoption of the
  legacy location.

### Added
- Public-release readiness: README rewritten for strangers, SECURITY.md,
  THIRD-PARTY-NOTICES.md with verified hashes of the vendored sql.js.

## [0.4.0] - 2026-09-01

### Added
- The widget form: build and edit widgets in a dialog instead of raw JSON.
- One settings page with a live preview that gates Save.

## [0.3.0] - 2026-09-01

### Added
- Search in every picker.
- Edit mode with a square grid for dashboards.
- The INKLINE instrument-panel skin.

## [0.2.1] - 2026-09-01

### Added
- A JSON view.
- "New dashboard" in the folder context menu.

### Changed
- Filters sit quietly behind a funnel icon; the INKLINE control boundary.

## [0.2.0] - 2026-09-01

### Added
- The dashboard builder: widgets without writing SQL.
- The global date range.
- The mobile catalog, so pickers work on phones and tablets.

## [0.1.1] - 2026-09-01

### Fixed
- A stale dashboards view reloads on reveal.
- Every failure is visible; flat table headers.

## [0.1.0] - 2026-09-01

### Added
- First release: read-only table browser, SQL console, dashboards, and the
  two engines (the system `sqlite3` on desktop, the bundled sql.js
  everywhere else).

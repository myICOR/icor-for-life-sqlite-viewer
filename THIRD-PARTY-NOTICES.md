# Third-party notices

ICOR for Life - SQLite Viewer bundles one third-party component.

## sql.js

`sql-wasm.js` and `sql-wasm.wasm` are sql.js version 1.13.0, a WebAssembly
build of SQLite, vendored unmodified from
https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/. It is the engine that
reads databases on phones and tablets, and on desktops without the sqlite3
command line tool. sql.js is licensed under the MIT License by the sql.js
authors (https://github.com/sql-js/sql.js). SQLite itself, which sql.js
compiles, is public domain.

SHA-256 of the vendored files:

- `sql-wasm.js` `694ca5b36aa3e6e71f417819d7df390b65343665fcfa5c69015ca33d93d291b3`
- `sql-wasm.wasm` `0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73`

## Not bundled

The desktop engine is the `sqlite3` command line tool the member's own
system already has (it ships with macOS). It is not bundled, not downloaded
and not required; the plugin looks for it and works without it, within the
size cap of the built-in engine. SQLite is public domain; see
https://sqlite.org/copyright.html.

Icons are the Lucide icons Obsidian itself ships, drawn at runtime through
Obsidian's `setIcon()`. Lucide is licensed under the ISC License by Lucide
Contributors; the copy in use is Obsidian's, not this plugin's.

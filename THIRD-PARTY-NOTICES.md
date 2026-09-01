# Third-party notices

ICOR for Life - SQLite Viewer bundles one third-party component.

## sql.js

`sql-wasm.js` and `sql-wasm.wasm` are sql.js version 1.13.0, a WebAssembly
build of SQLite, vendored unmodified from
https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/. It is the engine
that reads databases on phones and tablets, and on desktops without the
sqlite3 command line tool. Both files ship inside the plugin folder and
are loaded from there at runtime; nothing is ever downloaded.

SHA-256 of the vendored files:

- `sql-wasm.js` `694ca5b36aa3e6e71f417819d7df390b65343665fcfa5c69015ca33d93d291b3`
- `sql-wasm.wasm` `0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73`

sql.js is licensed under the MIT License (https://github.com/sql-js/sql.js):

```
MIT License

Copyright (c) 2017 sql.js authors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

SQLite itself, which sql.js compiles, is public domain
(https://sqlite.org/copyright.html).

## Not bundled

The desktop engine is the `sqlite3` command line tool the member's own
system already has (it ships with macOS). It is not bundled, not
downloaded and not required; the plugin looks for it and works without
it, within the size cap of the built-in engine.

Icons are the Lucide icons Obsidian itself ships, drawn at runtime through
Obsidian's `setIcon()`. Lucide is licensed under the ISC License by Lucide
Contributors; the copy in use is Obsidian's, not this plugin's.

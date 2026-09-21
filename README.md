# ICOR for Life - SQLite Viewer

**Read the databases in your vault, on any device.**

Open, browse and chart SQLite files that live next to your notes. Read-only.
A multi-gigabyte database answers in milliseconds on the desktop, and your
phone shows the same dashboards.

Made by [myICOR](https://myicor.com). Part of the ICOR for Life suite, and
useful in any vault that keeps SQLite files.

## What it is for

Notes are for knowledge. Millions of rows are not knowledge, they are data,
and data wants a database.

An Apple Health archive, an engagement log, an analytics store: these belong
in your vault because they are yours, but they do not belong in markdown.
This brings the query to the vault instead of dragging the data out of it.

## Getting started

Put a `.db` or `.sqlite` file anywhere in your vault and click it. The viewer
opens.

Nothing is imported, converted or copied. The file stays exactly where you
put it.

## What you can do

**Browse** tables and rows, with sorting and filtering.

**Query** with SQL when browsing is not enough.

**Chart** a result, and keep the chart as a dashboard you can open again.

**On your phone**, see the same dashboards from a synced cache, so a database
too large to sync still shows you its answers.

## What it touches

- **Reads database files in your vault.** Read-only, always. It never writes
  to your databases, and it cannot alter your data.
- **Writes the dashboards you save**, as ordinary files in your vault.

**It makes no network connection and starts no process.**

## Good to know

- **Read-only is a design decision, not a limitation to be lifted.** A viewer
  that can write is a viewer that can lose your data.
- **Desktop and mobile**, with the phone reading a cache rather than the whole
  database.
- **Beta.** In daily use in a real vault; rough edges likely. Open an issue.

## Support

What myICOR supports: the plugin as published in a tagged release, on the
current version, installed from that release. Bugs go to this repo's issues,
security reports to the process in `SECURITY.md`.

What the community maintains: anything marked community-maintained, including
community source adapters. We review it before it is merged. We do not support
it, we cannot promise it keeps working, and it can be disabled or removed in
any release.

What is yours: your own changes, your fork, your local patch. Please reproduce
the problem on a clean install of the current release before reporting it.

## Licence

MIT, see `LICENSE`. Install it, run it, read it, change it, sell it, ship it in
your own product; keep the copyright and licence notice.
Releases before 0.6.0 stay under the ICOR for Life
Source-Available License (Code) v1.0 they were published with.

The licence covers the code only. "ICOR", "ICOR for Life", "myICOR" and
"Paperless Movement" are trademarks of Paperless Movement, S.L.; a fork needs
its own plugin id and name. See `TRADEMARK.md`.

Contributions are welcome as pull requests under the same MIT terms, with a
DCO sign-off on every commit. See `CONTRIBUTING.md`.

Bundled third-party components keep their own licences; see
`THIRD-PARTY-NOTICES.md`.

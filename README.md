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

Open an issue on this repository. For security problems, see `SECURITY.md`.

## Licence

Source-available, see `LICENSE`. Not open source. Bundled third-party
components: see `THIRD-PARTY-NOTICES.md`.

# Security Policy

ICOR for Life - SQLite Viewer is a local-only Obsidian plugin. It makes no
network requests and it stores no credentials. Its whole job is to READ the
member's own SQLite databases, so the security surface is the read-only
promise, and this file says so plainly and names what a report should be
about.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Two channels, in order of preference:

1. **GitHub private security advisory** (preferred). Go to the
   [Security tab](https://github.com/myICOR/icor-for-life-sqlite-viewer/security/advisories/new)
   of this repository and open a draft advisory. This keeps the report private
   between you and the maintainer until a fix ships.
2. **Email** `team@myicor.com` with `SECURITY` and `icor-for-life-sqlite-viewer`
   in the subject line. This is a monitored mailbox.

A useful report contains:

- The plugin version (see `manifest.json`, or Settings, Community plugins).
- Your Obsidian version and operating system.
- What an attacker can do, and what they need in order to do it.
- Steps to reproduce, ideally against a throwaway vault and a throwaway
  database.

## What to expect

This project is maintained by one person, so these are timelines we can
actually keep rather than ones that sound good:

| Stage | Target |
| --- | --- |
| We acknowledge your report | within 5 business days |
| We tell you whether we agree it is a vulnerability, and how severe | within 10 business days |
| We ship a fix for a confirmed critical or high issue | we aim for 30 days |
| We ask you to hold public disclosure until | a fix ships, or 90 days from your report, whichever comes first |

If a deadline is going to slip we will tell you before it slips, not after.
If you do not hear from us within 10 business days, please chase us: assume
the message got lost rather than ignored.

## Supported versions

**Only the most recent release is supported.** This project has one branch
(`main`) and no long-term-support line. If you are running an older version,
the fix is to update.

## Scope: what this plugin actually touches

Measured against the shipped `main.js` of v0.5.1:

**Databases, read-only, enforced twice.** Every query passes a statement
gate first: exactly one statement, starting with SELECT, WITH, PRAGMA or
EXPLAIN; ATTACH refused; write verbs (INSERT, UPDATE, DELETE, REPLACE,
CREATE, DROP, ALTER, VACUUM, REINDEX, ANALYZE) refused wherever they
appear as statement verbs, including behind a WITH clause; and PRAGMA
limited to a read-only introspection allowlist, with every assignment
form refused. On the desktop the database is then opened by the system
`sqlite3` tool with the `-readonly` flag AND a `mode=ro` file URI;
elsewhere by the bundled sql.js engine on an in-memory copy of the file,
which cannot reach the original at all. The gate is the first test in
the repo, and the tests include mutation runs that watched it fail.

**Processes.** On the desktop the plugin runs `sqlite3` with a fixed
argument list; the SQL and the database path travel as arguments, never
through a shell. A query is killed after the configured timeout. No other
process is started.

**Files it writes.** Only into the vault: dashboard starter files (once,
only when missing), dashboard cache JSON (query results, so other devices
can render them), a schema catalog per database (table and column names
and types) for the mobile picker, and its own `data.json` settings. The
catalog carries RAW VALUES of small text columns only when the member
turns on "Include category values in the mobile catalog", which is off by
default; the setting says in plain words what gets written. The migration
button MOVES database files inside the vault via Obsidian's rename, only
after the member confirms an exact list, and never overwrites an existing
file.

**Where it connects.** Nowhere. No remote host, no telemetry, no analytics.

**In scope, and we want to hear about it:**

- **A write reaching a database.** Any statement, through the console, a
  dashboard file or the browser, that modifies, creates or deletes anything
  inside a database file. This is the report we would most like to receive.
- **Gate bypass.** A statement the gate should refuse (a write verb, a
  second statement, ATTACH) that gets through, including through comments,
  string literals, unusual whitespace or encodings.
- **Shell injection** through the sqlite3 invocation, or an argument that
  makes sqlite3 do something other than run the given SQL read-only.
- **Path escape.** A dashboard file, a settings value or a database path
  that makes the plugin read or write outside the vault.
- **Migration data loss.** Any path by which the migration button
  overwrites, truncates or deletes a file.
- **HTML or code injection** when query results, schema names or dashboard
  titles render (a database is data; a malicious database must not become
  code).

## Out of scope

These are not vulnerabilities and we will close them as such:

- Reading data from the member's own databases. That is the product.
- The dashboard cache containing query results and syncing with the vault.
  If a query's results are sensitive, the dashboard is the wrong place for
  the query.
- Anyone with filesystem access to the vault being able to read or change
  files there.
- Memory use of the built-in engine on files under the size cap. The cap
  exists for exactly this; tune it in the settings.
- Bugs in Obsidian, sqlite3 or sql.js themselves. Report those upstream.
- Interactions with third-party plugins. Report those as normal issues.
- Missing hardening with no demonstrated impact, or the output of an
  automated scanner with no working proof of concept.
- Social engineering, physical access, or attacks that require the user to
  already be running attacker-controlled code.

## Good-faith research

We will not pursue or support legal action against anyone who reports a
vulnerability to us in good faith, follows this policy, gives us reasonable
time to fix the issue before disclosure, and does not access, modify or
destroy data that is not their own. Test against your own vault and a
throwaway database.

There is no bug bounty. We will credit you by name and link in the release
notes and the advisory unless you would rather stay anonymous.

## Credit

Thank you for taking the time. A report that arrives privately and with a
reproduction is worth a great deal more than the effort it costs you to
write it.

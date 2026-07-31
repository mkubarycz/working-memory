# Copilot Instructions — working-memory

Grounding for the GitHub cloud Copilot coding agent. This repo is the
`working-memory` VS Code extension: a left-rail webview + ~25 MCP language-model
tools (`wm_*`) backed by a SQLite journal database.

## Project shape

```
working-memory/
├── package.json              # extension manifest + scripts; version lives here
├── tsconfig.json             # tsc → out/src/extension.js
├── vitest.config.ts          # unit tests (vitest)
├── schema/NNN_*.sql          # append-only migrations, registered in src/db.ts
├── src/
│   ├── extension.ts          # activate/deactivate; registers views, commands, URI handler
│   ├── db.ts                 # hub-workspace lookup, openDb(), migration runner, all queries
│   ├── tools.ts              # MCP language-model tool registrations (wm_*)
│   ├── tree.ts               # webview tree provider (Active + Archive tabs)
│   └── contentProvider.ts    # virtual docs for `working-memory:` URI scheme
├── tests/                    # vitest specs
├── media/                    # activity-bar icon, panel assets
└── dist/                     # built .vsix artifacts (gitignored)
```

The extension lives inside Michael's multi-root **hub workspace** at
`kubarycz-agentic-workspace/`. The DB is at `<hub>/memory/journal.sqlite`. On
activation the extension picks the first open workspace folder containing
**both** `AGENTS.md` and a `memory/` directory.

## Build / test / run

```bash
npm install
npm run compile        # tsc -p .
npm run watch          # tsc --watch
npm run test           # vitest run
npm run package        # npx vsce package --allow-missing-repository
```

Cloud agent default: run `npm install`, then `npm run compile && npm run test`
before opening a PR. GitHub releases are created by merging the release PR to
`main`, then tagging the merge commit `v<package-version>`.

## Conventions

- **TypeScript** strict, target per `tsconfig.json`. Source under `src/`,
  compiled to `out/`. Entry point: `out/src/extension.js`.
- **SQLite via Node 22's built-in `node:sqlite`** (`DatabaseSync`). No native
  modules, no `better-sqlite3`, no `@electron/rebuild`. If you see references to
  those, they are stale. `require('node:sqlite')` is done **lazily inside
  `openDb()`** so missing-runtime cases surface as a caught error.
- API quirks vs `better-sqlite3`:
  - No `.pragma()` helper → use `db.exec('PRAGMA journal_mode = WAL')`.
  - No `db.transaction(fn)` → write `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK`
    manually (see the migration runner in `src/db.ts`).
  - `.all()` / `.get()` return `unknown` to TS → cast `as unknown as MyRow[]`.
  - Close with `db.close()`; guard with a module-level handle.
- **Defensive activation:** `activate()` must register commands, the tree
  provider, **and** the `TextDocumentContentProvider` BEFORE touching the DB.
  Query helpers in `db.ts` return `[]` / `null` when the handle is missing —
  never throw on read paths. DB open failures surface via
  `vscode.window.showErrorMessage`.

## Schema migrations

- New migrations: `schema/NNN_<name>.sql`, registered in the `MIGRATIONS` array
  at the top of `src/db.ts`. Runner ensures `schema_migrations(version,
  applied_at)` exists and applies unapplied versions in order, each in its own
  `BEGIN`/`COMMIT`.
- **Append-only.** Never edit an already-applied migration.
- Keep DDL idempotent where possible (`CREATE TABLE IF NOT EXISTS`).
- **Table rebuilds with cascading children MUST use the safe pattern in
  `schema/005_safe_topic_rebuild_template.sql`.** The DB opens with
  `foreign_keys = ON`; a naïve `DROP TABLE` will cascade and silently wipe
  join rows (this happened in v0.4.0 and wiped `workstream_topics` /
  `entry_topics`). The short version: `PRAGMA foreign_keys = OFF` outside the
  txn, capture child rows before the drop, restore after the rename, run
  `PRAGMA foreign_key_check` before COMMIT. `defer_foreign_keys` is NOT a
  substitute — it defers the *check*, not the cascade *actions*.

## Tools (`wm_*`)

~25 MCP language-model tools registered in `src/tools.ts` and declared in
`package.json` under `contributes.languageModelTools`. Adding/removing a tool
requires updating both. Each tool is gated by an `onLanguageModelTool:<name>`
activation event in `package.json`.

## URI scheme + deep links

- Virtual docs: `working-memory:/workstream/<slug>.md`,
  `working-memory:/topic/<slug>.md`, `working-memory:/session/<uuid>.md`.
- Deep-link form for chat: `vscode://kubarycz.working-memory/open/<kind>/<id>`
  where `<kind>` ∈ `session | topic | workstream`. The URI handler is
  registered in `extension.ts`. Unknown ids fall through to the content
  provider's not-found body. Slugs with reserved chars should be
  URI-encoded.

## What lives where else (workspace context, not in this repo)

- `<hub>/AGENTS.md` — workspace-wide agent rules (journaling discipline,
  destructive-action rules).
- `<hub>/memory/` — the live journal DB and legacy markdown sessions
  (read-only for new content).
- `.github/prompts/working-memory-developer.agent.md` — the local-IDE
  specialist agent that owns local development and GitHub release coordination.

## Cloud-agent guidance

- Make code changes; run `npm run compile && npm run test`; open a PR.
- Do **not** bump the `version` in `package.json` unless explicitly asked. The
  release flow is human-driven by Michael.
- Do **not** edit applied migrations or write `memory/*.md` files (legacy).
- Prefer editing existing files over creating new ones. Keep changes scoped
  to the task in the issue.

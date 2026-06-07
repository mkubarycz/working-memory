# working-memory

A VS Code extension that surfaces Michael's journal database as a left-rail
tree view inside the hub workspace.

**Scope (v1, intentionally tiny):**

- Open / create a SQLite DB at `<hub-workspace>/memory/journal.sqlite`.
- Apply the initial schema (`schema/001_initial.sql`) if the `workstreams`
  table is missing.
- Show a flat list of workstream titles in the **Working Memory** activity-bar
  view. Refresh button only.

That's it. No rendered journals, no append command, no status bar — those will
come in later iterations.

---

## Build

```bash
npm install
npm run compile           # tsc -p .  →  out/src/extension.js, out/scripts/seed.js
```

Watch mode while iterating:

```bash
npm run watch
```

## Seed the DB

```bash
npm run seed              # idempotent; only inserts when workstreams is empty
```

To re-seed from scratch, delete the DB first:

```bash
rm ../../memory/journal.sqlite*   # .sqlite, -wal, -shm
npm run seed
```

The script resolves the DB path **relative to its own location**:
`<hub>/projects/working-memory/scripts/seed.ts` → `<hub>/memory/journal.sqlite`.
That makes it safe to run from any cwd as long as the project lives at
`<hub>/projects/working-memory/`.

## DB path resolution (extension)

On activation the extension looks at every open workspace folder and picks the
first one that contains **both** `AGENTS.md` and a `memory/` directory. The DB
lives at `<that folder>/memory/journal.sqlite`. If no folder qualifies, the
extension surfaces an error toast and the tree stays empty — open the hub
workspace and run **Working Memory: Refresh** (or reload the window).

## Run the extension locally

Two options.

### A. Extension Development Host (recommended while iterating)

1. Open `/Users/mkubarycz/Documents/kubarycz-agentic-workspace/projects/working-memory/`
   in VS Code.
2. Press `F5` (or **Run → Start Debugging**). A second VS Code window opens
   with the extension loaded.
3. In that window, open the multi-root workspace
   `kubarycz-agentic-workspace.code-workspace` so the hub folder is present.
4. Click the brain icon in the activity bar → see the seeded workstreams.

### B. Install the packaged `.vsix`

```bash
npm run package                                    # produces working-memory-0.1.0.vsix
code --install-extension working-memory-0.1.0.vsix
# then reload the window
```

## Schema migrations

New migrations go in `schema/NNN_<name>.sql`, applied in lexicographic order.
v1 only applies `001_initial.sql` when the `workstreams` table is missing — a
proper `schema_version` table will arrive when there's a second migration.
Keep DDL idempotent (`CREATE TABLE IF NOT EXISTS`, etc.).

## Native module caveat (`better-sqlite3`)

`better-sqlite3` ships prebuilt binaries via `prebuild-install`. They worked
out of the box against Node 22 on Apple Silicon. **If** VS Code's Extension
Host runs an incompatible Node ABI (you'd see a `NODE_MODULE_VERSION` mismatch
on activation), rebuild against VS Code's electron version:

```bash
npx @electron/rebuild -v $(code --version | head -1) -m node_modules/better-sqlite3
# or, simpler, against the system Node again:
npm rebuild better-sqlite3 --build-from-source
```

This requires Xcode command-line tools (`xcode-select --install`). Flagged
here because Michael asked: I did not try to solve this preemptively. If it
breaks at runtime, run the rebuild and reload the window.

## Layout

```
working-memory/
├── package.json
├── tsconfig.json
├── media/brain.svg            # activity-bar icon
├── schema/001_initial.sql     # baseline schema (workstreams, sessions, entries, FTS5)
├── src/
│   ├── extension.ts           # activate / deactivate, registers tree + refresh
│   ├── db.ts                  # hub-workspace lookup, open/migrate, listWorkstreams()
│   └── tree.ts                # TreeDataProvider<WorkstreamNode>
└── scripts/seed.ts            # standalone seeder (npm run seed)
```

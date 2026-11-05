# Copilot Instructions — working-memory

Working Memory is a standalone Electron desktop app backed by a Docker/Node
control plane and SQLite document store. It is not a VS Code extension.

## Review calibration and scope

- Triage review findings before implementing them: accept, downgrade, defer, or
  reject with a reason. Separate impact, likelihood, and confidence; identify the
  reachable production path, triggering conditions, and evidence. Distinguish
  reproduced failures, code-traced defects, and hypothetical concerns.
- Reserve High priority for broken ordinary workflows or credible serious harm
  under realistic conditions. A severe worst case alone does not make an unlikely
  compound scenario High. Do not dismiss credible data-loss or security risks.
- For each finding, explicitly summarize what happens if it is NOT fixed:
  affected users, conditions, practical consequence, and recovery or workaround.
  State uncertainty. Include priority and proposed disposition in the summary.
- Keep fixes focused on introduced regressions, requested behavior, and necessary
  safety or correctness work. Prefer the smallest root-cause fix; justify new
  persistent state, abstractions, or workflow restrictions. Test production entry
  points, not just helpers.
- Consider valid low-priority or unrelated findings for separate GitHub issues
  and separate branches/PRs instead of expanding the current changeset. Search
  for existing issues first; reuse or create a concise linked issue explaining
  the consequence and reason for deferral. Do not ticket rejected speculation.
  Report deferred work and links; a ticket does not mean the problem is fixed.

## Project shape

```text
working-memory/
├── control-plane/   # MCP/HTTP server, document kinds, SQLite store
├── desktop-ui/      # Electron main, preload, Svelte renderer, tests
├── shared/          # typed control-plane client and shared view-model logic
├── schema/          # append-only SQLite migrations
└── tests/           # shared/control-plane client tests
```

The desktop renderer owns all document UI. Do not add VS Code views, custom
editors, virtual files, URI handlers, process supervision, or VSIX packaging.
VS Code connects directly to the external MCP endpoint configured in the
workspace `.vscode/mcp.json`.

## Build and test

```bash
npm install
npm run compile
npm test
npm run typecheck --prefix desktop-ui
npm test --prefix desktop-ui
npm run build --prefix desktop-ui
```

On macOS, the desktop build updates `/Applications/Working Memory.app` without
restarting a running process.

## Architecture rules

- The control plane is the only SQLite owner. The desktop app uses the typed
  client in `shared/controlPlaneClient.ts`.
- SQLite uses Node 22's built-in `node:sqlite`.
- Define MCP tool input schemas once at module scope, not inside per-session
  registration functions. Share validation schemas while keeping handlers and
  authorization session-local; duplicated schema graphs retain substantial
  heap in abandoned sessions. Keep shared schemas independent of registration
  modules to avoid circular initialization. See
  [heap analysis and recovery](../README.md#heap-analysis-and-confirmed-recovery-141).
- Schema migrations are append-only. Table rebuilds with cascading children
  must follow `schema/005_safe_topic_rebuild_template.sql`.
- Persist Markdown as source. Rendering and editor decorations must not rewrite
  stored Markdown without an authored edit.
- Persist attachment references as `wm-attachment:<uuid>` and resolve them
  against the selected environment only at render time.
- Use native `working-memory://open/<kind>/<id>` links inside the desktop app.
  The loopback `http://127.0.0.1:7718/open/...` bridge remains only for Agent
  Window surfaces that block custom schemes.
- Do not reintroduce VSIX release workflows. Desktop releases ship as
  electron-builder installers (macOS DMG/ZIP, Windows NSIS) built by
  `.github/workflows/release.yml`; the installed app starts the bundled
  control plane through Docker Desktop when no environment is running.

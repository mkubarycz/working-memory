# Copilot Instructions — working-memory

Working Memory is a standalone Electron desktop app backed by a Docker/Node
control plane and SQLite document store. It is not a VS Code extension.

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
- Schema migrations are append-only. Table rebuilds with cascading children
  must follow `schema/005_safe_topic_rebuild_template.sql`.
- Persist Markdown as source. Rendering and editor decorations must not rewrite
  stored Markdown without an authored edit.
- Persist attachment references as `wm-attachment:<uuid>` and resolve them
  against the selected environment only at render time.
- Use native `working-memory://open/<kind>/<id>` links inside the desktop app.
  The loopback `http://127.0.0.1:7718/open/...` bridge remains only for Agent
  Window surfaces that block custom schemes.
- Do not reintroduce VSIX release workflows. A standalone installer/updater is
  required before release publishing resumes.

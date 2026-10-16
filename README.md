# working-memory

**Working Memory is a desktop context-storage and workflow engine that treats
agentic workflows as a first-class citizen.** It gives AI agents (and you) a
durable, structured place to record what's happening, why decisions were made,
and what's left to do — so context survives across chats instead of
evaporating when a chat ends.

It does two things at once:

- **Context storage** — a portable SQLite database of durable **workstreams**,
  **topics**, topic types, alerts, and related control-plane documents.
- **Workflow engine** — agents drive the store through typed MCP tools
  (`ws-*` and `wm-document-*`). The standalone desktop app surfaces the live
  state so you can watch and steer.

## How it works

- **Storage:** the control plane owns a SQLite database opened through Node
  22's built-in `node:sqlite`. Schema changes are tracked in append-only
  migrations and applied automatically.
- **Agent access:** typed MCP tools expose the document store without requiring
  agents to touch SQL.
- **You see it:** the standalone Working Memory desktop app owns the Active
  rail, document editor, Markdown preview, chat, and settings UI. VS Code
  connects directly to the external MCP endpoint; no Working Memory extension
  is required.
- **Built for recovery:** resources use explicit status and relationship
  fields, while the SQLite store remains portable and independently backed up.

## Installation status

Working Memory no longer ships as a VS Code extension. Tagged releases publish
standalone installers built by `.github/workflows/release.yml`:

| Platform | Installer | Installs to |
| --- | --- | --- |
| macOS (Apple silicon) | `Working-Memory-<version>-mac-arm64.dmg` | drag to `/Applications` |
| Windows (x64) | `Working-Memory-<version>-win-x64.exe` (NSIS) | per-user `%LOCALAPPDATA%\Programs\Working Memory`, Start Menu and desktop shortcuts |

Both installers register the `working-memory://` URL scheme so chat links from
VS Code and other apps open the desktop UI.

**Prerequisite:** [Docker Desktop](https://www.docker.com/products/docker-desktop/).
Installers only install the app; the data tier is managed from inside it.

On launch, Working Memory connects to a running data tier if one is
reachable (for example an existing `working-memory-control-plane` on
`127.0.0.1:7717`). Otherwise it starts Docker Desktop (if needed), loads the
prebuilt control-plane image bundled in the installer, and starts its default
instance with `docker compose`, creating it on a fresh install. Loading the
image can take a few minutes. No npm downloads, local image builds, registry
login, or backend registry access are needed on the installed computer.
CI builds Linux ARM64 images for Mac installers and Linux x64 images for
Windows installers. Local `npm run build` / packaging builds the image using
Docker first; CI supplies it via `WM_DATA_TIER_IMAGE_ARCHIVE`.

Open **environment menu > Manage instances…** to manage the data-tier
instances the app created. Reachable Working Memory servers the app did not
create (for example one started from this repo's `compose.yaml`) are listed as
**Self-hosted**: you can make them current, but start, stop, upgrade, and
backup are managed outside the app.

- **Add instance** starts a new, empty data tier. The first instance uses
  `7717` when it is free; others use the next free port from 7719–7799 (7718
  is reserved for the desktop link bridge) and are named
  `working-memory-control-plane-<port>`.
- **Make current** switches the desktop app to that instance.
- **Start / Stop** controls the container (the current instance cannot be
  stopped).
- **Upgrade** appears when an instance runs an older image than the app; it
  recreates the container with the bundled image and keeps its data.
- **Rename** changes the display name shown in the environment picker.
- **Back up…** writes a consistent SQLite snapshot
  (`working-memory-<name>-<timestamp>.sqlite`) to a folder you choose
  (default: Desktop). The instance must be running.

Managed instances are recorded in the app's `data-tier/instances.json`
(`~/Library/Application Support/Working Memory` on macOS,
`%APPDATA%\Working Memory` on Windows). Data lives in:

- macOS: `~/Library/Application Support/WorkingMemory` (bind mount); other
  ports use `WorkingMemory-<port>`.
- Windows: the Docker volume `working-memory-data` (SQLite WAL is unreliable
  on Windows bind mounts); other ports use `working-memory-data-<port>`.

Set `WM_DATA_TIER_AUTOSTART=0` to disable automatic data-tier startup.

Builds are not code-signed or notarized yet. On macOS, use **System Settings >
Privacy & Security > Open Anyway** (or `xattr -dr com.apple.quarantine
"/Applications/Working Memory.app"`). On Windows, choose **More info > Run
anyway** at the SmartScreen prompt. Intel Macs are not packaged; build locally.

The macOS development build (`npm run compile:desktop`) still installs
`/Applications/Working Memory.app` directly and uses your existing control
plane.

---

## Build

```bash
git clone https://github.com/mkubarycz/working-memory.git
cd working-memory
npm install
npm run compile           # shared client modules + control plane
npm run compile:desktop   # builds and updates /Applications/Working Memory.app on macOS
```

Local macOS desktop builds always update the stable
`/Applications/Working Memory.app` bundle, which can be kept in the Dock. A
build signals the installed desktop process to refresh after installation;
set `WM_DESKTOP_SKIP_REFRESH=1` to suppress that behavior. The desktop stores
open document-tab identities and the selected tab per Working Memory
environment, then reopens current resource data in the same order after a
restart. CI builds prepare the application bundle but skip the local
`/Applications` installation.

Local builds automatically use the reusable
`Working Memory Local Code Signing` identity when it is installed in the macOS
login Keychain. Certificate-backed signing is required for Keychain
**Always Allow** decisions to survive application rebuilds; ad-hoc signatures
cannot provide persistent Keychain trust. Other machines can set
`WM_DESKTOP_CODESIGN_IDENTITY` to an installed certificate identity.
When no identity is available, builds fall back to ad-hoc signing for CI and
environments that do not access macOS Keychain credentials.

## Desktop AI providers

Settings > Models supports **OpenAI-compatible / Azure Foundry** and
**GitHub Copilot (local CLI)** profiles. Fresh installs default to a single
**GitHub Copilot** profile (model `auto`) on every routing cell. Existing
configurations are unchanged; adding Copilot does not change existing
endpoints, keys, or routing.

To dogfood Copilot:

1. Sign in with the account that has your Copilot license: install the
   official [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli)
   (`brew install copilot-cli`, or `winget install GitHub.Copilot` on Windows)
   and run `copilot login`, or run `gh auth login`.
3. Add a model profile in Settings and choose **GitHub Copilot (local CLI)**.
4. Use **Load Copilot models**, choose a model (or `auto`), and **Test**.
5. Assign that profile in **Routing matrix** and save. Chat currently uses
   **Complex / medium**; topic title/type autocomplete uses **Simple / fast**.
   Assign all nine cells to Copilot to replace Azure for all configured routes.

The installed desktop app discovers the local CLI on PATH and in common
Homebrew, WinGet, and user install locations (npm `.cmd` shims are ignored on
Windows). When no CLI is found it uses the Copilot runtime bundled with the
app. Set `WM_COPILOT_CLI_PATH` in the app's launch environment for a custom
executable location, or to `bundled` to force the bundled runtime. It uses the CLI's existing
authentication; Working Memory does not copy GitHub tokens into its model
configuration. Copilot requires an eligible account and employer permission
for CLI use; plan allowances, model access, and billing rules apply.

This is a model-only integration: Copilot's shell, filesystem, MCP tools,
skills, and repository instruction discovery are not enabled. The app sends
the current transcript and tool schemas, validates JSON tool proposals, and
executes them through Working Memory's existing confirmation and command
journal path. Attached images are passed as image attachments. Each model
turn uses an isolated session that is deleted afterward. Copilot errors are
reported explicitly; requests never fall back to Azure automatically.
Inherited `COPILOT_PROVIDER_*` BYOK overrides are removed from the runtime
environment so selecting Copilot does not silently use an Azure endpoint.

The normal test suite mocks Copilot and makes no billed model requests. To run
the opt-in live test with a signed-in local CLI (uses your Copilot allowance):

```bash
WM_COPILOT_SMOKE=1 npm test --prefix desktop-ui -- tests/copilotProvider.integration.test.ts
```

Set `WM_COPILOT_SMOKE_MODEL` to test a different model; the default is
`gpt-5.4-mini`. The smoke test uses synthetic prompts and tool results, never
mutates Working Memory documents, and deletes its temporary Copilot sessions.

## Persistent control-plane container

The Working Memory SQLite data tier and Streamable HTTP MCP server can run as
a dedicated Docker Compose service. The service:

- bind-mounts the existing data directory at `/data`, so `journal.sqlite`
  remains on the host and survives container replacement;
- publishes MCP and health only on `127.0.0.1:7717`;
- restarts automatically unless explicitly stopped;
- exposes `GET /health` and Streamable HTTP MCP at `/mcp`.

Create a local `.env` with an absolute host path. On macOS:

```bash
cp .env.example .env
# Edit WORKING_MEMORY_DATA_DIR for your username if needed.
docker compose up -d --build control-plane
docker compose ps
curl http://127.0.0.1:7717/health
```

The default production data directory on macOS is
`~/Library/Application Support/WorkingMemory`. Stop any host control-plane
process before starting the container so only one process opens the SQLite
store. View logs with `npm run container:logs` and stop the service with
`npm run container:stop`.

The daemon binds to loopback by default outside Docker. The container sets
`WM_CONTROL_PLANE_HOST=0.0.0.0` internally so Docker can publish it, while the
Compose port mapping keeps the host exposure restricted to `127.0.0.1`.

## Store path resolution

The control plane resolves its data directory from
`WM_CONTROL_PLANE_HOME` and otherwise uses the platform application-data
default. The desktop app connects to the selected control-plane environment;
it does not open SQLite directly.

## VS Code MCP integration

Configure VS Code directly, without an extension, by adding the external
control plane to the workspace's `.vscode/mcp.json`:

```json
{
  "servers": {
    "working-memory": {
      "type": "http",
      "url": "http://127.0.0.1:7717/mcp"
    }
  }
}
```

Start the Docker control plane before opening an agent session. Working Memory
resource links use the native `working-memory://` desktop protocol. The local
HTTP link bridge remains available for Agent Window surfaces that block custom
URL schemes.

To install a build instead of debugging, use the prebuilt GitHub Release
one-liner above.

## Desktop container apps

The desktop **Container Apps** right-rail tab lists registered local
applications. Selecting an app registered with `embeddable: true` opens its UI
as a full-stage document tab. The tab health light and gear menu expose launch,
reload, external-open, stop, refresh, and App Info actions. Non-embeddable apps
open directly to App Info.

On local macOS builds, the desktop installer signals the running installed
copy to relaunch after the newly signed bundle is in place. Set
`WM_DESKTOP_SKIP_REFRESH=1` only when a build must update the application
without refreshing it.

| App | ContainerClaim | Container | URL | Source override |
|---|---|---|---|---|
| Clarinet Hero | `clarinet-hero` | `working-memory-clarinet-hero` | <http://localhost:4173/> | `CLARINET_HERO_SOURCE` |
| Banking App | `banking-app` | `working-memory-banking-app` | <http://localhost:4174/> | `BANKING_APP_SOURCE` |
| Sunset Chess | `sunset-chess` | `working-memory-sunset-chess` | <http://localhost:4175/> | `SUNSET_CHESS_SOURCE` |

Each action is routed by app ID through one registry-driven orchestration path.
The launcher creates or updates the durable claim, builds its Dockerfile, and
reconciles only the exactly labeled managed container. The browser opens an app
only after an HTTP readiness check succeeds. Docker must already be installed
and running; the launcher uses only a validated local Unix-socket Docker
context and reports missing CLI, daemon, timeout, build, ownership-conflict,
startup, and readiness failures without removing unrelated containers. Set
`WORKING_MEMORY_DOCKER_CONTEXT` to prefer a context; otherwise the launcher
checks `desktop-linux`, `orbstack`, and `default`. Existing valid source paths
are retained; otherwise use the app-specific source override or place the
checkout in its discoverable sibling/workspace project path.

ContainerClaims may include a validated Docker `volumes` list and an optional
app-scoped MCP descriptor (`{ transport: "streamable-http", url }`). Sunset
Chess mounts `working-memory-sunset-chess-data` and publishes
<http://localhost:4175/mcp>. The desktop MCP client is separate from
the selected Working Memory control-plane environment, permits only localhost
HTTP endpoints, connects only after app health succeeds, and disconnects on
app stop, environment switch, and window shutdown.

A claim can also advertise an `application` contract descriptor with:

- stable application `id` and `contractVersion`
- the MCP `discovery.toolName` that returns the live Zod-derived contract
- declared `capabilities` and `dataOwnership: "application"`
- optional `healthUrl`, `httpUrl`, and `uiUrl`

Container App detail connects through the same loopback-only MCP client, invokes
that discovery tool, verifies the application identity, and displays the live
common-envelope resource schemas, relationships, and business rules. Working
Memory stores only registration metadata; application domain data remains in
the app-owned database.

Sunset Chess registers contract version `1.0` with MCP discovery tool
`contract-discover`, app-owned data, and only the bootstrap
`contract-discovery` capability. Resource-specific capabilities are derived
from the live contract rather than duplicated in registry metadata. Its local
endpoints are:

- health: <http://127.0.0.1:4175/health>
- MCP: <http://127.0.0.1:4175/mcp>
- HTTP API base: <http://127.0.0.1:4175/api>
- preferred HTTP contract: <http://127.0.0.1:4175/.well-known/sunset-chess-contract>
- compatibility contract alias: <http://127.0.0.1:4175/api/contract>
- optional UI: <http://127.0.0.1:4175/>

The registry contains only identifiers, capabilities, and endpoints. Resource
schemas, constraints, lifecycles, effects, errors, and events are fetched live
from Sunset Chess rather than copied into Working Memory.

In Desktop chat, use the canonical `@container-app-id` form to include only
that app's advertised MCP tools in a model request. For example,
`@sunset-chess show me current games` and
`@Sunset-Chess add Elliot as a new player` resolve case-insensitively. The model
chooses the MCP tool and arguments from its description and schema. An app must
already have a current ContainerClaim that advertises MCP and its managed
container must be running and healthy; chat never starts it automatically.

The selected document's scoped conversation is also shown immediately above
the composer. Sending a command automatically expands this inline surface to
show the latest human prompt, tool activity, and Working Memory response.
Collapsing it with the header chevron replaces the detailed exchange with at
most two abbreviated recent commands for the same document or Container App.
The full run remains available through Chat history.

Read-only MCP tools run directly, while app tools not explicitly annotated
read-only require confirmation. Command journals record the provider-safe
namespaced tool name, sanitized arguments/results, and confirmed app writes as
mutations. An app's `change-set-commit` and `change-set-discard` tools are
excluded from both the model tool list and routing table unless the current
message explicitly asks to commit, discard, or revert the staged changes; when
exposed, either operation still requires confirmation.

Selecting a Container App document makes that app the implicit target for each
submitted turn until another app or document is selected. This supplies the
same tools and routing as its explicit `@container-app-id` mention without
changing the user-visible or persisted message text. Explicit mentions still
work and can add other registered apps to a request.

### Container App resource references

Embedded apps can expose draggable resources through the shared MIME type
`application/vnd.kubarycz.container-app-resource+json`. Version 2 is:

```json
{
  "version": 2,
  "appId": "banking-app",
  "resourceKind": "LedgerItem",
  "resourceId": "projection-item:123",
  "title": "Monthly mortgage",
  "deepLink": "http://127.0.0.1:4174/?resource=LedgerItem&id=projection-item%3A123",
  "preview": {
    "date": "2026-02-01",
    "description": "Monthly mortgage",
    "amount": "$400.00",
    "details": [{ "label": "Status", "value": "Planned" }]
  }
}
```

Required identity fields are version, app ID, resource kind, resource ID,
title, and a registered loopback deep link. `preview` is optional and supports
the common date, description, and amount fields plus a bounded list of generic
label/value details. Apps set this JSON on the shared MIME during `dragstart`;
they should also provide `text/plain`, `text/markdown`, and `text/uri-list`
fallbacks. An embedded app may request the same attachment explicitly with:

```js
window.parent.postMessage({
  type: 'kubarycz:container-app-resource',
  reference
}, '*');
```

Working Memory validates the source frame, app identity, loopback URL, and
notation before accepting it. Dropping the resource into chat renders one
Markdown link labeled from its preview, adds the canonical `@app-id`, and
therefore gives the model the app's discovered MCP tools. The deep link's
resource kind and ID are the authoritative app-owned identity; the model is
instructed to resolve that identity through the app contract rather than
treating it as a Working Memory document. Version 1 references remain accepted
and are normalized to version 2.

An explicit or implicit app target injects the live claim identity and MCP
connection context into the desktop model prompt. The model is instructed to
call the advertised contract discovery tool first, then plan resource
envelopes and relationships before any other operation. Existing endpoint
validation, health checks, provider-safe namespacing, connection pinning, and
mutation confirmation remain in force.

The reusable [`templates/standalone-app`](templates/standalone-app) Cruft
template implements the application side: Zod contract discovery, the approved
`{ kind, metadata, spec, status, relationships }` envelope, app-owned SQLite,
generic MCP resource operations, optional HTTP/UI, atomic audit/domain events,
health, Docker/Compose, tests, and generated-project CI.

Generate and maintain apps with the repository-pinned Cruft 2.16.0 wrapper;
it creates/reuses ignored `.tools/` and `.cache/` directories instead of
installing globally:

```bash
scripts/cruft.sh create . --directory templates/standalone-app --output-dir ../
npm run test:standalone-template
```

The disposable smoke harness covers `create`, `link`, `check`, and `update`
against the template as a Git-repository subdirectory. It also installs and
validates the generated npm project, proves template drift/update behavior,
preserves committed app-owned changes, checks `.cruft.json` subdirectory
provenance, and cleans its ignored `.tmp/` workspace. Generated READMEs define
`src/framework/**` as template-owned and `src/app/**` as app-owned, including
the recommended Cruft `skip` patterns.

For bulk topic closure, agents use `ws-topic-close-tree` rather than emitting
one `ws-topic-update` per descendant. The operation preflights the whole DAG and
closes it in one atomic batch. By default it preserves any descendant with a
parent outside the selected closure and propagates that exclusion to
no-longer-exclusive descendants; `includeSharedDescendants: true` deliberately
closes every reachable descendant, while `dryRun: true` returns the exact plan.
CommandJournal keeps its supplemental entity-reference index capped at 500;
canonical tool call/result events remain the complete audit evidence.

Typing `@` at the start of a message or after whitespace or punctuation opens
the registry-driven Container App picker. Continue typing to filter by app ID
or display name, use the arrow keys to navigate, and press Enter or Tab to
insert the canonical ID (Escape dismisses it). The picker labels apps that
currently advertise MCP; apps without an endpoint remain selectable so chat
can explain the missing capability.

## Chat link patterns

The separate VS Code Agents window does not load ordinary extension URI
handlers and blocks arbitrary custom schemes. Chat-facing links therefore use
the desktop loopback bridge
`http://127.0.0.1:7718/open/<kind>/<id>`, where:

- `<kind>` is `topic`, `workstream`, `topic-type`, `alert`, or `document`
- `<id>` is the resource slug or id

| Kind | Markdown shape | Example |
|---|---|---|
| Topic | `[label](http://127.0.0.1:7718/open/topic/<slug>)` | `[chat-clickable-links](http://127.0.0.1:7718/open/topic/chat-clickable-links)` |
| Workstream | `[label](http://127.0.0.1:7718/open/workstream/<slug>)` | `[topic-types](http://127.0.0.1:7718/open/workstream/topic-types)` |
| Alert | `[label](http://127.0.0.1:7718/open/alert/<id>)` | `[release blocker](http://127.0.0.1:7718/open/alert/1234)` |

The loopback server accepts validated GET routes only, focuses the desktop app,
opens the resource, and returns a small confirmation page. Identifiers
containing reserved characters must be URI-encoded. The Working Memory Agent
Plugin supplies the same link rule to the separate Agents window.

### Palette + `command:` parity

The same four `working-memory.open*` commands also exist for use from
the Command Palette (`Working Memory: Open Session / Topic / Workstream`)
and from trusted markdown contexts. If you control a `MarkdownString`
with `isTrusted = true` (e.g. a hover, a chat participant), you can
still use:

```
[label]\(command:working-memory.openTopic?%5B%22<slug>%22%5D\)
```

The `?...` payload is `encodeURIComponent(JSON.stringify([id]))`. The
deep-link form above is preferred for chat because it does not require
trust.

## Schema migrations

New migrations go in `schema/NNN_<name>.sql` and are registered in the
`MIGRATIONS` array at the top of `src/db.ts`. On activation, the runner
ensures the `schema_migrations(version, applied_at)` table exists, then
applies any unapplied versions in order — each inside its own
`BEGIN`/`COMMIT`. A legacy bootstrap stamps version 1 as applied if the
`workstreams` table already exists from a pre-tracking DB.

Rules:

- **Append-only.** Never edit an already-applied migration.
- Use the safe table-rebuild pattern in
  `schema/005_safe_topic_rebuild_template.sql` whenever you need to
  rebuild a table that has children with `ON DELETE CASCADE` (the DB is
  opened with `foreign_keys = ON`, so a naïve `DROP TABLE` will cascade
  and silently wipe the join rows — exactly what migration 004 did).
- Keep DDL idempotent where possible (`CREATE TABLE IF NOT EXISTS`,
  etc.).

## Releasing

VSIX releases are retired. `.github/workflows/release.yml` builds the macOS
DMG and Windows NSIS installer on every pull request and push to `main`
and keeps them as workflow-run artifacts (version
`<desktop-ui version>-build.<run number>`). Push a `v<version>` tag (for
example `v0.90.0`) to build that version and publish a GitHub Release; `0.x`
and suffixed versions are marked prerelease, `1.0.0` and later are full
releases. The app's footer shows the build time. Build installers locally with
`npm run package:mac --prefix desktop-ui` or `npm run package:win --prefix
desktop-ui` (output: `desktop-ui/release/`). There is no auto-updater yet.

Download the `working-memory-installer-<platform>-<architecture>-<version>`
artifact for your computer. GitHub wraps each artifact in a ZIP; the Mac
download contains only the DMG, not a second copy of the app.
The `ci-only-backend-linux-<architecture>` artifacts transfer backend images
between build jobs, are already included in the installers, and expire after
one day. They are not separate downloads needed for installation.

macOS builds use free ad-hoc signing, including pull-request builds. CI mounts
the DMG to verify the packaged app with
`codesign --verify --deep --strict` before uploading artifacts. Run the same
check locally with `bash scripts/verify-mac-installers.sh desktop-ui/release`.
This verifies signature integrity, not publisher trust or notarization; macOS
may still require explicit approval to open the app.

### Migration safety

See `schema/005_safe_topic_rebuild_template.sql` for the safe table-rebuild
pattern when writing migrations that touch tables with `ON DELETE CASCADE`
children. Migration 004 wiped two join tables by using a naïve
create-copy-drop-rename pattern with `foreign_keys = ON` globally enabled;
that template is the documented cure.

## Release history

See the [GitHub Releases](https://github.com/mkubarycz/working-memory/releases)
page — each tagged `v<version>` release carries its notes and the published
artifacts from the historical extension-based distribution.

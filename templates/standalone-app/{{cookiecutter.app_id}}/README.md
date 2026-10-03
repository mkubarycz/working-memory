# {{ cookiecutter.app_title }}

{{ cookiecutter.app_description }}

This Cruft-generated application is an independent data plane. It owns its
SQLite database, schemas, migrations, audit events, domain events, Docker
image, health endpoint, MCP server, and optional HTTP/UI adapters. Working
Memory is only an optional catalog/client.

## Run and validate

```sh
npm ci
npm test
npm run typecheck
npm run build
docker compose up --build
```

The default container publishes loopback port `{{ cookiecutter.port }}` and
stores SQLite data in a named volume.

- `GET /health` and `/mcp` are always enabled.
{% if cookiecutter.enable_http == "true" -%}
- `GET /api/contract` and generic `/api/resources/:kind/:id?` routes are enabled.
{% else -%}
- HTTP resource routes are disabled by default; set `ENABLE_HTTP=true` to enable them.
{% endif -%}
{% if cookiecutter.enable_ui == "true" -%}
- `/` serves a minimal framework-neutral starter UI.
{% else -%}
- The UI is disabled by default; set `ENABLE_UI=true` to enable the starter page.
{% endif %}

All responses propagate an `x-transaction-id` (or generate one). Every
successful mutation commits the resource row, immutable audit event, and domain
event in one explicit SQLite transaction. Event IDs are distinct from request
transaction IDs. Add an outbox row inside that same transaction before adding
external event delivery.

## Ownership boundary

Cruft owns the reusable runtime and operational files:

- `src/framework/**`, `src/contract.ts`, `src/mcp.ts`, `src/server.ts`
- `test/framework/**`, Docker/Compose, TypeScript/package config, and CI

The application owns its domain:

- `src/app/**` — resource definitions, policies, and registry
- `test/app/**` — domain tests

The generated `Note` is a starter, not framework behavior. Replace it with
domain resources and register them in `src/app/registry.ts`; never hard-code
domain schemas in `src/framework`.

## Safe Cruft updates

After generation, add the app-owned paths to the `skip` list in `.cruft.json`:

```json
{
  "skip": [
    "src/app/**",
    "test/app/**"
  ]
}
```

Commit `.cruft.json`. Then use the same pinned wrapper from the Working Memory
repository:

```sh
scripts/cruft.sh check
scripts/cruft.sh update --template-path /path/to/working-memory
```

If this app lives elsewhere, copy the pin/wrapper or invoke that repository's
wrapper explicitly. Review and commit the Cruft diff like any dependency
upgrade. Do not use `--skip-update` to hide drift; use `skip` only for the
documented app-owned paths.

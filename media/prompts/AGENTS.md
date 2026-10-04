# AGENTS.md

Workspace-wide rules every agent in this workspace must follow. Loaded automatically; not optional.

## Journaling — use Working Memory

This workspace uses the **Working Memory** VS Code extension for session journaling. The extension exposes a database of `workstreams → sessions → entries` plus a panel UI and a suite of `wm_*` MCP tools.

- Do **not** create freeform journal markdown files. All journaling happens through the `wm_*` tools.
- At session start: `wm_list_workstreams` → `wm_get_workstream` on the active one → `wm_start_session`.
- Append `wm_append_entry` after every meaningful event, prefixing the body with the entry type (`chat:`, `command:`, `file:`, `system:`, `decision:`, `frustration:`, `fact:`, `idea:`, `question:`). Keep entries to one or two lines.
- At session end: `wm_end_session` with a 1–2 line summary.

## Topics

Topics are durable subjects that outlive any single session. Tag entries with `wm_link_entry_topic` to surface them under a workstream automatically. Topics can have parent topics (DAG) via `wm_link_topic_parent`.

## Linking to Working Memory in chat

When referencing a session, topic, or workstream in chat output, render it as a markdown link using the deep-link form so the user can click through:

```
http://127.0.0.1:7718/open/<kind>/<id>
```

Where `<kind>` is `topic`, `workstream`, `topic-type`, `alert`, or `document`. The desktop loopback bridge opens the link in the desktop UI. Never paste raw URIs; wrap the link in Markdown with a friendly label.

## Specialist subagents

If this machine has specialist subagents installed (for shell, multi-file edits, code search, builds, web lookups), list them here so the Working Memory agent knows what's available to delegate to. Example:

<!--
- `executor` — shell, multi-file edits, builds, sustained execution.
- `explorer` — read-only codebase questions.
-->

## Safety

- Confirm before external actions (email, messaging, public posts, force pushes).
- Never delete files the user hasn't explicitly told you to delete.

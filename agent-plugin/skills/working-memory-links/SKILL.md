---
name: working-memory-links
description: Create clickable Working Memory links that open topics, workstreams, Agent Messages, topic types, and documents in the desktop UI. Use whenever referencing a Working Memory resource in chat.
---

# Working Memory desktop links

Render every Working Memory reference as a friendly Markdown link targeting:

```text
http://127.0.0.1:7718/open/<kind>/<identifier>
```

Allowed kinds are `topic`, `workstream`, `topic-type`, `alert`, and `document`.
For Agent Messages use the historical `alert` route with the same message ID.
It is a compatibility alias to the canonical Agent Message, not a separate alert.
The bridge allowlist is unchanged; `/open/agent-message/...` is not an HTTP route.
URI-encode the identifier. Never emit raw `working-memory:`,
`working-memory://`, or `vscode://kubarycz.working-memory` links in the Agents
window.

Example:

```markdown
[Product roadmap](http://127.0.0.1:7718/open/workstream/product-roadmap)
```

The Working Memory desktop app must be running. Its loopback bridge validates
the route, focuses the existing app window, and opens the referenced resource.

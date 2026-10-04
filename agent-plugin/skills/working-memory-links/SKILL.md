---
name: working-memory-links
description: Create clickable Working Memory links that open topics, workstreams, alerts, topic types, and documents in the desktop UI. Use whenever referencing a Working Memory resource in chat.
---

# Working Memory desktop links

Render every Working Memory reference as a friendly Markdown link targeting:

```text
http://127.0.0.1:7718/open/<kind>/<identifier>
```

Allowed kinds are `topic`, `workstream`, `topic-type`, `alert`, and `document`.
URI-encode the identifier. Never emit raw `working-memory:`,
`working-memory://`, or `vscode://kubarycz.working-memory` links in the Agents
window.

Example:

```markdown
[Product roadmap](http://127.0.0.1:7718/open/workstream/product-roadmap)
```

The Working Memory desktop app must be running. Its loopback bridge validates
the route, focuses the existing app window, and opens the referenced resource.

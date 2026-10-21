# Working Memory link rule

Whenever a response references a Working Memory topic, workstream, topic type,
Agent Message, or document, use a human-friendly Markdown link targeting:

`http://127.0.0.1:7718/open/<kind>/<URI-encoded-identifier>`

For Agent Messages, `<kind>` remains `alert`: this historical route opens the
same canonical message ID. Do not add `agent-message` to the HTTP bridge
allowlist. The desktop's native `working-memory://open/agent-message/<id>` route
is for in-app links, not this restricted Agent Window surface.

Do not emit `working-memory:`, `working-memory://`, or
`vscode://kubarycz.working-memory` links in the VS Code Agents window.

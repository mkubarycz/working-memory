# CommandJournal v2

`CommandJournal` is the durable record for one submitted desktop-chat request. Its strict `schemaVersion: 2` envelope contains lifecycle status and timestamps, provider identity, the sanitized user request, one required `primaryScope`, accumulated `entityRefs`, an ordered event stream, and terminal completion data.

## Canonical events

Every event has a unique `id`, a contiguous positive `sequence`, and a `timestamp`. The event union is:

- `model_turn`: assistant/system role, iteration, text or structured content parts, provider response metadata, token usage, and duration.
- `tool_call`: model-turn and call identity, tool name, exactly one of sanitized arguments or an argument parse error, plus optional `retryOfCallId` and `dedupedOfCallId` links to earlier calls.
- `tool_result`: call identity, success/failure/cancelled status, the matching sanitized result or error, and duration.
- `confirmation_requested` and `confirmation_resolved`: confirmation identity, optional call linkage, prompt/payload, and resolution.
- `run_error`: stage, message, and optional code, retryability, and sanitized details.

`retryOfCallId` means a later, non-equivalent call of the same tool corrects its immediately preceding failed execution; repeated corrected failures form a chain. `dedupedOfCallId` means execution was skipped because an equivalent execution key already ran, and a deduped call does not also carry retry linkage. The desktop capture path emits both relationships for Chat Completions and Responses through their shared execution path.

## Capture lifecycle

The desktop main process creates the journal before its first model request through `ws-commandjournal-create`. It appends model, tool, confirmation, result, and error events incrementally through `ws-commandjournal-append`, then terminates the record exactly once through `ws-commandjournal-finalize`. Append and finalize use `resourceVersion` compare-and-swap, enforce canonical event ordering and linkage, merge newly discovered entity references, and reject writes to terminal journals.

Terminal completion records the final assistant text, stop reason, aggregate usage and timing when available, whether the run mutated data, and an optional navigation target. Active journals are either `running` or `awaiting_confirmation`; terminal journals are `succeeded`, `failed`, `cancelled`, or `interrupted`.

## Scope and entity references

`primaryScope` identifies the context in which the request was submitted with `kind`, `id`, and optional `slug` and `title`. `entityRefs` use the same identity fields plus `relation: referenced | mutated`. Append and finalize merge references by `(kind, id, relation)` and enrich an existing reference with later snapshot fields.

## History and detail rendering

`ws-commandjournal-read` reads either one full journal by `id` or global history. Global history is newest-first, defaults to 50 records, accepts limits up to 100, and uses an opaque cursor bound to the active filters. Filters match exact primary-scope `kind` and `id`, or an entity reference's `kind`, `id`, and optional relation. Summary pages omit event payloads while retaining lifecycle, scope/reference, completion, and tool-status summaries.

The desktop renderer requests global pages at startup and on **Load older**, merges them into chronological display order without duplicates, and preserves live progress while reconciling a persisted journal by stable id. The renderer detail path fetches the full journal by id when a tool row is selected and reconstructs its call, result, confirmation state, retry/dedupe links, arguments, duration, and partial/interrupted state.

## Version boundary

History and by-id reads intentionally expose only records whose envelope is recognizably schema v2. Schema-v1 or otherwise non-v2 `CommandJournal` rows are excluded; there is no migration or compatibility rendering path in the current design.

Process-restart reconciliation, future-performance indexing, and deleted-target semantics are not part of the current contract.
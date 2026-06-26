# FE handoff — stop generation mid-turn

Courier this to `../frontend`. All changes are ADDITIVE.

## What shipped (backend)

A "stop" button: aborts an in-flight generation without closing the conversation.
The conversation stays open — it transitions `active → idle` via the normal
turn-settle path. Partial messages are persisted. The turn seals with
`finishReason: "aborted"`.

This is distinct from `POST /conversations/:id/close` which marks the
conversation as `closed` (tab dismiss).

## `POST /conversations/:id/stop` — stop generation

Aborts the in-flight turn's `AbortController`. The kernel finishes generation,
persists partial messages, and seals the turn normally. The conversation
transitions `active → idle` (not `closed`).

- 200 response: `{ conversationId: string, abortedTurn: boolean }`
- `abortedTurn: true` — a turn was active and has been aborted.
- `abortedTurn: false` — no active turn (no-op, conversation was already idle).
- Idempotent — stopping an idle conversation is safe.

## What the FE receives after stopping

The existing event flow handles everything — no new WS message needed:

1. The `done` event arrives with `reason: "aborted"` (the turn sealed normally).
2. The `conversation.statusChanged` WS message arrives with `status: "idle"`.
3. The FE should reload history via `GET /conversations/:id` to see the partial
   messages that were persisted before the abort.

## What the FE needs to do

1. **Stop button** in the conversation toolbar (only visible when `status: "active"`).
   On click → `POST /conversations/:id/stop`. Disable the button after clicking
   (wait for the `done` event + `statusChanged: idle` before re-enabling).

2. **Handle the response**: `abortedTurn: true` means the stop worked.
   `abortedTurn: false` means there was nothing to stop (the turn may have
   already finished between the click and the request).

3. **Reload history** after receiving the `done` event to show partial output.

## CLI

`dispatch stop <conversationId>` — stops generation. Resolves short IDs.

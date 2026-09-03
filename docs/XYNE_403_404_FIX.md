# Xyne 403/404 Investigation and Fix

Date: 2026-08-13

## Root Cause

The Xyne service on RTX1 port 3000 was not running the expected source tree.
It was launched from:

`/data/siraj/xyne_s/vespa-dump/sebi-local/xyne/server`

The newer tree under `/data/siraj/xyne_s/xyne-search/server` already contained
more diagnostic APIs, but editing it did not affect the live service. The live
tree had no `GET /v2/chat/conversations/:id/dump` route, so authenticated calls
returned a route-level 404 even for valid conversations.

The observed 403 was a separate, valid authorization response: conversation
storage is owner-scoped and `ChatService.getConversation()` rejects a JWT whose
`sub` does not match `conversation.ownerId`.

## Changes

The live Xyne backend now exposes an owner-gated full conversation snapshot:

- `backendv2/agent/storage/types.ts`: added the `dumpConversation` repository contract.
- `backendv2/agent/storage/inMemory.ts`: snapshots and sorts messages, runs, and tool calls.
- `backendv2/agent/services/chat.ts`: adds owner-gated dump, debug-event compatibility, and nested-run projections.
- `backendv2/agent/routes/chat.ts`: registers `/dump`, `/debug-events`, and `/runs/:parentRunId/nested`.

Polar's Xyne fetcher was updated in both editable source locations:

- `/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py`
- `/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py`

It now waits for a real final assistant text block, uses the native dump when
available, retains a messages-only fallback for older deployments, normalizes
tool calls/results, and accepts the nested-run response object used by Xyne.

## Verification

Live port 3000 route matrix after the primary fix:

| Request | Expected | Observed |
| --- | ---: | ---: |
| Owner reads existing conversation dump | 200 | 200 |
| Different owner reads the dump | 403 | 403 |
| Owner reads a nonexistent conversation | 404 | 404 |
| Request without authentication | 401 | 401 |

A completed production Polar trajectory returned a native dump with:

- 2 messages
- 1 run
- 2 tool calls
- 2 tool results
- 10 normalized retrieved chunks
- 3 thinking blocks
- non-empty final answer
- no error and no messages fallback

The final compatibility endpoints were also tested on an isolated port 3002
instance. Missing `runId` returns 400, and an unknown run returns 404. The older
backend does not persist a separate debug-event stream, so a valid run returns
`events: []`; the complete persisted trace remains in `/dump`.

## Operational Note

This Xyne revision stores conversations in process memory. Restarting port 3000
during an active rollout deletes those in-flight conversations and turns later
polls into genuine 404s. Deploy source immediately, but restart only between
rollout batches while Megatron is computing an optimizer step.

## Interpretation

- `401`: missing or invalid access-token cookie.
- `403`: valid token, but the conversation belongs to another owner.
- `404` on `/dump` before this fix: route absent from the actual live tree.
- `404` after this fix: conversation or run genuinely does not exist in the
  current in-memory backend process.

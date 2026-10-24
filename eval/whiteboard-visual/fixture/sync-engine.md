---
name: Sync engine
description: How Lumen Notes keeps a note identical on every device, online and offline — the op log, the push batch, the server clock, conflict rules and the fan-out back to other devices.
tags:
  - architecture
  - sync
---

# Sync engine

Lumen Notes is offline-first: every edit is written locally first and synced later. The sync
engine is the part that makes a note look the same on a phone, a laptop and the web.

## The path of one edit

1. **Local write.** The editor turns a keystroke burst into an *operation* (insert, delete,
   set-field) and appends it to the device's **op log** in IndexedDB. The UI updates at once.
2. **Batch.** Every 2 seconds, or at 50 ops, the device bundles pending ops into a **push batch**.
3. **Push.** The batch goes to `POST /sync/push`. Offline? The batch stays in the op log and is
   retried with exponential backoff (1 s, 2 s, 4 s … capped at 60 s).
4. **Server clock.** The sync server stamps each op with a Lamport clock and the device id, so
   every op has one global order.
5. **Conflict rules.** Two devices edited the same thing:
   - note body text: merged character by character (a text CRDT), nothing is lost;
   - a single field (title, colour, pinned): last writer wins by the server clock;
   - a delete against an edit: the delete wins, the note becomes a tombstone for 30 days.
6. **Fan-out.** Accepted ops are broadcast over a WebSocket to the user's other devices.
7. **Apply and ack.** Each device applies the ops in clock order and acks the highest clock it
   has; the server trims ops every device has acked.

## Keeping it fast

- **Checkpoints.** Every 500 ops the server writes a snapshot of the note, so a new device
  downloads one snapshot plus the ops after it, never the whole history.
- **Cold start.** A device that was offline for more than 30 days skips the op log and pulls
  fresh snapshots.

## Where it lives

- Client: `packages/sync-client` (op log, batching, retry).
- Server: `services/sync` (clock, conflict rules, fan-out, checkpoints).

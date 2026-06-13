---
phase: 03-transports-and-connection-config-node
plan: 02
subsystem: transport
tags: [udp, multicast, uadp, dgram, reassembly, transport, pubsub]

# Dependency graph
requires:
  - phase: 03-transports-and-connection-config-node
    plan: 01
    provides: BaseTransport abstract class (connect/close/send contract + events vocabulary)
  - phase: 02-uadp-encoder
    provides: decodeNetworkMessage (chunk field paths) + encodeNetworkMessage (chunked Buffer[] input for round-trip tests)
provides:
  - UdpTransport — dgram-based UDP-UADP multicast adapter (extends BaseTransport)
  - Chunk reassembly contract keyed by publisherId|writerGroupId|messageSequenceNumber with 30s expiry + 1000-entry overflow guard
affects: [03-04-connection-node, phase-04-publisher-subscriber]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "dgram udp4 socket with reuseAddr:true bound to 0.0.0.0; addMembership inside bind callback"
    - "socket.close(done) one-arg callback form + null-first idempotent guard for clean rapid bind/close"
    - "Module-object require (uadp.decodeNetworkMessage) instead of destructure so the function is stub-able in tests"
    - "Bounded reassembly Map (drop-oldest via insertion-order iteration) + per-receive expiry sweep"

key-files:
  created:
    - lib/transports/udp-transport.js
    - test/transports/udp-transport.test.js
  modified: []

key-decisions:
  - "Reassembly key is publisherId|groupHeader.writerGroupId|chunk.messageSequenceNumber — VERIFIED against lib/uadp-encoder.js decodeNetworkMessage (resolves 03-RESEARCH Open Question 3)"
  - "chunk parts stored in a Map keyed by chunkOffset so duplicate offsets overwrite (no double-count) and completeness = sum(part lengths) >= totalSize"
  - "decodeNetworkMessage imported via the module object (const uadp = require) rather than destructured, so sinon can stub it for the overflow + decode-error tests"
  - "overflow guard emits a 'warn' event (not console.warn) because lib/ is Node-RED-free (D-07) and an event is testable"

requirements-completed: [TRP-01]

# Metrics
duration: ~12min
completed: 2026-06-13
---

# Phase 3 Plan 02: UDP-UADP Multicast Transport Summary

**Implemented `UdpTransport` (extends BaseTransport): a dgram udp4 multicast adapter that binds to 0.0.0.0 with reuseAddr, joins the group inside the bind callback, sends Buffer|Buffer[] via Array.isArray dispatch, and reassembles inbound UADP chunks with a 30-second expiry sweep, a 1000-entry drop-oldest overflow guard (T-03-05), and decode-error tolerance that keeps the dgram listener alive (T-03-01). The headline 20-cycle rapid bind/close test passes with zero EADDRINUSE.**

## Performance
- **Duration:** ~12 min
- **Tasks:** 2 (both TDD: RED test file then GREEN implementation)
- **Files modified:** 2 (both created)

## Accomplishments
- `lib/transports/udp-transport.js` (216 lines): `connect()` creates a `udp4` socket (`reuseAddr:true`), binds `0.0.0.0:${port}`, and calls `addMembership(group, iface||"0.0.0.0")` + `setMulticastLoopback/TTL` inside the bind callback; `setMulticastInterface` only when an explicit NIC IP is supplied.
- `close()` nulls `_socket` first (idempotent guard) then `socket.close(done)` — the one-arg callback form so the Promise resolves only after OS teardown. This is what lets 20 rapid bind/close cycles run with zero EADDRINUSE.
- `send(Buffer|Buffer[])` dispatches via `Array.isArray`; dgram send failures emit `UDP_SEND_ERROR` as an `'error'` event rather than throwing.
- `_onDatagram` decodes each datagram: single-buffer NetworkMessages pass straight through as `'message'`; chunked messages accumulate by key and emit one `'message'` per complete NetworkMessage (in-order and out-of-order both reassemble via chunkOffset sort).
- Reassembly is bounded: 30s `expiresAt` swept on every receive, hard cap of 1000 in-flight entries with drop-oldest + `'warn'` event on overflow.
- 16 Mocha tests (10 lifecycle/send + 6 reassembly), all green; reassembly tests round-trip through the **real** Phase 2 `encodeNetworkMessage` at `mtu:200` to catch encoder/decoder drift.

## Task Commits
1. **Task 1: UdpTransport connect/close/send + 20-cycle EADDRINUSE test** — `d7c3bda` (feat)
2. **Task 2: chunk reassembly with 30s expiry, 1000-entry overflow guard, decode-error tolerance** — `5aae3e0` (feat)

_TDD note: for each task the test file was authored and verified failing (Task 1: MODULE_NOT_FOUND; Task 2: 5 reassembly tests red) before the implementation was written. Per-task RED→GREEN was honored in execution order; each task is one combined `feat(...)` commit because the executor commits per task._

## Decisions Made
- **Reassembly key + chunk field paths (resolves 03-RESEARCH Open Question 3):** keyed by `partial.publisherId | partial.groupHeader.writerGroupId | partial.chunk.messageSequenceNumber`. The chunk struct decoded by `lib/uadp-encoder.js` (line 996) is `{ messageSequenceNumber, chunkOffset, totalSize, chunkData }`. The chunk encoder (`_encodeChunkNetworkMessage`, line 622) preserves `publisherId` and `groupHeader` from the original NetworkMessage, so the key survives the encode→wire→decode round trip — verified by the in/out-of-order reassembly tests using actual encoder output.
- **`uadp.decodeNetworkMessage` via module object, not destructured:** the overflow test (#15) and decode-error test (#16) stub the decoder with sinon; a destructured local would capture the original reference and ignore the stub. Calling through the module object makes the running code observe the stub.
- **Overflow signal is a `'warn'` event:** `lib/` is Node-RED-free (D-07), so `node.warn` is unavailable; an event keeps the code framework-free and the bound testable.

## Deviations from Plan
None of substance — implementation follows RESEARCH Pattern 2 (socket lifecycle), Pattern 3 (Buffer|Buffer[] send), and Pattern 4 (chunk reassembly) as written. Minor robustness additions (deviation Rule 2, defensive):
- `_onDatagram` guards `partial.groupHeader` being absent (`writerGroupId = partial.groupHeader ? ... : undefined`) so a chunk-flagged datagram lacking a group header cannot throw a TypeError out of the listener — consistent with the T-03-01 "listener stays alive" requirement.

## Port Range Used (per output spec)
- Lifecycle tests (2–7) and the instanceof/addMembership/bind tests each pick a fresh port via `45678 + floor(random()*5000)` in `freshPort()`.
- The **20-cycle bind/close test (#8)** uses its own independent random port from the same `45678..50677` range (computed once, reused across all 20 cycles on the same port + group `239.0.0.1`) so it cannot collide with a socket another test is briefly holding.
- Reassembly tests drive `_onDatagram` synthetically (no socket bind needed); the unused config port there is `45999`.

## Decoder Output Shape Consumed by `_onDatagram` (resolves Open Question 3)
```
decodeNetworkMessage(buf) -> {
  publisherId,                 // top-level (preserved in chunk messages)
  groupHeader: { writerGroupId, groupVersion, networkMessageNumber, sequenceNumber },
  chunk: { messageSequenceNumber, chunkOffset, totalSize, chunkData },  // present only for chunk-flagged datagrams
  payload: [...]               // [] for chunk messages
}
```
Single-buffer messages have `chunk === undefined` → passthrough. The chunk's `messageSequenceNumber` (not `groupHeader.sequenceNumber`) is the per-message id used in the reassembly key.

## Threat Surface
- **T-03-01 (Tampering / malformed input, CWE-20/125):** mitigated — `decodeNetworkMessage` wrapped in try/catch, emits `UDP_DECODE_ERROR` and returns; verified by test #16 (decoder stubbed to throw, listener processes the next datagram).
- **T-03-05 (DoS / unbounded reassembly, CWE-400):** mitigated — 1000-entry cap with drop-oldest + `'warn'`, plus 30s expiry sweep; verified by test #15 (1001 distinct keys → size=1000, oldest absent, warn emitted).
- **T-03-07 (socket leak, CWE-404):** mitigated — `socket.close(done)` + null-first idempotent guard; empirically proven by the zero-EADDRINUSE 20-cycle test.
- No new security-relevant surface beyond the plan's threat model.

## Known Stubs
None — all behavior is wired; reassembly is exercised end-to-end against the real encoder.

## User Setup Required
None.

## Next Phase Readiness
- Plan 03-04 (Connection-Node) can `new UdpTransport({ port, multicastGroup, multicastInterface, mtu })` and wrap close in `node.on('close', async (removed, done) => { await transport.close(); done(); })`. The 500ms grace timer that is the primary EADDRINUSE defense is Plan 03-04's responsibility; `reuseAddr:true` here is the secondary defense.
- Phase 4 Publisher feeds encoder output (`Buffer | Buffer[]`) directly to `transport.send()`; Subscriber listens on `transport.on('message', (buf, meta) => ...)` and receives one event per complete NetworkMessage.

## Self-Check: PASSED
- Files verified present: `lib/transports/udp-transport.js`, `test/transports/udp-transport.test.js`, `03-02-SUMMARY.md`
- Commits verified in git log: `d7c3bda`, `5aae3e0`
- `udp-transport.js` exports `UdpTransport extends BaseTransport`; `instanceof` smoke check prints `true`
- Suite: `npx mocha test/transports/udp-transport.test.js` → 16 passing; full suite → 449 passing, 8 pending, 0 failing (baseline 433/8 + 16 new, zero regressions)

## TDD Gate Compliance
- RED: Task 1 test file verified failing (MODULE_NOT_FOUND); Task 2's 6 reassembly tests verified (5 failing against the Task 1 passthrough) before implementation.
- GREEN: implementation added per task; all 16 tests pass.
- REFACTOR: not needed.
- Note: each task is a single combined `feat(...)` commit (executor commits per task); RED→GREEN order was honored during execution.

---
*Phase: 03-transports-and-connection-config-node*
*Completed: 2026-06-13*

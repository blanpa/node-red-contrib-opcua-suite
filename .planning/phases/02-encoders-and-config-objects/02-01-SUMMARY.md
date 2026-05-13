---
phase: 02-encoders-and-config-objects
plan: "01"
subsystem: uadp-encoder
tags:
  - opcua
  - pubsub
  - uadp
  - binary-encoder
  - flag-cascade
dependency_graph:
  requires:
    - lib/opcua-utils.js (createError)
  provides:
    - lib/uadp-encoder.js (encodeNetworkMessage, decodeNetworkMessage, encodeDataSetMessage stub, decodeDataSetMessage stub)
  affects:
    - Phase 3 transports (UDP/MQTT will import encodeNetworkMessage)
    - Phase 4 Publisher/Subscriber nodes
    - 02-02-PLAN (DataSetMessage encoding extends this file)
tech_stack:
  added: []
  patterns:
    - Private class (BinaryStream) with cursor-based LE read/write
    - Conditional-serializer flag cascade (D-02, PITFALLS Pitfall 1)
    - Named-exports object at file end (D-01)
key_files:
  created:
    - lib/uadp-encoder.js
  modified: []
decisions:
  - "BinaryStream grows via 2x doubling when estimated size is exceeded (avoids realloc thrash for large payloads)"
  - "Cascade build order: extFlags2 first, then extFlags1 (reads extFlags2 != 0 for bit 7), then uadpFlags — exactly mirrors open62541 UA_NetworkMessage_encodeBinary"
  - "BYTE-type PublisherId (0-255) produces no ExtendedFlags1 byte because extFlags1 would be 0x00 — verified by acceptance test"
metrics:
  duration: "4 min"
  completed: "2026-05-13"
  tasks_completed: 1
  files_created: 1
---

# Phase 02 Plan 01: UADP Encoder — BinaryStream + NetworkMessage Header Summary

JWT auth with refresh rotation using jose library — WRONG TEMPLATE TEXT REMOVED.

UADP binary encoder/decoder scaffolding with private BinaryStream and three-level flag cascade per OPC UA Part 14 §7.2.4.

## What Was Built

`lib/uadp-encoder.js` (464 lines) — the wire-format foundation for ENC-01.

### File Structure

| Section | Lines | Description |
|---------|-------|-------------|
| File-level JSDoc banner | 1-20 | Names all 4 exports with signatures; Phase 2 opts note |
| `"use strict"` + constants | 21-36 | UADP_VERSION=0x01, PUBLISHER_ID_TYPE enum, FILETIME constants |
| `class BinaryStream` (private) | 38-168 | Write-mode and read-mode; bounds-checked reads; 2x-growth on overflow |
| Flag Helpers (private) | 170-252 | `_publisherIdTypeBits`, `_writePublisherId`, `_readPublisherId`, `_buildExtendedFlags2/1/UADPFlags` |
| `encodeNetworkMessage` | 254-336 | Three-level cascade + all header fields |
| `decodeNetworkMessage` | 338-410 | Gate-bit-first reader; structured errors on truncation/version mismatch |
| `encodeDataSetMessage` stub | 412-430 | Throws `UADP_ENCODE_NOT_YET_IMPLEMENTED` |
| `decodeDataSetMessage` stub | 432-450 | Throws `UADP_DECODE_NOT_YET_IMPLEMENTED` |
| `module.exports` | 452-464 | 4 exports; BinaryStream excluded |

### Key Behaviors Verified

- **Cascade suppression:** A NetworkMessage with no extended features emits exactly 1 byte (`0x01`). ExtendedFlags1 is suppressed when all bits would be zero; ExtendedFlags2 likewise.
- **All 5 PublisherId variants:** Byte (0-255, no ExtFlags1 needed), UInt16, UInt32, UInt64 (BigInt), String — all round-trip correctly.
- **DataSetClassId GUID:** Mixed-endian encode/decode per Part 6 §5.2.2.7.
- **GroupHeader:** WriterGroupId, GroupVersion, NetworkMessageNumber, SequenceNumber all round-trip.
- **PayloadHeader:** DataSetWriterIds array (UInt8 count + UInt16 IDs).
- **Timestamp:** Windows FILETIME epoch shift (11644473600000n ms offset, 10000n ticks/ms).
- **PicoSeconds:** Only encoded when timestamp is also present.
- **Truncation protection:** `_ensureRead(n)` throws `UADP_DECODE_TRUNCATED at offset X (need Y bytes, have Z)` before any out-of-bounds read.
- **Uninitialized memory:** `toBuffer()` returns `subarray(0, cursor)` — never the full pre-allocated slab.

### Threat Mitigations Applied

| Threat ID | Mitigation |
|-----------|-----------|
| T-02-01 (CWE-125) | `_ensureRead(n)` bounds check before every read |
| T-02-02 (CWE-908) | `toBuffer()` returns `subarray(0, cursor)` only |
| T-02-03 (CWE-843) | `_publisherIdTypeBits()` checks `typeof === "bigint"` for UInt64; throws on Number > 0xFFFFFFFF |
| T-02-05 | Version check `(uadpFlags & 0x0F) !== UADP_VERSION` at decode start |

## Acceptance Criteria Results

| Criterion | Result |
|-----------|--------|
| `node -e "require('./lib/uadp-encoder')"` exits 0 | PASS |
| `module.exports = {` appears once at file end | PASS (line 459) |
| 4 exported functions | PASS |
| `class BinaryStream` declared once | PASS (line 48) |
| BinaryStream NOT in module.exports | PASS |
| `createError` imported from opcua-utils | PASS (line 23) |
| UADPFlags/ExtendedFlags1/ExtendedFlags2 in code | PASS |
| Minimal NM emits 1 byte `0x01` | PASS |
| UInt64 BigInt PublisherId round-trips | PASS |
| Truncated buffer throws TRUNCATED error | PASS |
| `wc -l` >= 250 | PASS (464 lines) |
| `npm test` 231 passing | PASS (231 passing, 1 pending, 0 failing) |

## Deviations from Plan

None — plan executed exactly as written.

The file structure follows the plan's action steps 1-9 verbatim:
- JSDoc banner naming all 4 exports
- Constants section
- Private BinaryStream class
- Flag helpers section
- NetworkMessage Encode section
- NetworkMessage Decode section
- DataSetMessage stubs section
- `module.exports`
- Part 14 §7.2.4 section numbers in divider comments

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `encodeDataSetMessage` | lib/uadp-encoder.js | ~420 | DataSetMessage payload encoding deferred to plan 02 |
| `decodeDataSetMessage` | lib/uadp-encoder.js | ~438 | DataSetMessage payload decoding deferred to plan 02 |

Both stubs throw structured `createError(...)` with message `UADP_*_NOT_YET_IMPLEMENTED: ... lands in plan 02`. The plan's goal (NetworkMessage header encode/decode) is fully achieved. Stubs do not prevent the plan's objective.

## Commits

| Hash | Message |
|------|---------|
| 0404de5 | feat(02-01): create lib/uadp-encoder.js with BinaryStream + UADP NetworkMessage encode/decode |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| lib/uadp-encoder.js exists | FOUND |
| .planning/phases/02-encoders-and-config-objects/02-01-SUMMARY.md exists | FOUND |
| commit 0404de5 exists | FOUND |

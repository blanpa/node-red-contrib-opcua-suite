---
phase: 02-encoders-and-config-objects
plan: "02"
subsystem: uadp-encoder
tags:
  - opcua
  - pubsub
  - uadp
  - datasetmessage
  - variant
  - datavalue
  - chunking
  - tdd
dependency_graph:
  requires:
    - lib/uadp-encoder.js (02-01 foundation: BinaryStream, NetworkMessage header encode/decode)
    - lib/opcua-utils.js (createError)
  provides:
    - lib/uadp-encoder.js (encodeDataSetMessage, decodeDataSetMessage — real implementations)
    - lib/uadp-encoder.js (encodeNetworkMessage — payload wiring + chunking)
    - test/uadp-encoder.test.js (57 new unit tests)
  affects:
    - Phase 3 transports (UDP/MQTT consume encodeNetworkMessage Buffer|Buffer[] return)
    - Phase 4 Publisher/Subscriber nodes (depend on full DataSetMessage encoding)
tech_stack:
  added: []
  patterns:
    - TDD (RED commit ad69bd5, GREEN commit d6abcfe)
    - DataSetFlags1/2 cascade suppression mirroring NetworkMessage cascade (D-10, Pitfall 2)
    - Variant codec with EncodingByte bit-6 array flag (Part 6 §5.2.2.16)
    - DataValue codec with EncodingMask bitmask (Part 6 §5.2.2.17)
    - Sender-side chunking returning Buffer|Buffer[] (Part 14 §7.2.4.4.4)
    - Header extraction into _writeNetworkMessageHeaderFields() for chunk reuse
key_files:
  created:
    - test/uadp-encoder.test.js
  modified:
    - lib/uadp-encoder.js
decisions:
  - "DataSetFlags2 suppressed when all bits = 0 (default KeyFrame, no timestamp) — mirrors NetworkMessage cascade, Pitfall 2 mitigation"
  - "encodeNetworkMessage returns Buffer|Buffer[] — Array when encoded > mtu, Buffer otherwise; callers (Phase 3 UDP transport) must handle both"
  - "Chunking probe approach: encode a zero-length chunk to measure header overhead exactly before splitting"
  - "RawData decode always throws UADP_RAWDATA_DECODE_REQUIRES_METADATA (T-02-09) — Phase 4 metadata-aware path deferred"
  - "KeepAlive has no field body — messageType !== 'keepalive' guard in both encode and decode paths"
  - "Variant null/undefined → empty Variant (EncodingByte 0x00) on encode; returns null on decode"
  - "_writeNetworkMessageHeaderFields extracted to avoid code duplication between normal and chunk encoder"
metrics:
  duration: "14 min"
  completed: "2026-05-13"
  tasks_completed: 1
  files_created: 1
  files_modified: 1
---

# Phase 02 Plan 02: DataSetMessage Encode/Decode + Chunking Summary

Full implementation of UADP DataSetMessage encode/decode with DataSetFlags1/2 cascade suppression, Variant and DataValue codecs for 15 scalar BuiltInTypes, and sender-side chunking per Part 14 §7.2.4.4.4.

## What Was Built

### lib/uadp-encoder.js (464 → 1034 lines)

The `encodeDataSetMessage`/`decodeDataSetMessage` stubs from plan 01 were replaced with
full implementations. `encodeNetworkMessage` now serializes `payload: DataSetMessage[]` and
returns `Array<Buffer>` when the encoded output exceeds the MTU threshold.

| Section | Lines | Description |
|---------|-------|-------------|
| Constants + DataSetMessage constants | ~55-64 | BUILTIN_TYPE enum, FIELD_ENCODING_BITS/NAME, MESSAGE_TYPE_BITS/NAME, DEFAULT_MTU=1400 |
| Variant Codec (Part 6 §5.2.2.16) | ~167-346 | `_writeVariantScalar`, `_readVariantScalar`, `_writeVariant`, `_readVariant` |
| DataValue Codec (Part 6 §5.2.2.17) | ~348-424 | `_writeDataValue`, `_readDataValue` with 6-bit EncodingMask |
| Flag Helpers | ~426-535 | Unchanged from plan 01 |
| _writeNetworkMessageHeaderFields | ~537-568 | Extracted header field writer (shared by normal + chunk encoder) |
| Chunking helpers | ~570-659 | `_splitIntoChunks`, `_encodeChunkNetworkMessage` |
| encodeDataSetMessage | ~661-748 | Full implementation |
| decodeDataSetMessage | ~750-800 | Full implementation |
| encodeNetworkMessage | ~802-908 | Payload wiring + chunk detection |
| decodeNetworkMessage | ~910-1034 | Chunk decode path + DataSetMessage decode |

### test/uadp-encoder.test.js (57 tests)

TDD-committed before implementation. Covers:
- DataSetFlags1/2 cascade: all bits, suppression rule, all 3 fieldEncodings, all 4 messageTypes
- Variant round-trips: Boolean, SByte, Byte, Int16, UInt16, Int32, UInt32, Int64, UInt64, Float, Double, String, DateTime, StatusCode, null, 1D arrays
- DataValue round-trips: value-only, statusCode, sourceTimestamp
- NetworkMessage payload wiring: single DSM, multiple DSMs with size array
- Chunking: Array<Buffer>, chunk <= MTU, TotalSize consistency, ExtFlags2 bit 0, custom mtu opt
- Error cases: invalid inputs, unknown fieldEncoding/messageType/builtInType, rawdata decode without metadata

## Variant BuiltInType Coverage

| BuiltInType | ID | Implemented | Notes |
|-------------|-----|-------------|-------|
| Boolean | 1 | Yes | UInt8 1/0 |
| SByte | 2 | Yes | Int8 |
| Byte | 3 | Yes | UInt8 |
| Int16 | 4 | Yes | Int16LE |
| UInt16 | 5 | Yes | UInt16LE |
| Int32 | 6 | Yes | Int32LE |
| UInt32 | 7 | Yes | UInt32LE |
| Int64 | 8 | Yes | BigInt64LE |
| UInt64 | 9 | Yes | BigUInt64LE (BigInt) |
| Float | 10 | Yes | FloatLE |
| Double | 11 | Yes | DoubleLE |
| String | 12 | Yes | UInt32 length + UTF-8 |
| DateTime | 13 | Yes | Windows FILETIME UInt64LE |
| Guid | 14 | Yes | Mixed-endian per Part 6 §5.2.2.7 |
| ByteString | 15 | Yes | UInt32 length + bytes; null = 0xFFFFFFFF |
| StatusCode | 19 | Yes | UInt32LE |
| All others | — | Throws | UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE: <id> |

## DataValue Round-Trip Safety

DataValue encoding is fully round-trip safe for all 6 EncodingMask bits:
- bit 0: Value (Variant) — round-trips all 15 implemented BuiltInTypes
- bit 1: StatusCode (UInt32) — round-trips correctly
- bit 2: SourceTimestamp (DateTime) — round-trips via Windows FILETIME
- bit 3: ServerTimestamp (DateTime) — round-trips via Windows FILETIME
- bit 4: SourcePicoseconds (UInt16) — round-trips correctly
- bit 5: ServerPicoseconds (UInt16) — round-trips correctly

## Chunking Contract

`encodeNetworkMessage` return type:
- **`Buffer`** — when encoded output <= mtu (default 1400)
- **`Array<Buffer>`** — when encoded output > mtu AND payload is non-empty

Each chunk NetworkMessage:
- UADPFlags bit 7 → ExtFlags1 bit 7 → ExtFlags2 bit 0 = 1 (chunk marker)
- PayloadHeader with single dataSetWriterId (spec §7.2.4.4.4)
- Chunk payload: MessageSequenceNumber (UInt16), ChunkOffset (UInt32), TotalSize (UInt32), ChunkData (ByteString = UInt32 length + bytes)
- Each chunk wire size <= mtu

Chunk probe strategy: encode a zero-length chunk first to measure exact header overhead, then use that overhead to compute `maxChunkData = mtu - headerOverhead - 12` (12 = chunk payload field overhead).

Chunk reassembly is Phase 3 UDP transport responsibility (T-02-10 accept disposition).

## Acceptance Criteria Results

| Criterion | Result |
|-----------|--------|
| Stubs replaced (no UADP_*_NOT_YET_IMPLEMENTED in encode/decode bodies) | PASS |
| `grep -c "_writeVariant\|_readVariant\|_writeDataValue\|_readDataValue"` >= 8 | PASS (18) |
| FIELD_ENCODING_BITS/NAME + MESSAGE_TYPE_BITS/NAME tables present | PASS |
| DEFAULT_MTU + opts.mtu handling present | PASS |
| chunkOffset/totalSize/messageSequenceNumber in chunk section | PASS |
| UInt32 round-trip via NetworkMessage | PASS |
| KeepAlive messageType round-trip | PASS |
| Chunked output Array<Buffer> with 2000-char String payload | PASS (2 chunks) |
| Each chunk <= 1400 bytes | PASS |
| `node -e "require('./lib/uadp-encoder')"` exits 0 | PASS |
| `wc -l lib/uadp-encoder.js` >= 500 | PASS (1034) |
| `npm test` all passing, no regressions | PASS (377 passing, 1 pending, 0 failing) |

## Deviations from Plan

### Auto-fixed: _writeNetworkMessageHeaderFields extraction

The plan's action step 8 specified an inline `_writeNetworkMessageHeaderFields` helper but the
original `encodeNetworkMessage` had all header writes inline. The extraction was applied to both
the normal encode path AND the chunk encoder, eliminating code duplication. This is exactly the
plan's intent — no functional deviation.

### Auto-fixed: Chunk probe uses empty chunkData (not separate measurement)

The plan described "computing headerOverhead by encoding a chunk with zero-length chunkData first
and measuring its size." This was implemented exactly as described using `Buffer.alloc(0)` as
probe chunkData. The CHUNK_PAYLOAD_OVERHEAD constant (12 bytes) accounts for the four chunk-payload
fields (UInt16 + UInt32 + UInt32 + UInt32) that appear in every chunk but are not part of the
"header" overhead. This matches the spec layout.

### Minor: PromotedFields stub retained

The plan did not cover PromotedFields encoding (it requires Variant — now available). However
since plan 02 does not explicitly require PromotedFields and it was not in the plan's `<behavior>`,
the stub throw is retained with an updated message. This is out of scope for Phase 2.

## Known Stubs

None that affect plan goals. PromotedFields throw is intentional — not part of ENC-01 scope.

RawData decode throws UADP_RAWDATA_DECODE_REQUIRES_METADATA — intentional per T-02-09 and
documented design (Phase 4 will add metadata-aware decode path).

## Threat Mitigations Applied

| Threat ID | Mitigation | Implementation |
|-----------|-----------|----------------|
| T-02-06 (CWE-125) | Field-loop truncation handled by _ensureRead | Every read in field loop goes through BinaryStream._ensureRead |
| T-02-07 (DoS) | Array allocation bounded by buffer remaining | _readVariant array length triggers _ensureRead per element |
| T-02-08 (CWE-20) | Unknown BuiltInType throws structured error | `_readVariantScalar` default case: UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE |
| T-02-09 | RawData decode requires metadata | Always throws UADP_RAWDATA_DECODE_REQUIRES_METADATA in decodeDataSetMessage |
| T-02-10 | Chunk reassembly deferred to Phase 3 | Decode-side: nm.chunk populated, nm.payload=[], no reassembly buffer |

## Threat Flags

None — no new network endpoints, auth paths, or schema changes beyond the documented threat model.

## Commits

| Hash | Phase | Message |
|------|-------|---------|
| ad69bd5 | RED | test(02-02): add failing tests for DataSetMessage encode/decode and chunking |
| d6abcfe | GREEN | feat(02-02): implement DataSetMessage encode/decode, Variant/DataValue codecs, chunking |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| lib/uadp-encoder.js exists | FOUND |
| test/uadp-encoder.test.js exists | FOUND |
| .planning/phases/02-encoders-and-config-objects/02-02-SUMMARY.md exists | FOUND |
| commit ad69bd5 exists | FOUND |
| commit d6abcfe exists | FOUND |
| 377 tests passing | FOUND |

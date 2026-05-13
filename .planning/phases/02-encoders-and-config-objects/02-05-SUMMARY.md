---
phase: 02-encoders-and-config-objects
plan: "05"
subsystem: uadp-encoder
tags:
  - opcua
  - pubsub
  - uadp
  - tests
  - fixtures
  - test-vectors
dependency_graph:
  requires:
    - 02-01  # UADP encoder foundation (NetworkMessage encode/decode, flag cascade, PublisherId variants)
    - 02-02  # DataSetMessage encode/decode + chunking
  provides:
    - test/fixtures/uadp-vectors.js  # 8-combination hex fixture vectors
    - test-server/capture-open62541-vectors.js  # Phase 4 fixture refresh tool
  affects:
    - test/uadp-encoder.test.js  # appended fixture-based describe blocks
tech_stack:
  added: []
  patterns:
    - Fixture-file test vectors with provenance + specRef per D-17
    - require.main guard for manually-run scripts per D-18
    - for-loop over fixture entries for DRY matrix testing per D-19
key_files:
  created:
    - test/fixtures/uadp-vectors.js
    - test-server/capture-open62541-vectors.js
  modified:
    - test/uadp-encoder.test.js
decisions:
  - Fixture hex values are encoder self-output (verified round-trip), not open62541 captured — Phase 4 upgrades provenance
  - Byte PublisherId (type bits 000) suppresses ExtFlags1 entirely per cascade rule — test explicitly asserts this
  - Static-chunk fixtures (chunkMessage, chunkWithPublisherId) skip encode/round-trip assertions; UADPFlags flag byte assertion uses automatic chunking path instead
  - test/uadp-encoder.test.js was APPENDED (not overwritten) to preserve 57 existing tests from plan 02-02
metrics:
  duration: "~15 minutes"
  completed: "2026-05-13"
  tasks_completed: 3
  tasks_total: 3
  files_created: 2
  files_modified: 1
---

# Phase 2 Plan 5: UADP Test Fixtures + 8-Combination Fixture Matrix Summary

Hex-literal test vectors for 8 ExtendedFlags1/ExtendedFlags2 combinations, Mocha fixture-based test suite extending existing uadp-encoder.test.js, and open62541 capture script for Phase 4 fixture refresh.

## Objective

Create the test scaffolding for ENC-01: 8-combination fixture vectors that lock in the UADP wire format, byte-for-byte assertions that catch encoder regressions, and the open62541 capture script for future fixture upgrade.

## Final Test Count Delta

- Before plan: 377 passing (from 02-02 + prior plans)
- After plan: **411 passing** (377 + 34 new fixture-based tests)
- Pending: 8 (7 fixture skips for pending/static-chunk entries + 1 pre-existing)
- Regressions: 0

## 8-Combination Flag Matrix — Status

| # | Name                 | hex status          | Non-pending? | Notes |
|---|----------------------|---------------------|--------------|-------|
| 1 | minimalNoExtFlags    | `"01"` (spec-exact) | yes          | UADPFlags only; ExtFlags1/2 suppressed |
| 2 | uint64PublisherId    | encoder self-output | yes          | ExtFlags1 type bits 011 verified |
| 3 | withTimestamp        | encoder self-output | yes          | ExtFlags1 bit 5; FILETIME epoch verified |
| 4 | withDataSetClassId   | encoder self-output | yes          | ExtFlags1 bit 3; GUID mixed-endian verified |
| 5 | chunkMessage         | null (isStaticChunk)| skipped      | Static chunk descriptor model; automatic chunking path tested separately |
| 6 | withPromotedFields   | null (pending)      | skipped      | Encoder throws UADP_ENCODE_NOT_YET_IMPLEMENTED |
| 7 | chunkWithPublisherId | null (isStaticChunk)| skipped      | Static chunk + UInt64; automatic chunking path tested separately |
| 8 | stringPublisherId    | encoder self-output | yes          | ExtFlags1 type bits 100; String length-prefix verified |

**Non-pending entries validated:** 5 of 8 (minimalNoExtFlags, uint64PublisherId, withTimestamp, withDataSetClassId, stringPublisherId). All 5 have encoder output matched to fixture hex byte-for-byte.

**Pending entries:**
- `withPromotedFields` (#6): encoder throws `UADP_ENCODE_NOT_YET_IMPLEMENTED` for promotedFields. Will be enabled when plan 02 implements promotedFields encoding.
- `chunkMessage` (#5) and `chunkWithPublisherId` (#7): `isStaticChunk: true`. These fixtures document the wire layout for caller-supplied `model.chunk` descriptors; the automatic chunking path (which encodes full DataSetMessage payloads) is covered by the "chunking" describe block in the existing test file.

## New Test Sections Added (appended to existing test/uadp-encoder.test.js)

1. **module exports** — verifies 4 public functions exported; BinaryStream not exported
2. **8-combination flag cascade matrix** — for-loop over all 8 fixture entries; byte-for-byte hex assertion; UADPFlags first-byte assertion for all entries; decode round-trip assertion for non-pending/non-static-chunk entries
3. **round-trip stability** — encode→decode→encode identity for 3 specific fixture models
4. **PublisherId variants** — all 5 JS types with ExtFlags1 type-bit assertions; correctly handles Byte type (ExtFlags1 suppressed) vs. non-Byte types (ExtFlags1 present)
5. **chunking** — MTU-overflow produces Array<Buffer>; sum of chunkData == totalSize; below-MTU returns single Buffer
6. **decoder error handling** — UADP_DECODE_TRUNCATED, UADP_DECODE_INVALID_INPUT, UADP_DECODE_UNSUPPORTED_VERSION, UADP_ENCODE_INVALID_INPUT

## Phase 4 Hand-off Notes

The `test-server/capture-open62541-vectors.js` script upgrades fixture provenance from "encoder self-output" to "open62541 v1.4.x verified":

1. Pull the open62541 Docker image: `docker pull open62541/open62541`
2. Start a UADP publisher with the 8 fixture models configured
3. Run: `node test-server/capture-open62541-vectors.js`
4. Copy the hex output for each fixture case into `test/fixtures/uadp-vectors.js`
5. Update `provenance` field to `"open62541 v<version> captured <date>"`
6. Remove `isStaticChunk: true` for entries #5 and #7 once the capture confirms encoder output

## Deviations from Plan

### Deviation 1 - Important: APPEND not overwrite (per prompt directive)

Task 2 action step says "Create `test/uadp-encoder.test.js`" but the file already existed with 57 tests from plan 02-02. As instructed, new describe blocks were appended to the end of the existing file rather than overwriting it. This preserves all 57 existing DataSetMessage/chunking tests.

### Deviation 2 - Auto-fix Bug: Fixture hex for withTimestamp corrected

The plan's action step showed `hex: "91 20 05 00 08 71 6B E2 DC 01"` for the `withTimestamp` fixture. Running the encoder produced `91 20 05 00 00 08 71 6B E2 DC 01` (11 bytes vs 10 — one additional `00` byte in the FILETIME encoding). The fixture was corrected to match the actual encoder output. The plan comment about byte layout was also updated with the correct 8-byte FILETIME representation.

**Root cause:** The FILETIME value 134234496000000000 (100ns ticks) in little-endian is `00 00 08 71 6B E2 DC 01` — the high bytes are two zeros, not one.

### Deviation 3 - Auto-fix Bug: Byte PublisherId test assertion corrected

The plan's `PublisherId variants` test asserted `expect(buf[0] & 0x80).to.equal(0x80)` for all 5 types. However, for the `Byte` type (bits 000), ExtFlags1 would be all zeros, so it's correctly suppressed per the cascade rule — UADPFlags bit 7 must be 0, not 1. The test was corrected to explicitly validate the cascade suppression for Byte type while asserting ExtFlags1 presence for non-Byte types. This is spec-correct behavior per Part 14 §7.2.4 cascade suppression rules.

### Deviation 4 - `_populateNullHex` helper removed from fixture file

The plan's Task 1 action included a `_populateNullHex` helper function that would auto-compute hex values at require time. This was not implemented because:
1. It adds complexity and a potential source of confusion (fixture mutates on load)
2. The hex values were computed manually by running the encoder and validated against the spec
3. The static hex literals are more reliable and auditable than computed-on-load values

Instead, the fixture file uses static hex literals for non-pending entries and `null` for pending/static-chunk entries. The status summary comment at the bottom documents each entry's state clearly.

## Known Stubs

None. All non-pending fixture entries have static hex literals validated against actual encoder output. Pending entries are clearly documented with `pending: true` or `isStaticChunk: true` and will not cause test failures.

## Threat Flags

None. The files created in this plan do not introduce new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. The capture script binds a UDP socket but only when run directly (`require.main === module`), never during `npm test`.

## Self-Check: PASSED

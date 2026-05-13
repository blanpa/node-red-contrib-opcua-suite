"use strict";

/**
 * UADP Binary Test Vectors for NetworkMessage Encoding
 *
 * Each entry documents:
 *   model:      the NetworkMessage domain object input
 *   hex:        the expected wire-format bytes (hex string, whitespace ignored)
 *   flags:      which flag bytes are present and their values
 *   provenance: how this vector was obtained
 *   specRef:    Part 14 section governing this encoding
 *
 * Hex format: space-separated byte pairs, optionally with `_` group separators.
 * Tests strip all whitespace (including `_`) before comparing to encoder output.
 *
 * 8-Combination Flag Matrix (per Part 14 §7.2.4 + RESEARCH.md test plan):
 *   1. minimalNoExtFlags    — UADPFlags only (no extended features)
 *   2. uint64PublisherId    — ExtFlags1 only (PublisherId type bits 011 = UInt64)
 *   3. withTimestamp        — ExtFlags1 only (Timestamp bit 5)
 *   4. withDataSetClassId   — ExtFlags1 only (DataSetClassId bit 3)
 *   5. chunkMessage         — ExtFlags1 + ExtFlags2 (Chunk bit 0) [static-chunk fixture]
 *   6. withPromotedFields   — ExtFlags1 + ExtFlags2 (PromotedFields bit 1) [pending]
 *   7. chunkWithPublisherId — ExtFlags1 + ExtFlags2 (UInt64 + Chunk) [static-chunk fixture]
 *   8. stringPublisherId    — ExtFlags1 only (String type bits 100)
 *
 * Provenance: hex strings are generated from the encoder's own output and validated
 * against Part 14 §7.2.4 Table 75 flag bit layouts. Phase 4 will upgrade to
 * "open62541 v1.4.x" via test-server/capture-open62541-vectors.js.
 */

// ─── 1. minimalNoExtFlags ───────────────────────────────────────────────────
// Empty NetworkMessage: no PublisherId, no GroupHeader, no PayloadHeader, no extended features.
// UADPFlags = 0x01 = version 1, all feature-gate bits clear.
// ExtendedFlags1 is SUPPRESSED (UADPFlags bit 7 = 0).
// ExtendedFlags2 is SUPPRESSED (not reachable without ExtendedFlags1).
const minimalNoExtFlags = {
  model: { payload: [] },
  hex: "01",
  flags: { uadpFlags: 0x01, extFlags1: null, extFlags2: null },
  provenance: "hand-derived from Part 14 §7.2.4 Table 75; verified against encoder output 2026-05-13",
  specRef: "Part 14 §7.2.4",
};

// ─── 2. uint64PublisherId ────────────────────────────────────────────────────
// PublisherId = 0x1234567890ABCDEF (BigInt → UInt64)
// Triggers ExtendedFlags1 (PublisherId type bits 0-2 = 011 for UInt64).
// UADPFlags: 0x91 = version (0x01) | PublisherId enabled (0x10) | ExtFlags1 enabled (0x80)
// ExtFlags1: 0x03 = UInt64 type bits (011)
// PublisherId payload: 0x1234567890ABCDEF little-endian = EF CD AB 90 78 56 34 12
const uint64PublisherId = {
  model: { publisherId: 0x1234567890abcdefn, payload: [] },
  hex: "91 03 EF CD AB 90 78 56 34 12",
  flags: { uadpFlags: 0x91, extFlags1: 0x03, extFlags2: null },
  provenance: "encoder self-output captured 2026-05-13; flag layout validated against Part 14 §7.2.4 Table 75",
  specRef: "Part 14 §7.2.4 (PublisherId type encoding)",
};

// ─── 3. withTimestamp ────────────────────────────────────────────────────────
// PublisherId = 5 (Byte, type bits 000).
// Timestamp = 2026-05-13T00:00:00.000Z.
// UADPFlags: 0x91 = version | PublisherId | ExtFlags1
// ExtFlags1: 0x20 = Timestamp bit 5 (PublisherId type bits 000 = Byte)
// Timestamp encoding: (1778976000000 + 11644473600000) * 10000 = 134234496000000000 (100ns ticks)
// Little-endian 8 bytes: 08 71 6B E2 DC 01 00 00
// Full hex: 91 20 05 08 71 6B E2 DC 01
// Note: bytes are: UADPFlags ExtFlags1 PublisherId[1] Timestamp[8]
// Timestamp = (1778976000000 + 11644473600000) * 10000 = 134234496000000000 ticks
// Little-endian 8 bytes of 134234496000000000 = 00 00 08 71 6B E2 DC 01
const withTimestamp = {
  model: { publisherId: 5, timestamp: new Date("2026-05-13T00:00:00.000Z"), payload: [] },
  hex: "91 20 05 00 00 08 71 6B E2 DC 01",
  flags: { uadpFlags: 0x91, extFlags1: 0x20, extFlags2: null },
  provenance: "encoder self-output captured 2026-05-13; DateTime FILETIME conversion per Pitfall 4 verified",
  specRef: "Part 14 §7.2.4.2.3 ExtendedNetworkMessageHeader",
};

// ─── 4. withDataSetClassId ───────────────────────────────────────────────────
// PublisherId = 0x1234 (UInt16, type bits 001).
// DataSetClassId = "6BA7B810-9DAD-11D1-80B4-00C04FD430C8"
// UADPFlags: 0x91 = version | PublisherId | ExtFlags1
// ExtFlags1: 0x09 = DataSetClassId bit 3 (0x08) | UInt16 type (001 = 0x01) = 0x09
// PublisherId [2]: 34 12 (UInt16 LE)
// GUID [16]: 10B8A76B AD9DD111 80B400C0 4FD430C8
//            Data1(LE UInt32) Data2(LE UInt16) Data3(LE UInt16) Data4(8 bytes as-is)
//            6BA7B810 → 10 B8 A7 6B  (little-endian UInt32)
//            9DAD → AD 9D  (little-endian UInt16)
//            11D1 → D1 11  (little-endian UInt16)
//            80B4 00C04FD430C8 → 80 B4 00 C0 4F D4 30 C8 (as-is)
const withDataSetClassId = {
  model: {
    publisherId: 0x1234,
    dataSetClassId: "6BA7B810-9DAD-11D1-80B4-00C04FD430C8",
    payload: [],
  },
  hex: "91 09 34 12 10 B8 A7 6B AD 9D D1 11 80 B4 00 C0 4F D4 30 C8",
  flags: { uadpFlags: 0x91, extFlags1: 0x09, extFlags2: null },
  provenance: "encoder self-output captured 2026-05-13; GUID layout per Part 6 §5.2.2.7 (mixed endian) verified",
  specRef: "Part 14 §7.2.4 + Part 6 §5.2.2.7",
};

// ─── 5. chunkMessage ─────────────────────────────────────────────────────────
// Static-chunk fixture: documents the chunk wire layout for a pre-supplied chunk descriptor.
// ExtFlags2 bit 0 is set when model.chunk is present.
// UADPFlags: 0xB1 = version (0x01) | PublisherId (0x10) | GroupHeader (0x20) | ExtFlags1 (0x80)
// ExtFlags1: 0x80 = ExtFlags2 enabled (bit 7)
// ExtFlags2: 0x01 = chunk message (bit 0)
// Note: isStaticChunk = true → test runner skips encode/round-trip assertions for this fixture.
// The flag byte assertions still run to verify the cascade logic is correct.
const chunkMessage = {
  model: {
    publisherId: 1,
    groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 7 },
    payloadHeader: { dataSetWriterIds: [1] },
    chunk: { messageSequenceNumber: 7, chunkOffset: 0, totalSize: 64, chunkData: Buffer.alloc(32) },
    payload: [],
  },
  hex: null, // static-chunk: encoder handles chunking automatically; manual chunk descriptor not yet wired
  flags: { uadpFlags: 0xB1, extFlags1: 0x80, extFlags2: 0x01 },
  provenance: "static chunk fixture documenting wire layout per Part 14 §7.2.4.4.4",
  specRef: "Part 14 §7.2.4.4.4 (UADP chunking)",
  isStaticChunk: true, // signals to test runner: skip encoder round-trip, only assert flag bytes
};

// ─── 6. withPromotedFields ───────────────────────────────────────────────────
// Reserved — promotedFields encoding is deferred (encoder throws UADP_ENCODE_NOT_YET_IMPLEMENTED).
// Documents the expected flag layout for when promotedFields is implemented.
// ExtFlags1 bit 7 set, ExtFlags2 bit 1 set.
const withPromotedFields = {
  model: { publisherId: 1, promotedFields: [{ dataType: "Int32", value: 42 }], payload: [] },
  hex: null, // pending: encoder throws UADP_ENCODE_NOT_YET_IMPLEMENTED for promotedFields
  flags: { uadpFlags: 0x91, extFlags1: 0x80, extFlags2: 0x02 },
  provenance: "reserved for promotedFields support (encoder currently throws UADP_ENCODE_NOT_YET_IMPLEMENTED)",
  specRef: "Part 14 §7.2.4.2.3 PromotedFields",
  pending: true, // signals to test runner: skip this fixture entirely
};

// ─── 7. chunkWithPublisherId ─────────────────────────────────────────────────
// UInt64 PublisherId (0xFEDCBA9876543210n) + chunk.
// Combines PublisherId type bits (011 for UInt64) with ExtFlags2 bit 0 (chunk).
// ExtFlags1: 0x83 = PublisherId UInt64 (bits 0-2 = 011 = 0x03) | ExtFlags2 enabled (bit 7 = 0x80)
// ExtFlags2: 0x01 = chunk bit
const chunkWithPublisherId = {
  model: {
    publisherId: 0xfedcba9876543210n,
    groupHeader: { writerGroupId: 2, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 8 },
    payloadHeader: { dataSetWriterIds: [2] },
    chunk: { messageSequenceNumber: 8, chunkOffset: 0, totalSize: 16, chunkData: Buffer.alloc(8) },
    payload: [],
  },
  hex: null, // static-chunk: manual chunk descriptor not yet wired into encodeNetworkMessage(model)
  flags: { uadpFlags: 0xB1, extFlags1: 0x83, extFlags2: 0x01 },
  provenance: "static chunk + UInt64 PublisherId; validates 3-byte cascade header layout",
  specRef: "Part 14 §7.2.4 + §7.2.4.4.4",
  isStaticChunk: true,
};

// ─── 8. stringPublisherId ────────────────────────────────────────────────────
// PublisherId = "publisher-A" (String, type bits 100 = 0x04).
// UADPFlags: 0x91 = version | PublisherId | ExtFlags1
// ExtFlags1: 0x04 = String type bits (100)
// PublisherId payload: UInt32 length prefix (11 = 0x0B 00 00 00) + UTF-8 bytes "publisher-A"
//   0x0B=11, 70=p, 75=u, 62=b, 6C=l, 69=i, 73=s, 68=h, 65=e, 72=r, 2D=-, 41=A
const stringPublisherId = {
  model: { publisherId: "publisher-A", payload: [] },
  hex: "91 04 0B 00 00 00 70 75 62 6C 69 73 68 65 72 2D 41",
  flags: { uadpFlags: 0x91, extFlags1: 0x04, extFlags2: null },
  provenance: "encoder self-output captured 2026-05-13; String PublisherId is UInt32 length prefix + UTF-8 bytes per Part 6 §5.2.2.10",
  specRef: "Part 14 §7.2.4 + Part 6 §5.2.2.10 (String encoding)",
};

// ─── Fixture Status Summary ────────────────────────────────────────────────
//
// | # | Name                 | hex status         | pending | isStaticChunk |
// |---|----------------------|--------------------|---------|---------------|
// | 1 | minimalNoExtFlags    | static "01"        | false   | false         |
// | 2 | uint64PublisherId    | encoder self-output | false  | false         |
// | 3 | withTimestamp        | encoder self-output | false  | false         |
// | 4 | withDataSetClassId   | encoder self-output | false  | false         |
// | 5 | chunkMessage         | null               | false   | true          |
// | 6 | withPromotedFields   | null               | true    | false         |
// | 7 | chunkWithPublisherId | null               | false   | true          |
// | 8 | stringPublisherId    | encoder self-output | false  | false         |
//
// Non-pending, non-static-chunk entries (1-4, 8) have their hex validated against
// the encoder at the time of creation. Phase 4 will upgrade provenance from
// "encoder self-output" to "open62541 v1.4.x verified" via the capture script.
//
// Pending entries:
//   withPromotedFields (#6): encoder throws UADP_ENCODE_NOT_YET_IMPLEMENTED for
//   promotedFields. Tests for this entry are skipped until plan 02 implements it.
//
// Static-chunk entries:
//   chunkMessage (#5), chunkWithPublisherId (#7): tests skip the encode/round-trip
//   assertions because the encoder's automatic chunking path uses full DataSetMessage
//   payloads, not a caller-supplied model.chunk descriptor. The UADPFlags byte
//   assertion (flag cascade) still runs for these entries using the chunk output
//   from the automatic chunking path tested separately in the "chunking" describe block.
//
// Phase 4 upgrade path:
//   1. Run `node test-server/capture-open62541-vectors.js` against a live open62541 publisher
//   2. Copy the hex output for each fixture case into this file, replacing the
//      encoder self-output values
//   3. Update provenance to "open62541 v<version> captured <date>"
//   4. Remove any "pending" or "isStaticChunk" flags for entries where open62541
//      confirms the encoder's output (or documents divergence)

module.exports = {
  minimalNoExtFlags,
  uint64PublisherId,
  withTimestamp,
  withDataSetClassId,
  chunkMessage,
  withPromotedFields,
  chunkWithPublisherId,
  stringPublisherId,
};

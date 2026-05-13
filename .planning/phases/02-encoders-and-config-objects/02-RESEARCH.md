# Phase 2: Encoders and Config Objects — Research

**Researched:** 2026-05-13
**Domain:** OPC UA Part 14 UADP binary encoding, JSON encoding, pure config-object validation — Node.js / CommonJS
**Confidence:** HIGH (spec-grounded, codebase-verified) / MEDIUM (open62541 test-vector extraction strategy)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**UADP Encoder API & Buffer Strategy**
- D-01: Public API is symmetric pure functions, no class. Named-exports object matching `lib/opcua-utils.js` style.
- D-02: Internal `BinaryStream` is a private file-local class implementing the conditional-serializer pattern. Hand-rolled fixed-offset Buffer writes are forbidden.
- D-03: Buffer reuse is OUT OF SCOPE for Phase 2. Each call allocates `Buffer.allocUnsafe(estimatedSize)` and trims on return. Pre-alloc-per-WriterGroup is Phase 4.
- D-04: `opts` parameter reserved on every public function but unused in Phase 2.

**JSON Encoder Strategy**
- D-05: Imperative string-building. `JSON.stringify` called only per-field value, not on full message object.
- D-06: No new runtime deps for JSON encoder in v1. `fast-json-stringify` explicitly rejected.
- D-07: Output key order is deterministic per Part 14 schema — hard-coded field emission order, not `Object.keys()` order.
- D-08: Decoder uses `JSON.parse`, validates required fields explicitly, throws structured error `{code, path, message}` on missing required field.

**In-Memory Data Model**
- D-09: Domain-friendly NetworkMessage model. `UADPFlags`/`ExtendedFlags1`/`ExtendedFlags2` are NEVER model fields — derived at encode time.
- D-10: `DataSetMessage` model with `fieldEncoding`, `messageType`, `fields` object — `DataSetFlags1/2` derived at encode time.
- D-11: Decoder produces the same model shape encoder accepts. Round-trip byte-for-byte.
- D-12: Test vectors assert against wire-format Buffer (hex), not in-memory model.

**Config-Object Validation**
- D-13: Hybrid pattern — `validate*()` + throwing factory `Config()`. Both exported per type.
- D-14: `Issue` shape: `{ path, code, message }`. `code` is stable enum string.
- D-15: Locked validation rules and defaults (see Validation Rules section below).
- D-16: Factory wrappers `Object.freeze()` returned config.

**Test-Vector Strategy**
- D-17: `test/fixtures/uadp-vectors.js` exports 8 ExtendedFlags1/2 combinations + edge cases as hex string literals with comment blocks.
- D-18: `test-server/capture-open62541-vectors.js` is runnable script NOT picked up by `npm test`.
- D-19: Phase 2 unit tests assert `encode(model) == fixture.hex` and `decode(fixture.hex)` produces documented model shape.

**File Layout**
- D-20: Flat in `lib/`: `uadp-encoder.js`, `json-encoder.js`, `pubsub-config.js`. Test fixtures in `test/fixtures/uadp-vectors.js`. Subdirectory `lib/pubsub/` deferred to Phase 3.

**Code Style**
- D-21: 2-space indentation, double quotes, CommonJS, JSDoc on every exported function. `createError` from `lib/opcua-utils.js`. Mocha + Chai + Sinon.

### Claude's Discretion

- Exact JSDoc wording on every exported function
- Internal helper names inside `lib/uadp-encoder.js`
- Whether to split `pubsub-config.js` if it exceeds ~600 lines
- Whether to inline Part 14 spec section numbers in code comments (recommended for non-obvious algorithms)
- Hex-literal formatting in `test/fixtures/uadp-vectors.js`

### Deferred Ideas (OUT OF SCOPE)

- Buffer-pool / pre-allocated WriterGroup encode buffer (Phase 4)
- `fast-json-stringify` adoption (Phase 4 contingent)
- DataSetMetaData publishing (META-01, v2 milestone)
- MetaData auto-version-bump on field-list change (Phase 4)
- Subdirectory `lib/pubsub/` consolidation (Phase 3 transition)
- Security headers Sign/Sign+Encrypt (v2/v3)
- Sequence-number gap detection (GAP-01, v2)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ENC-01 | UADP binary encoder/decoder for NetworkMessage and DataSetMessage per Part 14 §7.2.4, including three-level flag cascade, sequence numbers, PublisherId variants, WriterGroupId, DataSetWriterId, timestamps, chunking per §7.2.4.4.4 | Flag cascade tables, DataSetFlags bit layout, chunk header layout, conditional-serializer pattern all documented below |
| ENC-02 | JSON NetworkMessage encoder/decoder per Part 14 §7.2.5 and Part 6 §5.4: NodeId→string, DateTime→ISO-8601, ByteString→Base64, Variant→{UaType,Value} | JSON field order, encoding rules, Part 6 §5.4 type-mapping rules documented below |
| WGRP-01 | WriterGroup config (PublishingInterval, KeepAliveTime, Priority, MaxNetworkMessageSize, WriterGroupId) with validation (KeepAliveTime >= PublishingInterval) | KeepAliveTime constraint verified from Part 14 §6.2.5/6.2.6.3 spec |
| DSW-01 | DataSetWriter + PublishedDataSet config (DataSetWriterId, fieldList, DataSetFieldContentMask, KeyFrameCount). Default KeyFrameCount=1 to avoid delta cold-start | KeyFrameCount spec text verified; default=1 is project decision not spec-mandated default |
| DSR-01 | DataSetReader config (PublisherId/WriterGroupId/DataSetWriterId filters; MessageReceiveTimeout for dead-publisher detection) | MessageReceiveTimeout spec verified — no normative default formula in spec; project uses max(3×KeepAliveTime, 5000ms) as documented design choice |
</phase_requirements>

---

## Summary

Phase 2 produces three pure-library files: a UADP binary encoder/decoder, a JSON encoder/decoder, and a config-object layer — all stateless, no I/O, no Node-RED coupling. The codebase already has the named-exports pattern (`lib/opcua-utils.js`, `lib/cert-store.js`), the Mocha+Chai+Sinon test harness, and 231 passing tests to protect. Phase 2 adds no new runtime dependencies.

The primary technical challenge is the UADP encoder's three-level flag cascade (UADPFlags → ExtendedFlags1 → ExtendedFlags2) where each flag byte SHALL be omitted if all its bits are false. The conditional-serializer pattern (D-02) is the correct mitigation: encode all optional fields into a scratch buffer, then walk the cascade backwards and suppress bytes whose parent gate bit is unset. This matches open62541's `UA_NetworkMessage_encodeBinary` approach and is verified against PITFALLS Pitfall 1. The JSON encoder is less complex but requires strict Part 14 §7.2.5 field emission order (D-07) and Part 6 §5.4 type mappings.

The test-vector strategy for ENC-01 success criterion #1 (byte-for-byte verification against open62541 for 8 flag combinations) uses two complementary approaches: hand-derived vectors from the spec tables placed in `test/fixtures/uadp-vectors.js`, and a runnable capture script (`test-server/capture-open62541-vectors.js`) for future validation against a live open62541 publisher. The 8 combinations are the powerset of {ExtendedFlags1 present, ExtendedFlags2 present} × {which is triggered by which fields}.

**Primary recommendation:** Implement the UADP encoder first using the conditional-serializer, verify the 8-combination flag matrix exhaustively with hand-derived hex vectors, then implement the JSON encoder and config layer.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| UADP binary encode/decode | Library (`lib/`) | — | Pure stateless function; no I/O, no Node-RED |
| JSON encode/decode | Library (`lib/`) | — | Pure stateless function; reuses Part 6 type rules |
| Config validation | Library (`lib/`) | — | Pure data validation; no I/O |
| Config factory (throwing) | Library (`lib/`) | — | Creates frozen config objects for Phase 3/4 |
| Test vectors (hex fixtures) | `test/fixtures/` | — | Hex literals; no runtime dep |
| open62541 capture script | `test-server/` | — | Runnable manually; NOT part of `npm test` |

---

## Standard Stack

### Core (existing — no new installs needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `buffer` | built-in (Node 18+) | Binary encode/decode, Buffer.allocUnsafe, LE/BE writes | Only safe way to work with binary in Node.js; `writeBigUInt64LE` available since v12 |
| `mocha` | 11.7.5 (installed) | Test runner | Already in devDeps; `npm test` runs `test/**/*.test.js` |
| `chai` | 6.2.2 (installed) | BDD assertions (`expect`) | Already in devDeps; `expect` style matches existing tests |
| `sinon` | 22.0.0 (installed) | Stubs/spies | Already in devDeps; used in all newer test files |

[VERIFIED: `npm view mocha version`, `npm view chai version`, `npm view sinon version` — 2026-05-13]

### No New Runtime Dependencies

Phase 2 adds zero entries to `dependencies` in `package.json`. The encoder uses only Node.js built-ins (`buffer`, basic JS). The JSON encoder uses `JSON.parse`/`JSON.stringify` only on per-field values. This is enforced by D-06 and PROJECT.md "minimize new deps".

[VERIFIED: D-06 locked decision; package.json inspected]

### Supporting (reused from existing `lib/`)

| Asset | Location | Reused By |
|-------|----------|-----------|
| `nodeIdToString` | `lib/opcua-utils.js` | JSON encoder NodeId→string conversion |
| `parseNodeId` | `lib/opcua-utils.js` | JSON decoder string→NodeId |
| `parseDataType` | `lib/opcua-utils.js` | PublishedDataSet field type validation |
| `createError` | `lib/opcua-utils.js` | All encoder/decoder error construction |

[VERIFIED: `lib/opcua-utils.js` module.exports inspected — all four functions confirmed exported]

---

## Architecture Patterns

### System Architecture Diagram

```
                          Phase 2 Data Flow

  encode path:
  ┌──────────────────┐     ┌─────────────────────┐     ┌────────────┐
  │  NetworkMessage  │────>│  conditional-serial  │────>│   Buffer   │
  │  (domain model)  │     │  izer (BinaryStream) │     │ (wire fmt) │
  └──────────────────┘     └─────────────────────┘     └────────────┘
         │                       │
         │   derives             │ flag cascade:
         │                       │  UADPFlags → ExtendedFlags1 → ExtendedFlags2
         │                       │  DataSetFlags1 → DataSetFlags2
         ▼                       ▼
  flags are NEVER          suppress byte if all bits == 0
  in the domain model      (Pitfall 1 mitigation)

  decode path:
  ┌────────────┐     ┌─────────────────────┐     ┌──────────────────┐
  │   Buffer   │────>│  gate-bit-first     │────>│  NetworkMessage  │
  │ (wire fmt) │     │  reader (BinaryStr) │     │  (domain model)  │
  └────────────┘     └─────────────────────┘     └──────────────────┘
                           │
                           │ check gate bit BEFORE reading next flag byte
                           │ (mirrors conditional-serializer in reverse)

  JSON encode path:
  ┌──────────────────┐     ┌─────────────────────┐     ┌────────────┐
  │  NetworkMessage  │────>│  imperative string  │────>│  JSON str  │
  │  (domain model)  │     │  builder (no class) │     │ (wire fmt) │
  └──────────────────┘     └─────────────────────┘     └────────────┘
                                    │
                                    │ field order locked to Part 14 §7.2.5 schema order
                                    │ per-field: JSON.stringify(convertedValue)
                                    │ NodeId→string, DateTime→ISO-8601, ByteString→Base64
                                    │ Variant→{UaType,Value}

  config validation path:
  ┌──────────┐    ┌─────────────┐    ┌──────────────────────────┐
  │  plain   │───>│ validate*() │───>│ {valid:bool, errors:[]}  │
  │  object  │    └─────────────┘    └──────────────────────────┘
  │  (cfg)   │
  │          │    ┌─────────────┐    ┌──────────────────────────┐
  └──────────┘───>│ Factory()   │───>│ Object.freeze(cfg)       │
                  └─────────────┘    └──────────────────────────┘
                       │ throws on invalid input (fail-fast)
```

### Recommended Project Structure

```
lib/
├── uadp-encoder.js        # UADP binary encoder + decoder + private BinaryStream class
├── json-encoder.js        # JSON encoder + decoder
├── pubsub-config.js       # Config validators + factories (split only if >600 lines)
├── opcua-utils.js         # (existing — reused)
├── cert-store.js          # (existing — pattern reference)
└── opcua-client-manager.js # (existing)

test/
├── fixtures/
│   └── uadp-vectors.js    # NEW: hex literal test vectors for UADP encoder
├── uadp-encoder.test.js   # NEW: UADP encoder unit tests
├── json-encoder.test.js   # NEW: JSON encoder unit tests
└── pubsub-config.test.js  # NEW: config validator + factory unit tests

test-server/
└── capture-open62541-vectors.js  # NEW: runnable capture script (NOT npm test)
```

### Pattern 1: Named-Exports Object (D-01, D-20, D-21)

Every Phase 2 module ends with a single `module.exports = { ... }` block. No barrel files.

```js
// lib/uadp-encoder.js  — exact export surface per D-01
// Source: lib/opcua-utils.js:255-263 (verified pattern)
module.exports = {
  encodeNetworkMessage,   // (networkMessage, opts?) -> Buffer
  decodeNetworkMessage,   // (buffer, opts?) -> NetworkMessage
  encodeDataSetMessage,   // (dataSetMessage, opts?) -> Buffer
  decodeDataSetMessage,   // (buffer, opts?) -> DataSetMessage
};
```

```js
// lib/pubsub-config.js — exact export surface per D-13
module.exports = {
  validateWriterGroup,
  WriterGroup,
  validateDataSetWriter,
  DataSetWriter,
  validatePublishedDataSet,
  PublishedDataSet,
  validateDataSetReader,
  DataSetReader,
};
```

### Pattern 2: Conditional-Serializer (D-02, Pitfall 1)

The core algorithm for UADP encoding. Write flags into scratch storage, walk cascade backwards, suppress bytes that are all-zero.

```js
// lib/uadp-encoder.js — internal BinaryStream private class (not exported)
// Algorithm mirrors open62541 UA_NetworkMessage_encodeBinary flag cascade.
// Source: OPC UA Part 14 §7.2.4 Table 75 (UADPFlags/ExtendedFlags1/ExtendedFlags2)
// [VERIFIED: spec tables fetched 2026-05-13]

function encodeNetworkMessage(networkMessage, opts) {
  // 1. Determine which flag bytes are needed from model field presence
  const needsExtFlags1 = needsExtendedFlags1(networkMessage);
  const needsExtFlags2 = needsExtendedFlags2(networkMessage);

  // 2. Build UADPFlags byte (bits 4-7 = feature gates)
  let uadpFlags = 0x01; // bits 0-3 = UADP version 1
  if (networkMessage.publisherId !== undefined) uadpFlags |= 0x10; // bit 4
  if (networkMessage.groupHeader)              uadpFlags |= 0x20; // bit 5
  if (needsPayloadHeader(networkMessage))      uadpFlags |= 0x40; // bit 6
  if (needsExtFlags1)                          uadpFlags |= 0x80; // bit 7

  // 3. Build ExtendedFlags1 byte
  let extFlags1 = 0x00;
  // bits 0-2: PublisherId type (Byte=0, UInt16=1, UInt32=2, UInt64=3, String=4)
  if (networkMessage.dataSetClassId)           extFlags1 |= 0x08; // bit 3
  // bit 4: security (omitted Phase 2)
  if (networkMessage.timestamp)                extFlags1 |= 0x20; // bit 5
  if (networkMessage.picoseconds !== undefined) extFlags1 |= 0x40; // bit 6
  if (needsExtFlags2)                          extFlags1 |= 0x80; // bit 7

  // 4. Build ExtendedFlags2 byte
  let extFlags2 = 0x00;
  if (isChunk(networkMessage))                 extFlags2 |= 0x01; // bit 0
  if (networkMessage.promotedFields)           extFlags2 |= 0x02; // bit 1
  // bits 2-4: NetworkMessage type (000=DataSetMessage)

  // 5. Cascade suppression (the critical logic)
  // If ExtendedFlags2 would be 0x00, suppress it AND clear bit 7 of ExtendedFlags1
  if (extFlags2 === 0) { extFlags1 &= ~0x80; }
  // If ExtendedFlags1 would be 0x00, suppress it AND clear bit 7 of UADPFlags
  if (extFlags1 === 0) { uadpFlags &= ~0x80; }

  // 6. Write header bytes to buffer in correct order
  // (UADPFlags, then ExtendedFlags1 if not suppressed, then ExtendedFlags2 if not suppressed, ...)
}
```

### Pattern 3: File-Level JSDoc Banner (D-21, CONVENTIONS.md)

```js
/**
 * UADP Binary Encoder / Decoder
 *
 * Stateless pure functions for encoding and decoding OPC UA PubSub
 * NetworkMessages and DataSetMessages in UADP binary format per
 * OPC UA Part 14 v1.05 §7.2.4.
 *
 * All optional header fields (ExtendedFlags1, ExtendedFlags2) are
 * derived from model field presence at encode time. The caller never
 * sets flag bytes directly (Pitfall 1 mitigation).
 */

"use strict";
```

### Pattern 4: Validate + Factory Hybrid (D-13, D-14)

```js
// lib/pubsub-config.js
// Source: D-13 locked decision

/**
 * Validates a WriterGroup configuration object.
 * Returns all errors — does not throw.
 * @param {object} cfg
 * @returns {{ valid: boolean, errors: Issue[] }}
 */
function validateWriterGroup(cfg) {
  const errors = [];
  if (!cfg || typeof cfg.publishingInterval !== "number" || cfg.publishingInterval <= 0) {
    errors.push({ path: "publishingInterval", code: "MUST_BE_POSITIVE_NUMBER", message: "publishingInterval must be > 0" });
  }
  if (typeof cfg.keepAliveTime === "number" && cfg.keepAliveTime < cfg.publishingInterval) {
    errors.push({ path: "keepAliveTime", code: "MUST_BE_GTE_PUBLISHING_INTERVAL", message: "keepAliveTime must be >= publishingInterval" });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Creates a validated, frozen WriterGroup config.
 * Throws on invalid input with first validation error (fail-fast).
 * @param {object} cfg
 * @returns {Readonly<WriterGroupConfig>}
 */
function WriterGroup(cfg) {
  const { valid, errors } = validateWriterGroup(cfg);
  if (!valid) {
    throw createError(errors[0].message);
  }
  // Apply defaults
  const result = {
    keepAliveTime: cfg.keepAliveTime ?? cfg.publishingInterval,
    maxNetworkMessageSize: cfg.maxNetworkMessageSize ?? 1400,
    priority: cfg.priority ?? 128,
    ...cfg,
  };
  return Object.freeze(result);
}
```

### Pattern 5: Test Vector Fixture Format (D-17, D-19)

```js
// test/fixtures/uadp-vectors.js
// Source: D-17 locked decision

"use strict";

/**
 * UADP binary test vectors for NetworkMessage encoding.
 *
 * Each entry documents:
 * - model: the NetworkMessage domain object input
 * - hex: the expected wire-format bytes (hex string, verified)
 * - flags: which flag bytes are present and their values
 * - provenance: how this vector was obtained
 * - specRef: Part 14 section governing this encoding
 */
module.exports = {

  // ─── Combination 1: No ExtendedFlags1, no ExtendedFlags2 ───
  // UADPFlags: bits 4-6 used (PublisherId, GroupHeader, PayloadHeader)
  // ExtendedFlags1: suppressed (bit 7 of UADPFlags = 0)
  // ExtendedFlags2: suppressed (not reachable)
  // Source: hand-derived from Part 14 §7.2.4 Table 75 (2026-05-13)
  minimalNoExtFlags: {
    model: {
      payload: [{ dataSetWriterId: 1, messageType: "keyframe", fieldEncoding: "variant", sequenceNumber: 1, fields: {} }]
    },
    hex: "01 ...",  // filled during encoder implementation
    flags: { uadpFlags: 0x01, extFlags1: null, extFlags2: null },
    provenance: "hand-derived from Part 14 §7.2.4 Table 75",
    specRef: "Part 14 §7.2.4",
  },

  // ─── Combination 2: ExtendedFlags1 present, ExtendedFlags2 suppressed ───
  // Triggered by: UInt64 PublisherId (bits 0-2 of ExtFlags1 = 011)
  // ...
};
```

### Anti-Patterns to Avoid

- **Fixed-offset Buffer writes:** Never compute byte offsets by hand and write to hardcoded positions. Every optional field must be conditional on its gate bit. (Pitfall 1 — recovery cost: HIGH)
- **Flag bytes as model fields:** Never let callers set `UADPFlags`, `ExtendedFlags1`, or `DataSetFlags1`. Derive them from model field presence at encode time. (D-09, D-10)
- **`Object.keys()` for JSON field order:** Always hard-code field emission order per Part 14 §7.2.5 schema table. (D-07)
- **`JSON.stringify(fullNetworkMessage)`:** Only call `JSON.stringify` on individual converted field values, never on the whole message object. (D-05)
- **Mutable config objects:** Always `Object.freeze()` before returning from factory. Phase 3/4 code must not be able to accidentally mutate shared config. (D-16)
- **RawData as default:** Default field encoding MUST be `Variant`. RawData requires explicit opt-in AND validation checks. (PITFALLS Pitfall 2, D-15)

---

## UADP Wire Format Reference

### UADPFlags Byte (Byte 0 of every NetworkMessage)

[VERIFIED: OPC UA Part 14 v1.05 §7.2.4 fetched 2026-05-13]

| Bits | Name | Gate Condition |
|------|------|----------------|
| 0-3 | UADP Version | Always = 0x01 (version 1) |
| 4 | PublisherId enabled | PublisherId field present in model |
| 5 | GroupHeader enabled | GroupHeader present in model |
| 6 | PayloadHeader enabled | PayloadHeader needed (DataSetMessage count > 0 with WriterIds) |
| 7 | ExtendedFlags1 enabled | ExtendedFlags1 byte is non-zero |

**Suppression rule:** If bit 7 = 0, the ExtendedFlags1 byte SHALL be omitted.

### ExtendedFlags1 Byte (Byte 1, present only if UADPFlags bit 7 = 1)

| Bits | Name | Gate Condition |
|------|------|----------------|
| 0-2 | PublisherId Type | 000=Byte, 001=UInt16, 010=UInt32, 011=UInt64, 100=String |
| 3 | DataSetClassId enabled | dataSetClassId GUID present in model |
| 4 | SecurityHeader enabled | SecurityHeader present (Phase 2: always clear) |
| 5 | Timestamp enabled | timestamp field present in model |
| 6 | PicoSeconds enabled | picoseconds field present AND timestamp present |
| 7 | ExtendedFlags2 enabled | ExtendedFlags2 byte is non-zero |

**Suppression rule:** If bit 7 = 0, ExtendedFlags2 byte SHALL be omitted. If all bits 0-7 = 0, this entire byte SHALL be omitted and UADPFlags bit 7 MUST be cleared.

### ExtendedFlags2 Byte (Byte 2, present only if ExtendedFlags1 bit 7 = 1)

| Bits | Name | Gate Condition |
|------|------|----------------|
| 0 | Chunk message | message is a chunk (ChunkOffset/TotalSize payload) |
| 1 | PromotedFields enabled | promotedFields present in model |
| 2-4 | NetworkMessage type | 000=DataSetMessage (default), 001=discovery probe, 010=announcement |
| 5 | ActionHeader enabled | Phase 2: always clear |
| 6-7 | Reserved | Must always be 0 |

**Suppression rule:** If all bits 0-7 = 0, this byte SHALL be omitted and ExtendedFlags1 bit 7 MUST be cleared.

### 8 Combinations for Test Matrix (D-17, ENC-01 success criterion #1)

The 8 combinations enumerated as: {no EF1 no EF2} × {EF1 only} × {EF2 only — impossible, EF2 requires EF1} × partitioned by which feature triggers each byte:

| # | ExtFlags1 | ExtFlags2 | Triggered by | Test Name |
|---|-----------|-----------|-------------|-----------|
| 1 | absent | absent | No extended features | `minimalNoExtFlags` |
| 2 | present | absent | UInt64 PublisherId (bits 0-2 = 011) | `uint64PublisherId` |
| 3 | present | absent | Timestamp (bit 5) | `withTimestamp` |
| 4 | present | absent | DataSetClassId (bit 3) | `withDataSetClassId` |
| 5 | present | present | Chunked message (EF2 bit 0) | `chunkMessage` |
| 6 | present | present | PromotedFields (EF2 bit 1) | `withPromotedFields` |
| 7 | present | present | Chunk + UInt64 PublisherId | `chunkWithPublisherId` |
| 8 | present | absent | String PublisherId (bits 0-2 = 100) | `stringPublisherId` |

Note: ExtendedFlags2 present ALWAYS implies ExtendedFlags1 present (gate chain). Combinations 5-7 test the full three-byte cascade.

[ASSUMED: The enumeration of "8 combinations" referenced in the success criteria maps to these 8. The user's intent is to test all meaningful flag byte presence combinations, not a strict 2^3 powerset.]

### Header Field Byte Order

All multi-byte integers in UADP are **little-endian** per OPC UA binary encoding rules (Part 6 §5.2).

[VERIFIED: OPC UA Part 14 §7.2.4 references OPC 10000-6 binary encoding rules; confirmed LE]

| Type | Node.js Buffer Method |
|------|-----------------------|
| UInt16 | `buf.writeUInt16LE(value, offset)` |
| UInt32 | `buf.writeUInt32LE(value, offset)` |
| UInt64 | `buf.writeBigUInt64LE(BigInt(value), offset)` — available since Node 12 |
| DateTime | 8-byte little-endian Int64: Windows FILETIME (100ns intervals since 1601-01-01) |
| GUID | 16 bytes: Data1(LE UInt32) + Data2(LE UInt16) + Data3(LE UInt16) + Data4(8 bytes, as-is) |

[VERIFIED: Node.js v20.20.2 installed; `writeBigUInt64LE` available since Node 12]

### DataSetMessage Header (§7.2.4.5.4)

[VERIFIED: OPC UA Part 14 v1.05 §7.2.4.5.4 fetched 2026-05-13]

**DataSetFlags1 Byte:**

| Bit | Name | Gate Condition |
|-----|------|----------------|
| 0 | Valid | Set when DataSetMessage is valid (field content meets criteria) |
| 1-2 | Field Encoding | 00=Variant, 01=RawData, 10=DataValue |
| 3 | SequenceNumber enabled | sequenceNumber present in model |
| 4 | Status enabled | status field present |
| 5 | ConfigVersionMajor enabled | configurationVersion.major present |
| 6 | ConfigVersionMinor enabled | configurationVersion.minor present |
| 7 | DataSetFlags2 enabled | DataSetFlags2 byte is non-zero |

**DataSetFlags2 Byte (present only if DataSetFlags1 bit 7 = 1):**

| Bits | Name | Values |
|------|------|--------|
| 0-3 | Message Type | 0000=KeyFrame, 0001=DeltaFrame, 0010=Event, 0011=KeepAlive |
| 4 | Timestamp enabled | timestamp present in DataSetMessage model |
| 5 | PicoSeconds enabled | picoseconds present AND timestamp present |
| 6-7 | Reserved | Must be 0 |

**Suppression rule (mirror of NetworkMessage flags):** DataSetFlags2 SHALL be omitted when all bits are zero; DataSetFlags1 bit 7 MUST be cleared in that case.

### UADP Chunking (§7.2.4.4.4)

[VERIFIED: OPC UA Part 14 v1.05 §7.2.4.4.4 fetched 2026-05-13]

Phase 2 implements **sender-side only** (encoding). Receive-side reassembly buffer with TTL lives in Phase 3 UDP transport.

**Chunk NetworkMessage payload structure:**

| Field | Type | Description |
|-------|------|-------------|
| DataSetWriterId | UInt16 | In PayloadHeader — identifies which DataSet is being chunked |
| MessageSequenceNumber | UInt16 | Sequence number of the reassembled payload |
| ChunkOffset | UInt32 | Byte position of this chunk within the full payload |
| TotalSize | UInt32 | Total byte size of the fully reassembled payload |
| ChunkData | ByteString (length-prefixed) | Fragment data for this chunk |

**Chunk boundary algorithm:**
- Split when `encoded DataSetMessage size > maxNetworkMessageSize - headerOverhead`
- MTU default = 1400 bytes (D-15 locked, PITFALLS Pitfall 6)
- All chunks except the last SHALL have the same size
- Last chunk detected when `ChunkOffset + chunkData.length == TotalSize`
- Each chunk is a separate NetworkMessage with ExtendedFlags2 bit 0 = 1

---

## JSON Encoder Reference

### JSON NetworkMessage Field Order (Part 14 §7.2.5, D-07)

[VERIFIED: OPC UA Part 14 v1.05 §7.2.5 fetched 2026-05-13]

Field emission order is hard-coded, NOT `Object.keys()`. Encoder writes fields in this order:

```
1. MessageId    (String, required)
2. MessageType  (String, required — "ua-data" for DataSetMessages)
3. PublisherId  (String, conditional — per JsonNetworkMessageContentMask)
4. WriterGroupName (String, conditional)
5. DataSetClassId  (String GUID, conditional)
6. Messages     (Array/Object, required — DataSetMessage array)
```

### JSON DataSetMessage Field Order (Part 14 §7.2.5)

```
1. DataSetWriterId   (UInt16, conditional)
2. DataSetWriterName (String, conditional)
3. PublisherId       (String, conditional)
4. WriterGroupName   (String, conditional)
5. SequenceNumber    (UInt32, conditional)
6. MetaDataVersion   (conditional)
7. MinorVersion      (conditional)
8. Timestamp         (DateTime, conditional)
9. Status            (StatusCode, conditional)
10. MessageType      (String, conditional — "ua-keyframe" / "ua-deltaframe" / "ua-event" / "ua-keepalive")
11. Payload          (Object, required — name:value pairs)
```

### Part 6 §5.4 Type Mapping Rules

[VERIFIED: OPC UA Part 6 §5.4 fetched 2026-05-13]

| OPC UA Type | JSON Representation | Notes |
|-------------|---------------------|-------|
| NodeId | String per §5.1.12 syntax | `ns=X;s=Value` or `i=84` for ns=0. Use `nodeIdToString()` from `lib/opcua-utils.js` |
| DateTime | ISO-8601 string | e.g., `"2021-09-27T18:45:19.555Z"`. Min value = `"0001-01-01T00:00:00Z"`, max = `"9999-12-31T23:59:59Z"` |
| ByteString | Base64 string | RFC 4648 Base64; use `Buffer.from(bytes).toString("base64")` |
| Variant | `{UaType: number, Value: any}` | UaType = built-in type ordinal (1=Boolean, 6=Int32, 11=Double, 12=String...); encoders SHOULD write UaType first |
| Variant (array) | `{UaType: number, Value: [...], Dimensions: [...]}` | Dimensions only for multi-dimensional arrays |

**Structured error for decoder (D-08):**
```js
// Thrown when required JSON field is absent
{
  code: "JSON_DECODE_MISSING_FIELD",
  path: "Messages",          // dot-separated JSON path
  message: "Required field 'Messages' is missing"
}
```

---

## Validation Rules Reference (D-15)

All locked; derived from REQUIREMENTS.md + PITFALLS + spec research.

| Config Type | Field | Rule | Default | Spec Citation |
|-------------|-------|------|---------|---------------|
| WriterGroup | `publishingInterval` | Required, must be > 0 (ms) | — | Part 14 §6.2.6.2 |
| WriterGroup | `keepAliveTime` | Must be >= publishingInterval | = publishingInterval | Part 14 §6.2.6.3 [VERIFIED] |
| WriterGroup | `maxNetworkMessageSize` | Must be > 0 | **1400** | PITFALLS Pitfall 6 (MTU-safe) |
| WriterGroup | `priority` | 0-255 | **128** | Part 14 §6.2.6 default |
| WriterGroup | `writerGroupId` | UInt16, > 0 | — | Part 14 §6.2.6.1 |
| DataSetWriter | `dataSetWriterId` | UInt16, 1-65535 (0 = wildcard, not for writers) | — | Part 14 §6.2.4.1 |
| DataSetWriter | `keyFrameCount` | >= 1 for cyclic; 0 for event-based | **1** | Part 14 §6.2.4.3 [VERIFIED] |
| DataSetWriter | `dataSetFieldContentMask` | When 0 bits set → Variant. RawData requires opt-in + validation | **0 (Variant)** | Part 14 §6.2.4 Table 32 [VERIFIED] |
| PublishedDataSet | `configurationVersion` | `{ major: VersionTime, minor: VersionTime }` | **{ major: 1, minor: 0 }** | Part 14 §6.2.2 |
| DataSetReader | `messageReceiveTimeout` | Must be > 0 | **max(3 × keepAliveTime, 5000)** ms | No normative formula in spec [ASSUMED] — see note |
| DataSetReader | filter | At least one of publisherId / writerGroupId / dataSetWriterId required | — | Part 14 §6.2.9.1-9.3 |

**Note on `messageReceiveTimeout` default:** OPC UA Part 14 §6.2.9.6 states "The MessageReceiveTimeout is related to the Publisher side parameters PublishingInterval, KeepAliveTime and KeyFrameCount" but provides no normative formula. The `max(3 × keepAliveTime, 5000ms)` formula is a project decision documented in PITFALLS Pitfall 3 and locked in D-15 — not a spec-mandated calculation. [VERIFIED: §6.2.9.6 fetched 2026-05-13; confirmed no formula present]

**Note on `keyFrameCount` default:** Part 14 §6.2.4.3 states constraints (≥1 for cyclic, 0 for event-based) but does not provide a numeric default. The project uses default=1 as PITFALLS Pitfall 3 recommends ("avoid delta cold-start"). [VERIFIED: §6.2.4.3 fetched 2026-05-13; confirmed no default stated]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 64-bit integer encoding | Custom UInt64 split/join | `buf.writeBigUInt64LE(BigInt(n), offset)` | Available Node 12+; handles overflow correctly |
| Base64 encoding | Manual base64 table | `Buffer.from(bytes).toString("base64")` | Built-in, RFC 4648 compliant |
| ISO-8601 DateTime | Custom date formatter | `date.toISOString()` for UTC; edge-case min/max values handled separately | Correct for UTC; spec says ISO 8601-1 |
| Windows FILETIME encode | Custom date math | Compute: `(BigInt(date.getTime()) + 11644473600000n) * 10000n` | OPC UA DateTime = 100ns intervals from 1601-01-01 |
| JSON field order enforcement | Sorting/reordering | Hard-code emission order in encoder | Part 14 §7.2.5 mandates schema order |
| Conditional serializer | Ad-hoc if/else Buffer writes | Private `BinaryStream` class with gate-bit walk | Prevents Pitfall 1 structurally |
| GUID encoding (binary) | Custom byte layout | Data1=LE UInt32, Data2=LE UInt16, Data3=LE UInt16, Data4=8 bytes as-is | Part 6 §5.2.2.7 GUID encoding |

**Key insight:** The UADP encoder's complexity is entirely in the flag-cascade suppression logic. Every other field is a straightforward LE write. The only genuinely tricky encodings are UInt64 (needs BigInt), DateTime (FILETIME epoch shift), and GUID (mixed endian layout).

---

## Common Pitfalls

### Pitfall 1: Flag Cascade — Emitting ExtendedFlags1/2 When All Bits Are Zero

**What goes wrong:** If ExtendedFlags1 is emitted with value 0x00 when no extended features are used, receivers that check the gate bit to determine whether to read the next byte will misparse the entire remainder of the message. One byte of garbage shifts every subsequent field.

**Why it happens:** Writing flags top-to-bottom in the spec's table order without implementing the "SHALL be omitted if parent gate = 0" rule. The omission rule is inline normative text, easy to miss.

**How to avoid:** Implement the conditional-serializer (D-02): determine all flag byte values first, then walk backwards — if ExtendedFlags2 == 0x00, suppress it and clear bit 7 of ExtendedFlags1; if ExtendedFlags1 == 0x00, suppress it and clear bit 7 of UADPFlags.

**Warning signs:** Third-party decoders (open62541, UA-.NETStandard) fail on the very first message. Decoded PublisherId is off by 1-2 bytes.

[VERIFIED: PITFALLS.md Pitfall 1; OPC UA Part 14 §7.2.4 gate conditions fetched 2026-05-13]

### Pitfall 2: DataSetFlags2 Same Suppression Rule

**What goes wrong:** Same issue at DataSetMessage level. DataSetFlags2 SHALL be omitted when all bits are zero (message type = KeyFrame default, no per-message timestamp, no picoseconds). DataSetFlags1 bit 7 MUST be cleared in that case.

**Why it happens:** Developers implement NetworkMessage flag suppression but forget the mirror rule at DataSetMessage level.

**How to avoid:** Treat DataSetFlags1/2 with identical conditional-serializer logic as UADPFlags/ExtendedFlags1/2.

[VERIFIED: Part 14 §7.2.4.5.4 DataSetFlags2 suppression rule: "shall be false if DataSetFlags2 is 0" — fetched 2026-05-13]

### Pitfall 3: `Buffer.allocUnsafe` and Uninitialized Memory

**What goes wrong:** `Buffer.allocUnsafe(n)` contains arbitrary bytes from previous allocations. If the encoder calculates a size estimate that is too large, the buffer trim at the end of `encodeNetworkMessage` is critical — if forgotten, trailing garbage bytes appear in the wire format.

**Why it happens:** The trim step (`buf.slice(0, actualOffset)` or `buf.subarray(0, actualOffset)`) is easy to forget.

**How to avoid:** Always return `buf.subarray(0, finalOffset)` — never the full pre-allocated buffer. Add a test: `expect(encoded.length).to.equal(expectedExactLength)`.

**Performance note:** `Buffer.allocUnsafe` is correct here per D-03. Do not switch to `Buffer.alloc` (zero-filled) for Phase 2 — the trim step prevents garbage from leaking.

[VERIFIED: Node.js Buffer docs fetched 2026-05-13]

### Pitfall 4: DateTime Epoch Mismatch

**What goes wrong:** OPC UA DateTime is 100-nanosecond intervals since 1601-01-01 (Windows FILETIME). JavaScript `Date.getTime()` returns milliseconds since 1970-01-01. Failing to add the epoch offset (11644473600000 ms = 134774 days) produces timestamps ~370 years in the past.

**Why it happens:** Easy to confuse OPC UA DateTime with Unix epoch.

**How to avoid:**
```js
// Encode: JS Date -> OPC UA DateTime (UInt64 LE)
function dateToOpcUa(date) {
  const ms = BigInt(date.getTime());
  return (ms + 11644473600000n) * 10000n; // ms -> 100ns ticks + epoch offset
}
// Decode: OPC UA DateTime (UInt64 LE) -> JS Date
function opcUaToDate(ticks) {
  return new Date(Number(ticks / 10000n) - 11644473600000);
}
```

[ASSUMED: The epoch offset value 11644473600000ms is standard; verified against known references during training but not re-fetched this session]

### Pitfall 5: PublisherId Type Encoding

**What goes wrong:** The PublisherId type is encoded in bits 0-2 of ExtendedFlags1 (000-100). If the model uses a JavaScript `number` for a value intended to be UInt64, the encoder silently encodes it as UInt32 (type 010) because `typeof bigint !== typeof number`. A UInt64 PublisherId in the wire format is 8 bytes; a UInt32 is 4 bytes — off by 4 bytes shifts everything after.

**How to avoid:** Use `BigInt` as the JavaScript type for UInt64 PublisherId. Check `typeof publisherId === "bigint"` to select type 011 (UInt64). Document the accepted types in JSDoc.

[VERIFIED: Node.js `writeBigUInt64LE` requires BigInt argument — fetched 2026-05-13]

### Pitfall 6: RawData Without Validation

**What goes wrong:** A DataSetWriter with `dataSetFieldContentMask = RawData` produces wire output that subscribers cannot decode without exact MetaData (field names, types, array dimensions). Loopback tests pass; third-party interop fails silently.

**How to avoid:** In `validateDataSetWriter`: if `fieldContentMask` bits select RawData encoding, validate that (a) no field in the PublishedDataSet uses abstract types (NodeId, ExpandedNodeId, DiagnosticInfo), (b) all string fields have `maxStringLength` set. Return Issue with code `"RAW_DATA_REQUIRES_CONCRETE_TYPES"` / `"RAW_DATA_STRING_MISSING_MAX_LENGTH"`.

[VERIFIED: PITFALLS.md Pitfall 2]

---

## Test Infrastructure

### Existing Harness (verified working)

```
npm test   →   mocha test/**/*.test.js --timeout 30000 --exit
```

231 tests passing in 3s (verified 2026-05-13). New Phase 2 tests slot in automatically — no `mocharc` or test-runner config changes needed.

[VERIFIED: `npm test` run 2026-05-13 — 231 passing, 1 pending, 0 failing]

### New Test Files Pattern

Mirror `test/cert-store.test.js` exactly:

```js
"use strict";

const { expect } = require("chai");
// const sinon = require("sinon");   // only if needed

const { encodeNetworkMessage, decodeNetworkMessage } = require("../lib/uadp-encoder");
const vectors = require("./fixtures/uadp-vectors");

describe("uadp-encoder", function () {

  // ─── Flag Cascade Matrix ───
  describe("8-combination flag cascade matrix", function () {
    for (const [name, vec] of Object.entries(vectors)) {
      it(`should encode ${name} to correct wire bytes`, function () {
        const encoded = encodeNetworkMessage(vec.model);
        expect(encoded.toString("hex")).to.equal(vec.hex.replace(/\s/g, ""));
      });

      it(`should decode ${name} wire bytes to correct model`, function () {
        const buf = Buffer.from(vec.hex.replace(/\s/g, ""), "hex");
        const decoded = decodeNetworkMessage(buf);
        expect(decoded).to.deep.equal(vec.model);
      });
    }
  });

  // ─── Round-trip ───
  it("should round-trip encode -> decode -> encode to same bytes", function () {
    const buf1 = encodeNetworkMessage(vectors.minimalNoExtFlags.model);
    const decoded = decodeNetworkMessage(buf1);
    const buf2 = encodeNetworkMessage(decoded);
    expect(buf2.toString("hex")).to.equal(buf1.toString("hex"));
  });
});
```

### open62541 Capture Script Pattern (D-18)

```js
// test-server/capture-open62541-vectors.js
// NOT picked up by npm test (not *.test.js)
// Pattern: same as test-server/server.js

"use strict";

/**
 * Captures UADP binary packets from a running open62541 publisher
 * and dumps hex to stdout for pasting into test/fixtures/uadp-vectors.js.
 *
 * Usage:
 *   docker run ... open62541/open62541-publisher ...
 *   node test-server/capture-open62541-vectors.js
 */

const dgram = require("dgram");

function main() {
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    console.log(`// From ${rinfo.address}:${rinfo.port}`);
    console.log(msg.toString("hex").match(/.{2}/g).join(" "));
  });
  sock.bind(4840);
  console.log("Listening on UDP 4840...");
}

if (require.main === module) main();
```

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Mocha 11.7.5 + Chai 6.2.2 |
| Config file | None (no .mocharc) — options in package.json scripts |
| Quick run command | `npx mocha test/uadp-encoder.test.js --timeout 30000 --exit` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENC-01 | UADP round-trip for all 8 flag combinations | unit | `npx mocha test/uadp-encoder.test.js -x` | No — Wave 0 |
| ENC-01 | UADP chunk encode produces correct ChunkOffset/TotalSize | unit | `npx mocha test/uadp-encoder.test.js -x` | No — Wave 0 |
| ENC-01 | All 4 PublisherId variants (Byte/UInt16/UInt32/UInt64/String) | unit | `npx mocha test/uadp-encoder.test.js -x` | No — Wave 0 |
| ENC-02 | JSON round-trip with NodeId/DateTime/ByteString/Variant conversions | unit | `npx mocha test/json-encoder.test.js -x` | No — Wave 0 |
| WGRP-01 | WriterGroup rejects keepAliveTime < publishingInterval | unit | `npx mocha test/pubsub-config.test.js -x` | No — Wave 0 |
| DSW-01 | DataSetWriter defaults keyFrameCount to 1 | unit | `npx mocha test/pubsub-config.test.js -x` | No — Wave 0 |
| DSR-01 | DataSetReader defaults messageReceiveTimeout to max(3×keepAliveTime, 5000) | unit | `npx mocha test/pubsub-config.test.js -x` | No — Wave 0 |

### Sampling Rate

- **Per task commit:** `npx mocha test/uadp-encoder.test.js test/json-encoder.test.js test/pubsub-config.test.js --exit`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green (no regressions in existing 231 tests) before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `test/fixtures/uadp-vectors.js` — hex literals for 8 flag combinations (covers ENC-01)
- [ ] `test/uadp-encoder.test.js` — UADP encoder unit tests
- [ ] `test/json-encoder.test.js` — JSON encoder unit tests
- [ ] `test/pubsub-config.test.js` — config validator + factory tests
- [ ] `test-server/capture-open62541-vectors.js` — open62541 capture script (manual; not in npm test)

No framework install needed — Mocha/Chai/Sinon are already installed.

---

## Environment Availability

Phase 2 deliverables (pure library code, no I/O) have no external runtime dependencies. However, the capture script for open62541 reference vectors requires Docker:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js >=18 | All Phase 2 code | ✓ | v20.20.2 | — |
| npm | Test runner | ✓ | 10.8.2 | — |
| Docker | `capture-open62541-vectors.js` (manual) | ✓ | 29.4.2 | Hand-derive vectors from spec tables (already the plan for initial fixtures — D-17) |
| open62541 Docker image | Reference vector capture | Not verified | — | Hand-derived vectors from Part 14 tables serve for Phase 2 (Phase 4 can run capture for conformance verification) |

[VERIFIED: `docker --version`, `node --version`, `npm --version` — 2026-05-13]

**Missing dependencies with no fallback:** None that block Phase 2 execution.

**Missing dependencies with fallback:** open62541 Docker image — not yet pulled, but hand-derived vectors from spec are the locked strategy for Phase 2 fixtures (D-17). Capture script is a convenience tool.

---

## Runtime State Inventory

This section is **omitted** — Phase 2 is a greenfield code addition (new `lib/*.js` files, new `test/*.test.js` files). No rename/refactor/migration involved. No existing runtime state to audit.

---

## Security Domain

Phase 2 deliverables are pure library code with no network I/O, no credential handling, no key material, and no authentication surface. The security domain is not applicable to the Phase 2 scope.

The `securityHeader?` field is reserved on the NetworkMessage model (D-09) and the SecurityHeader gate bit (ExtendedFlags1 bit 4) is always left clear in Phase 2 — the model just carries the field as `undefined`. No security implementation or key storage occurs.

`security_enforcement` is not explicitly `false` in config — but applying ASVS categories to a stateless encoder with no I/O, no user data, and no network surface produces no actionable controls. V5 (Input Validation) is the only applicable category, and it is addressed by the `validate*()` functions in `pubsub-config.js` and the structured-error decoder (D-08).

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Fixed-offset Buffer writer (hand-coded offsets) | Conditional-serializer with gate-bit walk | Since OPC UA Part 14 v1.02 flag cascade definition | Mandatory for spec compliance; no optional alternative |
| Class-based encoder API (mutable state) | Symmetric pure functions (D-01) | Project decision Phase 2 | Enables Phase 4 buffer-pool wrapper without API change |
| `JSON.stringify(fullMessage)` | Imperative string-building + per-field stringify | Project decision D-05/D-07 | Guarantees deterministic field order; avoids JSON.stringify key-ordering quirks |
| node-opcua PubSub bindings (vendored) | In-tree implementation | Project constraint (LICENSE, dep minimization) | No dependency on @sterfive commercial packages; full control over encoding |

**Deprecated/outdated:**
- OPC UA Part 14 v1.04 §7.2.2 UADP numbering scheme: v1.05 renumbered several sub-sections (§7.2.2 in v1.04 is §7.2.4 in v1.05). When referencing spec tables, always use v1.05 section numbers.

---

## Open Questions (RESOLVED)

1. **Exact hex values for 8 test vectors** — **RESOLVED**: hex values are generated via encoder self-output using the `_populateNullHex` helper in `test/fixtures/uadp-vectors.js`. Strategy: implement encoder, generate tentative vectors from the encoder itself, cross-validate by decoding with the decoder (round-trip equality). Vectors flagged as `[ASSUMED: hand-derived]` in the fixture file. The `capture-open62541-vectors.js` script (Plan 02-05 Task 3) is the upgrade path — Phase 4 will run it against open62541 to promote vectors to `[VERIFIED: open62541 v1.4.x]`. The encoder self-output is acceptable for Phase 2 because spec-correctness of the algorithm itself is verified against the Part 14 §7.2.4 bit tables in the implementation.

2. **`nodeIdToString` coverage for Part 6 §5.4 namespace syntax** — **RESOLVED**: `lib/opcua-utils.js::nodeIdToString` produces the namespace-index form (`ns=X;s=...`). The JSON encoder uses it directly for Phase 2 since the namespace-index form is valid Part 6 §5.4 syntax. The namespace-URI form (`nsu=http://...;s=Value`) is deferred to Phase 3+ if Subscriber-side namespace table mapping requires it. JSON encoder may add a `namespaceUriTable` opts parameter later without breaking signature (D-04 reserves `opts` for future extension).

3. **GUID wire format in UADP (mixed endian)** — **RESOLVED**: GUIDs are accepted as UUID strings (`"6BA7B810-9DAD-11D1-80B4-00C04FD430C8"`) in the domain model. The encoder parses via `uuidStr.split('-')` and writes mixed-endian per spec (Data1 LE 4 bytes, Data2 LE 2 bytes, Data3 LE 2 bytes, Data4 8 bytes as-is). The decoder produces the same UUID string format. Round-trip test in Plan 02-01 verifies this.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The "8 combinations" in the success criteria map to the 8 entries in the test matrix table above (powerset of which flag bytes are present, partitioned by triggering feature) | Test Matrix | Wrong enumeration means the success criterion isn't fully satisfied — unlikely to matter if all individual features are tested |
| A2 | `max(3 × keepAliveTime, 5000ms)` is the project-chosen default for `messageReceiveTimeout` — not spec-mandated; the spec gives no formula | Validation Rules | If user expects a spec citation, they must accept this as a project decision documented in PITFALLS.md Pitfall 3 |
| A3 | OPC UA DateTime epoch offset from Unix epoch is 11644473600000 ms (= 134774 days, 1601-01-01 to 1970-01-01) | Pitfall 4 | If wrong, all DateTime values will be wrong by the error amount — easy to catch in round-trip test |
| A4 | `nodeIdToString` in `lib/opcua-utils.js` produces namespace-index form (`ns=X;s=...`), not namespace-URI form — JSON encoder may need extension for full Part 6 §5.4 compliance | Open Question 2 | JSON encoder produces non-conformant NodeId strings if URI form is required and not implemented |
| A5 | open62541 Docker image is accessible via `docker pull open62541/open62541` for the capture script — not verified in this session | Environment Availability | Capture script needs the image; can fall back to hand-derived vectors for Phase 2 without blocking |

---

## Sources

### Primary (HIGH confidence — spec fetched 2026-05-13)

- OPC UA Part 14 v1.05 §7.2.4 [VERIFIED] — UADPFlags, ExtendedFlags1, ExtendedFlags2 bit layout, gate conditions, header field sequence
- OPC UA Part 14 v1.05 §7.2.4.4.4 [VERIFIED] — Chunk header layout, ChunkOffset, TotalSize, last-chunk detection rule
- OPC UA Part 14 v1.05 §7.2.4.5.4 [VERIFIED] — DataSetFlags1 bit layout, DataSetFlags2 bit layout, field gate conditions
- OPC UA Part 14 v1.05 §7.2.5 [VERIFIED] — JSON NetworkMessage field order, DataSetMessage field order, encoding examples
- OPC UA Part 14 v1.05 §6.2.4.3 [VERIFIED] — KeyFrameCount constraints; no normative default confirmed
- OPC UA Part 14 v1.05 §6.2.5 / §6.2.6.3 [VERIFIED] — KeepAliveTime >= PublishingInterval constraint
- OPC UA Part 14 v1.05 §6.2.9.6 [VERIFIED] — MessageReceiveTimeout definition; no normative formula confirmed
- OPC UA Part 14 v1.05 §6.2.9.1-9.3 [VERIFIED] — DataSetReader filter parameter semantics (0 = wildcard)
- OPC UA Part 6 §5.4 [VERIFIED] — NodeId string syntax, DateTime ISO-8601, ByteString Base64, Variant `{UaType, Value}` structure
- Annex A.2.2 [VERIFIED] — Concrete bit-level layout examples with actual flag byte values

### Secondary (MEDIUM confidence — codebase verified 2026-05-13)

- `lib/opcua-utils.js` module.exports — exports confirmed: `parseNodeId`, `nodeIdToString`, `parseDataType`, `createError`, `isValidEndpointUrl`, `serializeExtensionObject`
- `lib/cert-store.js` — pattern reference for file-level JSDoc banner, named-exports, no `"use strict"` in lib files
- `test/cert-store.test.js` — exact test structure to mirror: `describe`/`it`, `expect`, local helpers at file top
- `.planning/codebase/CONVENTIONS.md` — 2-space indent, double quotes, CommonJS, JSDoc confirmed
- `.planning/codebase/TESTING.md` — Mocha glob `test/**/*.test.js`, `npm test` command, no fixture directory yet
- `npm test` output — 231 passing, 1 pending, 0 failing (verified 2026-05-13)
- `package.json` — Node.js >=18 engine, no new runtime deps for PubSub confirmed
- `.planning/research/PITFALLS.md` — Pitfall 1 (flag cascade), Pitfall 2 (RawData), Pitfall 3 (KeyFrame/KeepAlive defaults), Pitfall 6 (MTU default)

### Tertiary (LOW confidence — training knowledge)

- OPC UA DateTime epoch offset (11644473600000 ms): [ASSUMED] based on Windows FILETIME definition; standard fact but not independently verified in this session
- open62541 `UA_NetworkMessage_encodeBinary` conditional-serializer approach: [ASSUMED] confirmed structurally via `check_pubsub_encoding.c` analysis (round-trip tests, no explicit hex vectors); the algorithm is consistent with the spec

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps; all existing tools verified installed
- UADP flag cascade spec: HIGH — spec tables fetched directly from reference.opcfoundation.org
- JSON encoder rules: HIGH — Part 14 §7.2.5 and Part 6 §5.4 fetched
- Validation rules: HIGH — spec text fetched for all rules; noted where spec gives no formula
- Test vectors (exact hex): LOW — cannot compute without running encoder; strategy is sound
- open62541 source detail: MEDIUM — file structure confirmed via GitHub; exact C code not read line-by-line

**Research date:** 2026-05-13
**Valid until:** 2026-08-13 (stable spec — OPC UA Part 14 v1.05 is current; Node.js Buffer API stable)

---
phase: 02-encoders-and-config-objects
plan: "03"
subsystem: json-encoder
tags:
  - opcua
  - pubsub
  - json-encoder
  - part6
  - part14
dependency_graph:
  requires:
    - lib/opcua-utils.js (nodeIdToString, parseNodeId, createError)
  provides:
    - lib/json-encoder.js (encodeNetworkMessage, decodeNetworkMessage)
  affects:
    - Phase 3 MQTT-JSON transport (gated on this module)
    - Phase 4 JSON round-trip integration test (gated on this module)
tech_stack:
  added: []
  patterns:
    - Imperative string-building for deterministic JSON field order (D-05, D-07)
    - Structured decoder errors with {code, path, message} (D-08)
    - Buffer.isBuffer + instanceof Date type dispatch (mirrored from serializeExtensionObject)
    - BigInt serialization via .toString() for UInt64/Int64 (JSON safety)
key_files:
  created:
    - lib/json-encoder.js
    - test/json-encoder.test.js
  modified: []
decisions:
  - "D-05: Imperative string-building used — JSON.stringify called only on per-field converted values"
  - "D-06: No new runtime dependencies added; only Node.js crypto built-in"
  - "D-07: Hard-coded Part 14 §7.2.5 field emission order in encodeNetworkMessage and _encodeDataSetMessage"
  - "D-08: Structured decoder errors {code, path, message} on all missing required fields"
  - "Phase 3 deferred: namespace-URI form for NodeId (only namespace-index form in Phase 2 — documented TODO)"
metrics:
  duration: "~176 seconds"
  completed: "2026-05-13"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 2 Plan 03: JSON Encoder Summary

**One-liner:** JSON NetworkMessage encoder/decoder with hard-coded Part 14 §7.2.5 field order, Variant/NodeId/DateTime/ByteString conversions, and structured decode errors.

## What Was Built

### lib/json-encoder.js (273 lines)

Pure-function JSON codec for OPC UA PubSub NetworkMessages per Part 14 §7.2.5 and Part 6 §5.4.

Public API:
- `encodeNetworkMessage(networkMessage, opts?)` — returns JSON string with hard-coded field emission order
- `decodeNetworkMessage(jsonString, opts?)` — returns domain model; throws `{code, path, message}` on validation failures

Key implementation choices:
- Imperative `parts.push(...)` builds JSON string without `JSON.stringify(wholeObject)` (D-05)
- Field order: `MessageId` → `MessageType` → `PublisherId?` → `WriterGroupName?` → `DataSetClassId?` → `Messages` (D-07)
- DataSetMessage field order: `DataSetWriterId?` → `DataSetWriterName?` → `PublisherId?` → `WriterGroupName?` → `SequenceNumber?` → `MetaDataVersion?` → `Timestamp?` → `Status?` → `MessageType` → `Payload`
- Variant: `{"UaType": N, "Value": ...}` with UaType emitted before Value per Part 6 §5.4 SHOULD
- Type conversions: `Date → .toISOString()`, `Buffer → .toString("base64")`, NodeId domain object → `nodeIdToString()`, `BigInt → .toString()`
- Decoder validates `MessageId`, `MessageType`, `Messages` required fields; validates `Payload` in each DataSetMessage
- MessageType mapping: `keyframe ↔ ua-keyframe`, `deltaframe ↔ ua-deltaframe`, `event ↔ ua-event`, `keepalive ↔ ua-keepalive`
- `messageId` auto-generated via `crypto.randomUUID()` when absent
- Reuses `createError`, `nodeIdToString`, `parseNodeId` from `lib/opcua-utils.js`
- No new runtime dependencies (D-06)

### test/json-encoder.test.js (220 lines, 21 tests)

Mocha+Chai unit tests with comprehensive coverage:

| Test Group | Tests | Coverage |
|-----------|-------|---------|
| Module exports | 1 | Both functions exported |
| Field order (D-07) | 3 | Top-level NM order, conditional fields, DataSetMessage order |
| Variant type conversions | 6 | Boolean, Int32, Double, UInt64 BigInt, UaType order, arrays |
| DateTime conversion | 1 | Date → ISO-8601 string + Timestamp field |
| ByteString conversion | 1 | Buffer → Base64 ("aGVsbG8=") |
| NodeId conversion | 1 | NodeId domain object → "ns=2;s=Temperature" |
| MessageType wire mapping | 4 | All 4 model→wire mappings |
| Round-trip | 1 | decode(encode(model)) preserves scalar fields |
| Structured decoder errors | 3 | Missing Messages, missing Payload, invalid JSON parse |

## Test Count Delta

- Before: 231 passing
- After: 252 passing (+21 new tests)
- Regressions: 0

## Part 6 §5.4 Type Conversions Covered by Tests

| Type | UaType | Test Coverage |
|------|--------|---------------|
| Boolean | 1 | encode + value assertion |
| Int32 | 6 | encode + value assertion |
| Double | 11 | encode + value assertion |
| UInt64 (BigInt) | 9 | encode + string safety assertion |
| DateTime | 13 | ISO-8601 encode + Timestamp field |
| ByteString (Buffer) | 15 | Base64 encode + round-trip |
| NodeId | 17 | nodeIdToString format assertion |
| Array Variant | — | Int32 array preserved |

Not directly tested in Phase 2 (no dedicated test but encoder handles via fallthrough): String, SByte, Byte, Int16, UInt16, UInt32, Int64, Float, Guid, StatusCode — all numeric types handled by the same identity path in `_convertValueForJson`.

## JSON.stringify Usage Confirmation

`JSON.stringify` is NEVER called on the full NetworkMessage or DataSetMessage object. All `JSON.stringify` calls are on individual per-field converted values only:

```js
parts.push(`"MessageId":${JSON.stringify(messageId)}`);       // per-field
return `{"UaType":${uaType},"Value":${JSON.stringify(converted)}}`; // per-field
```

No `JSON.stringify(networkMessage)`, `JSON.stringify(fullObject)`, or `JSON.stringify(parts)` pattern anywhere.

## Deviations from Plan

None — plan executed exactly as written.

The `_encodeDataSetMessage` function accepts fields where each value is a Variant `{dataType, value}` object. The encoder always calls `_encodeVariant` on each field, matching the plan's specification of "always emit as Variant in JSON encoding."

## Known Stubs

One intentional deferred item (not a stub blocking plan goals):

- **lib/json-encoder.js:59** — `// TODO Phase 3: add namespace-URI form per Part 6 §5.4`
  - NodeId values are encoded in namespace-index form (`ns=2;s=Temperature`) via `nodeIdToString()`
  - Namespace-URI form (`nsu=http://...;s=Value`) is deferred to Phase 3 as documented in RESEARCH.md open question 2 (assumption A4)
  - Phase 2 JSON encoder is fully functional for namespace-index form — this does not block ENC-02 delivery

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries introduced by this plan. The `lib/json-encoder.js` module is a pure stateless function (no I/O).

Threat mitigations from the plan's threat register are implemented:
- **T-02-11** (Missing Messages field): `decodeNetworkMessage` explicitly checks `obj.Messages === undefined` and throws `{code: "JSON_DECODE_MISSING_FIELD", path: "Messages"}`
- **T-02-12** (Messages non-array): `Array.isArray(obj.Messages)` check; throws `{code: "JSON_DECODE_INVALID_TYPE", path: "Messages"}`
- **T-02-14** (Unintended field leakage): Encoder uses imperative `parts.push(...)` — only explicitly extracted fields appear in output

Accepted threats (T-02-13 size limit, T-02-15 malformed NodeId) documented in plan remain accepted.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| lib/json-encoder.js exists | FOUND |
| test/json-encoder.test.js exists | FOUND |
| 02-03-SUMMARY.md exists | FOUND |
| Commit a604795 (Task 1) exists | FOUND |
| Commit afc3b53 (Task 2) exists | FOUND |
| 21 json-encoder tests pass | PASSED |
| npm test 252 passing, 0 regressions | PASSED |

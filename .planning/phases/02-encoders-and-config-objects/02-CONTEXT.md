# Phase 2: Encoders and Config Objects — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning
**Mode:** interactive (4 gray areas surfaced; user accepted Claude's recommendations)

<domain>
## Phase Boundary

Stateless wire-format primitives plus pure config-object data classes. No transport I/O, no Node-RED node files, no `setInterval` lifecycle. Three concrete deliverables:

- **ENC-01** — `lib/uadp-encoder.js`: UADP binary encoder + decoder for `NetworkMessage` / `DataSetMessage` per Part 14 §7.2.4 (full flag cascade, sequence numbers, PublisherId variants, WriterGroup/DataSetWriter ids, timestamps, chunking per §7.2.4.4.4).
- **ENC-02** — `lib/json-encoder.js`: JSON `NetworkMessage` encoder + decoder per Part 14 §7.2.5 + Part 6 §5.4 (NodeId→string, DateTime→ISO-8601, ByteString→Base64, Variant→`{UaType,Value}`).
- **WGRP-01 / DSW-01 / DSR-01** — `lib/pubsub-config.js`: Pure config-object factories + validators for `WriterGroup`, `DataSetWriter` (incl. `PublishedDataSet`), `DataSetReader`.

Out of scope for Phase 2: socket code, MQTT/UDP adapters, Node-RED node registration, lifecycle/`setInterval`, MetaData publishing, security, chunking transport-side reassembly buffer (the chunking encoder lives here; the receive-side buffer with TTL lives in Phase 3 UDP transport).

</domain>

<decisions>
## Implementation Decisions

### UADP Encoder API & Buffer Strategy

- **D-01:** Public API is symmetric pure functions, no class:
  ```js
  // lib/uadp-encoder.js
  module.exports = {
    encodeNetworkMessage,   // (networkMessage, opts?) -> Buffer
    decodeNetworkMessage,   // (buffer, opts?) -> NetworkMessage
    encodeDataSetMessage,   // (dataSetMessage, opts?) -> Buffer  (exported for chunking)
    decodeDataSetMessage,   // (buffer, opts?) -> DataSetMessage
  };
  ```
  Same export style as `lib/opcua-utils.js` (named-exports object).

- **D-02:** Internal `BinaryStream` writer/reader is a private file-local class (not exported). It implements the conditional-serializer pattern from PITFALLS Pitfall 1: write all optional flag bytes into a scratch region, then walk the cascade and suppress bytes whose parent gate bit is false. **Hand-rolled fixed-offset Buffer writes are forbidden** — every optional field must go through the conditional serializer.

- **D-03:** **Buffer reuse is OUT of scope for Phase 2.** No pre-allocated reusable buffer. Each `encodeNetworkMessage()` call allocates a fresh `Buffer.allocUnsafe(estimatedSize)` and trims/copies on return. The pre-alloc-per-WriterGroup performance pattern (PITFALLS Performance trap) is a Phase 4 concern — it lives with the Publisher's `setInterval` lifecycle, not with the stateless encoder. Phase 4 may wrap the encoder in a buffer pool without the API changing.

- **D-04:** `opts` parameter is reserved for future extension (e.g., `{ securityKey, mtu }`). For Phase 2 it is unused but accepted on every public function so callers don't break when v2 adds security.

### JSON Encoder Strategy

- **D-05:** Imperative string-building. Network/DataSet message wrapper structure is concatenated as a string per Part 14 §7.2.5 schema order. Inner field values (Variant `{UaType,Value}`, NodeId strings, DateTime ISO-8601, ByteString Base64) are converted in JS first, then `JSON.stringify` is called only on the per-field value object. The result is reviewable in tests as exact string matches.

- **D-06:** **No new runtime deps for the JSON encoder in v1.** `fast-json-stringify` is explicitly rejected per PROJECT.md "minimize new deps" — only justify when a benchmark in Phase 4 shows a real bottleneck (>50 fields and <100ms publishing interval).

- **D-07:** Output key order is **deterministic per Part 14 schema**, not `Object.keys()` order. Encoder hard-codes the field emission order per message type so the JSON matches reference encoders byte-for-byte.

- **D-08:** Decoder uses `JSON.parse` and validates required fields explicitly. Missing required fields throw with a structured error (`{code: "JSON_DECODE_MISSING_FIELD", path: "...", message: "..."}`).

### NetworkMessage / DataSetMessage In-Memory Data Model

- **D-09:** Domain-friendly model. `NetworkMessage` carries only domain-relevant fields:
  ```js
  {
    publisherId,                       // String | UInt16 | UInt32 | UInt64
    dataSetClassId?,                   // GUID
    groupHeader?: {
      writerGroupId, groupVersion, networkMessageNumber, sequenceNumber
    },
    payloadHeader?: { dataSetWriterIds: [...] },
    timestamp?, picoseconds?, promotedFields?,
    securityHeader?,                   // present only when security mode != None
    chunk?: { chunkOffset, totalSize },// present only on chunk-typed message
    payload: DataSetMessage[]
  }
  ```
  `UADPFlags`, `ExtendedFlags1`, `ExtendedFlags2` are **NEVER** model fields. The encoder derives them from field presence at encode time (PITFALLS Pitfall 1 mitigation: callers cannot accidentally desync flags from data).

- **D-10:** `DataSetMessage` model:
  ```js
  {
    dataSetWriterId,
    fieldEncoding,           // 'variant' | 'datavalue' | 'rawdata' (default 'variant')
    messageType,             // 'keyframe' | 'deltaframe' | 'keepalive' | 'event'  (default 'keyframe')
    sequenceNumber, timestamp?, status?, configurationVersion?,
    fields: { [fieldName]: value | { value, statusCode?, sourceTimestamp?, ... } }
  }
  ```
  `DataSetFlags1`/`DataSetFlags2` are derived at encode time, not model fields.

- **D-11:** Decoder produces the **same** model shape encoder accepts. Round-trip: `encode(decode(buf)) == buf` byte-for-byte for all canonical inputs.

- **D-12:** Test vectors assert against the **wire-format Buffer** (hex), not against the in-memory model. This insulates downstream tests from spec model reorganization.

### Config-Object Validation Philosophy

- **D-13:** Hybrid pattern — pure validators + factory wrappers. Each config type exports both:
  ```js
  module.exports = {
    validateWriterGroup,        // (cfg) -> { valid: bool, errors: Issue[] }
    WriterGroup,                // (cfg) -> WriterGroup; throws on invalid
    validateDataSetWriter, DataSetWriter,
    validatePublishedDataSet, PublishedDataSet,
    validateDataSetReader, DataSetReader,
  };
  ```
  Phase 3 editor UI uses `validate*()` for inline collect-all feedback. Phase 4 worker nodes use the factory (throws fail-fast, matches existing CONVENTIONS.md style).

- **D-14:** `Issue` shape is structured, not string-only:
  ```js
  { path: "keepAliveTime", code: "MUST_BE_GTE_PUBLISHING_INTERVAL", message: "..." }
  ```
  `code` is a stable enum string per validation rule (used by Phase 3 UI for i18n later).

- **D-15:** Locked validation rules and defaults (from REQUIREMENTS.md + PITFALLS):
  - `WriterGroup.publishingInterval` required, > 0
  - `WriterGroup.keepAliveTime >= publishingInterval` (PITFALLS #3)
  - `WriterGroup.maxNetworkMessageSize` default = **1400** (PITFALLS #6, IPv4 UDP-MTU-safe)
  - `WriterGroup.priority` default = 128 (Part 14 default)
  - `DataSetWriter.keyFrameCount` default = **1** (PITFALLS #3, no delta cold-start)
  - `DataSetWriter.dataSetFieldContentMask` default = `Variant`; `RawData` only with explicit opt-in AND validation that (a) no abstract types, (b) `maxStringLength` set on string fields (PITFALLS #2)
  - `PublishedDataSet.configurationVersion` default = `{ major: 1, minor: 0 }`
  - `DataSetReader.messageReceiveTimeout` default = `max(3 × keepAliveTime, 5000ms)` (PITFALLS #3)
  - `DataSetReader` filter: at least one of `publisherId | writerGroupId | dataSetWriterId` required

- **D-16:** **Frozen on construct.** Factory wrappers `Object.freeze()` the returned config before handing it back. Mutations after construction throw silently in non-strict mode — keep config immutable so Phase 3/4 transports can rely on it.

### Test-Vector Strategy (TEST-03 enabler — actual test code lives in Phase 4)

- **D-17:** `test/fixtures/uadp-vectors.js` exports 8 ExtendedFlags1/ExtendedFlags2 presence combinations + edge cases (chunk boundary, all PublisherId variants, DataSetMessage with each `fieldEncoding`) as hex string literals. Each entry includes a comment block: which fields are present, which Part 14 section the wire layout maps to, and source provenance (`open62541 v1.4.x output captured 2026-05-10` or `hand-derived from Part 14 §7.2.4 Table 75`).

- **D-18:** `test-server/capture-open62541-vectors.js` is a runnable Node script (NOT picked up by `npm test` — same pattern as `test-server/server.js`). It boots an open62541 publisher (Docker image documented in DOCKER.md, or via npm-installed `open62541-binaries` if available), captures emitted UDP packets via `dgram`, dumps hex to stdout. Run manually when fixture refresh is needed; output is reviewed and pasted into `test/fixtures/uadp-vectors.js`.

- **D-19:** Phase 2 unit tests in `test/uadp-encoder.test.js` assert `encode(model) == fixture.hex` and `decode(fixture.hex)` produces the documented model shape. The 8-combination flag-cascade matrix is mandatory; remaining edge cases (chunking, PublisherId variants) are added as the encoder gains the corresponding code paths.

### File Layout

- **D-20:** Flat layout in `lib/`:
  - `lib/uadp-encoder.js` — UADP binary encoder + decoder + private `BinaryStream`
  - `lib/json-encoder.js` — JSON encoder + decoder
  - `lib/pubsub-config.js` — config validators + factories for WriterGroup / DataSetWriter / PublishedDataSet / DataSetReader
  - Test fixtures in `test/fixtures/uadp-vectors.js` (new directory)

  Subdirectory `lib/pubsub/` is **deferred** until Phase 3 transport adapters are added — at that point a single `mv` consolidation may be worth it. For now, flat is consistent with `lib/cert-store.js`, `lib/opcua-utils.js`, `lib/opcua-client-manager.js`.

### Code Style & Test Patterns

- **D-21:** New PubSub code follows the active-refactor style from Phase 1: 2-space indentation, double quotes, CommonJS, JSDoc on every exported function. Reuses existing `lib/opcua-utils.js::createError` for error construction. Mocha + Chai + Sinon for tests, mirroring `test/cert-store.test.js` and `test/opcua-client-manager-reconnect.test.js` patterns.

### Claude's Discretion

- Exact JSDoc wording on every exported function
- Internal helper names inside `lib/uadp-encoder.js` (`writeFlags`, `_writeOptional`, etc.) — pick what reads cleanly
- Whether to split `pubsub-config.js` into one validator file per type internally and re-export from a single `index` (DO IT only if `pubsub-config.js` exceeds ~600 lines)
- Whether to inline Part 14 spec section numbers in code comments — recommended where the algorithm is non-obvious (flag cascade, chunk reassembly)
- Hex-literal formatting in `test/fixtures/uadp-vectors.js` (one byte per character pair, with optional `_` separators per logical field; reviewer-friendly is the bar)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner, executor) MUST read these before planning or implementing.**

### Phase scope
- `.planning/phases/02-encoders-and-config-objects/02-CONTEXT.md` — this file (D-01..D-21)
- `.planning/REQUIREMENTS.md` §"Encoding" / §"Configuration Objects" — locked requirements (ENC-01, ENC-02, WGRP-01, DSW-01, DSR-01)
- `.planning/ROADMAP.md` Phase 2 success criteria — 5 testable conditions

### OPC UA Part 14 (PRIMARY SPEC — read before writing any encoder code)
- OPC UA Part 14 v1.05 §7.2.4 — UADP NetworkMessage encoding (UADPFlags, ExtendedFlags1, ExtendedFlags2 cascade tables)
- OPC UA Part 14 v1.05 §7.2.4.4 — DataSetMessage encoding
- OPC UA Part 14 v1.05 §7.2.4.4.4 — UADP chunking
- OPC UA Part 14 v1.05 §7.2.5 — JSON NetworkMessage encoding
- OPC UA Part 6 §5.4 — Variant / NodeId / DateTime / ByteString JSON encoding rules
- OPC UA Part 14 §6.2.5 — WriterGroup parameters (KeepAliveTime, PublishingInterval relationship)

### Pitfalls to mitigate in Phase 2 (must read)
- `.planning/research/PITFALLS.md` Pitfall #1 — UADP flag cascade (encoder strategy)
- `.planning/research/PITFALLS.md` Pitfall #2 — RawData type loss (validation strategy)
- `.planning/research/PITFALLS.md` Pitfall #3 — KeyFrame/KeepAlive defaults
- `.planning/research/PITFALLS.md` Pitfall #6 — MTU / chunking
- `.planning/research/PITFALLS.md` "Looks Done But Isn't" checklist — Phase 2 items: UADP encoder suppression, KeepAlive validation, MTU-safe default, RawData enforcement

### Reference implementation (consulted, not vendored)
- open62541 — `UA_NetworkMessage_encodeBinary` for flag-cascade reference
- node-opcua `node-opcua-binary-stream` — for an idea of the existing stream API style (NOT a dependency — re-implementing the subset needed)

### Project conventions
- `.planning/codebase/CONVENTIONS.md` §"Module System", §"Naming", §"Code Style" — 2-space, double quotes, CommonJS, JSDoc
- `.planning/codebase/TESTING.md` — Mocha+Chai+Sinon patterns, fixture directory conventions
- `.planning/PROJECT.md` Constraints — "minimize new runtime deps", "no GPL/AGPL", MIT only

### Reusable from prior phases
- `lib/opcua-utils.js::parseNodeId`, `nodeIdToString`, `WELL_KNOWN_NODES` — reuse for NodeId conversion in JSON encoder
- `lib/opcua-utils.js::createError` — reuse for structured error construction
- `lib/cert-store.js` — pattern reference (named-exports object, JSDoc on each export)
- `.planning/phases/01-pre-work/03-msg-schema-doc-SUMMARY.md` + `docs/MSG-SCHEMA.md` — `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber` are reserved for v0.1.0; encoder/config models must use the same camelCase names so Phase 4 nodes get a clean mapping

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`lib/opcua-utils.js`** — NodeId parse/format helpers, `WELL_KNOWN_NODES` map, `createError()`, `parseDataType()`, `isValidEndpointUrl()`. JSON encoder reuses `nodeIdToString()` for Part 6 §5.4 NodeId→string mapping.
- **`lib/cert-store.js`** (Phase 1 deliverable) — pattern reference for named-exports module with JSDoc on each export. New encoder/config files mirror its export style.
- **`test/cert-store.test.js`** + **`test/opcua-client-manager-reconnect.test.js`** — Mocha+Chai+Sinon patterns to mirror in `test/uadp-encoder.test.js`, `test/json-encoder.test.js`, `test/pubsub-config.test.js`.
- **`test-server/server.js`** — pattern for a runnable script outside `npm test`. New `test-server/capture-open62541-vectors.js` follows the same shape (commented header, `if (require.main === module) main();`).

### Established Patterns

- **Named-exports object** — `module.exports = { fn1, fn2, ... };` at file end. Used by `lib/opcua-utils.js` and `lib/cert-store.js`. Phase 2 modules follow this.
- **Structured error objects via `createError(message, error)`** — encoder/decoder errors and validation issues use the same constructor for consistency.
- **`if (RED.httpAdmin)` guard** — N/A here (no Node-RED coupling in Phase 2), but Phase 3 transport config will need it.
- **JSDoc on every public function** — established in Phase 1's `OpcUaClientManager.reconnect()` and `lib/cert-store.js`. Phase 2 must continue.
- **Test fixture directory convention** — none yet; this phase introduces `test/fixtures/` (new). Pattern: one fixture file per encoder, exporting an object map of named cases.

### Integration Points

- **`docs/MSG-SCHEMA.md` "Reserved for v0.1.0 (PubSub)"** — `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.encoding`, `msg.transport` are reserved. Phase 2 model field names map 1:1 (`networkMessage.publisherId`, `groupHeader.writerGroupId`, `dataSetMessage.dataSetWriterId`, `groupHeader.sequenceNumber`). Phase 4 publisher/subscriber will copy these onto `msg.*` directly without renaming.
- **No coupling to `OpcUaClientManager`** — Phase 2 deliverables are independent of Client/Server reconnect machinery. Encoders are pure; config objects are pure.
- **DataSet field types reuse `parseDataType()` from `lib/opcua-utils.js`** so the same string-syntax that the existing client/server nodes accept (e.g., `"Double"`, `"String[]"`) works for PublishedDataSet field declarations.

</code_context>

<specifics>
## Specific Ideas

- The conditional-serializer pattern is well-established in open62541's `UA_NetworkMessage_encodeBinary` — read that as the reference for the suppression-when-zero rule on `ExtendedFlags1`/`ExtendedFlags2`. Don't re-invent the algorithm; mirror it.
- Hex-literal fixtures with field-by-field comments (one logical group per line) are the way the existing `test/opcua-utils.test.js` reads — apply the same review-friendly style to `test/fixtures/uadp-vectors.js`.
- The `Issue` validation-error shape (`{path, code, message}`) mirrors common form-validation patterns and gives Phase 3 editor UI a stable contract for inline error rendering — even if Phase 3 chooses a different validator library, this shape is the lingua franca.

</specifics>

<deferred>
## Deferred Ideas

These came up while bounding Phase 2's scope. Not lost — flagged for the right phase.

- **Buffer-pool / pre-allocated WriterGroup encode buffer** — Phase 4 (Publisher lifecycle owns the `setInterval`; the encoder API stays stateless). Mitigation for PITFALLS Performance trap "Allocating Buffer per NetworkMessage". Re-evaluate when running the round-trip benchmark in Phase 4.
- **`fast-json-stringify` adoption** — Phase 4 contingent. Only justify if benchmark shows a real bottleneck (>50 fields, <100ms intervals). Until then, imperative + per-field `JSON.stringify` is the locked approach.
- **DataSetMetaData publishing (META-01)** — v2 milestone. Phase 2 only encodes `ConfigurationVersion` inside DataSetMessage headers (locked default `{1, 0}`); the metadata topic publish is explicitly out of v1 scope.
- **MetaData auto-version-bump on field-list change** — Phase 4 Publisher concern (the publisher node owns the lifecycle that detects field changes); Phase 2 just encodes whatever `configurationVersion` the model holds.
- **Subdirectory `lib/pubsub/` consolidation** — Phase 3 transition (becomes attractive once UDP/MQTT transport adapters land). For now, flat in `lib/`.
- **Security headers (Sign / Sign+Encrypt)** — v2/v3 milestones. The `securityHeader?` field on the model is reserved; encoder leaves the gate bit clear when the field is absent.
- **Sequence-number gap detection on subscriber (GAP-01)** — v2 milestone. Phase 2 emits sequence numbers correctly; gap detection is a subscriber-side concern in v2.

</deferred>

---

*Phase: 02-encoders-and-config-objects*
*Context gathered: 2026-05-10*
*Mode: interactive (4 gray areas surfaced; user accepted Claude's recommendations across all four)*

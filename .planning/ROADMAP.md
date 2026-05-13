# Roadmap: node-red-contrib-opcua-suite — OPC UA PubSub Milestone (v0.1.0)

## Overview

This milestone adds a complete OPC UA PubSub Publisher/Subscriber layer to the suite as a purely additive
set of nodes — zero breaking changes to the existing eight Client/Server nodes. The build order is
dictated by hard dependencies: pre-work first (so PubSub does not clone known-bad patterns), then
stateless encoders and config objects (gates all transport work), then transport adapters and the
connection config node, and finally the Publisher/Subscriber worker nodes, round-trip tests, and example
flows. Shipping as v0.1.0 marks the transition from pure Client/Server to a full Pub/Sub-capable suite.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Pre-Work** - Consolidate PubSub-impacted tech debt so new nodes do not clone known-bad patterns
- [x] **Phase 2: Encoders and Config Objects** - Stateless UADP + JSON encoders and pure config-object layer
- [ ] **Phase 3: Transports and Connection Config Node** - UDP/MQTT transport adapters and the opcua-pubsub-connection config node
- [ ] **Phase 4: Publisher, Subscriber, Tests, and Examples** - Worker nodes, round-trip tests, example flows, and README docs

## Phase Details

### Phase 1: Pre-Work
**Goal**: The codebase is ready for PubSub additions — reconnect logic is consolidated, cert handling is extracted into a shared helper, and the msg.* schema is frozen — so no PubSub code will clone existing fragile patterns.
**Depends on**: Nothing (first phase)
**Requirements**: DEBT-01, DEBT-02, DEBT-03
**Success Criteria** (what must be TRUE):
  1. All reconnect state mutations occur inside `OpcUaClientManager`; no node-level code mutates `clientManager.isConnected` or `clientManager.reconnectAttempts` directly.
  2. A single shared cert-upload helper (HTTP routes + drag-drop JS) is extracted from `opcua-endpoint.js/.html` and can be imported by a second config node without duplicating routes.
  3. The existing eight nodes' `msg.*` fields (`msg.payload`, `msg.statusCode`, `msg.sourceTimestamp`, `msg.serverTimestamp`, `msg.nodeId`, `msg.operation`, `msg.error`) are documented in one authoritative location and no PubSub field name collides with them.
  4. Existing Mocha test suite passes without regression after the refactor.
**Plans**: TBD

### Phase 2: Encoders and Config Objects
**Goal**: Stateless UADP binary and JSON encoders plus the pure config-object layer are implemented and unit-tested; no transport I/O is required to verify them.
**Depends on**: Phase 1
**Requirements**: ENC-01, ENC-02, WGRP-01, DSW-01, DSR-01
**Success Criteria** (what must be TRUE):
  1. `uadp-encoder.js` round-trips a `NetworkMessage` (all three flag-cascade levels, chunk reassembly, MTU default 1400 bytes) with output verified byte-for-byte against open62541 reference vectors for all 8 ExtendedFlags1/ExtendedFlags2 presence combinations.
  2. `json-encoder.js` round-trips a `NetworkMessage` with correct NodeId→string, DateTime→ISO-8601, ByteString→Base64, and Variant→`{UaType,Value}` conversions.
  3. WriterGroup config rejects a `KeepAliveTime` value less than `PublishingInterval` with a thrown validation error.
  4. DataSetWriter config defaults `KeyFrameCount` to 1 and DataSetReader config defaults `MessageReceiveTimeout` to `max(3 × KeepAliveTime, 5000 ms)`.
  5. All encoder and config-object unit tests pass (`npm test`).
**Plans**: 5 plans
Plans:
- [ ] 02-01-PLAN.md — UADP encoder foundation: BinaryStream, flag cascade, NetworkMessage header encode/decode, all 5 PublisherId variants (covers ENC-01 part)
- [ ] 02-02-PLAN.md — UADP DataSetMessage encode/decode (DataSetFlags1/2 cascade, all 3 fieldEncodings, 4 messageTypes, Variant + DataValue codecs) and sender-side chunking (covers ENC-01 rest)
- [ ] 02-03-PLAN.md — JSON encoder/decoder per Part 14 §7.2.5 + Part 6 §5.4 with deterministic field order, structured decoder errors, and Mocha tests (covers ENC-02)
- [ ] 02-04-PLAN.md — pubsub-config: validate+factory hybrid for WriterGroup / DataSetWriter / PublishedDataSet / DataSetReader with frozen returns, RawData cross-validation, and Mocha tests (covers WGRP-01, DSW-01, DSR-01)
- [ ] 02-05-PLAN.md — UADP test fixtures (8-combination flag matrix), Mocha encoder test suite, and open62541 capture script (covers ENC-01 testing + TEST-03 enabler)

### Phase 3: Transports and Connection Config Node
**Goal**: UDP-UADP and MQTT transport adapters are implemented behind the `BaseTransport` interface, and the `opcua-pubsub-connection` config node owns their lifecycle with ref-counted connect/disconnect and status fan-out to worker nodes.
**Depends on**: Phase 2
**Requirements**: TRP-01, TRP-02, CFG-01, CFG-02
**Success Criteria** (what must be TRUE):
  1. A UDP transport sends a `Buffer` to `0.0.0.0` multicast and a second socket on the same host receives it; `EADDRINUSE` does not occur on 20 rapid redeploy cycles (TEST-02 acceptance criteria met here at transport level).
  2. An MQTT transport publishes with `retain=false` enforced on data topics; a unit test asserts the flag is hard-coded and cannot be overridden by caller config.
  3. The `opcua-pubsub-connection` config node in Node-RED editor shows a `transportType` dropdown (`udp` / `mqtt`), a PublisherId field (String/UInt16/UInt32/UInt64), and the reused cert dropzone for transport-level certificates.
  4. Worker nodes registered against the config node receive `connected` / `disconnected` / `error` status events via the same fan-out pattern used by `opcua-endpoint`.
  5. `socket.close(done)` / `client.end(false, done)` is used in all transport adapters so Node-RED's close event completes synchronously with zero leaked sockets.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Publisher, Subscriber, Tests, and Examples
**Goal**: The `opcua-publisher` and `opcua-subscriber` Node-RED nodes are complete, all round-trip transport × encoding tests pass, three example flows are shipped, and the README PubSub section documents the full configuration hierarchy and msg shape.
**Depends on**: Phase 3
**Requirements**: PUB-01, PUB-02, PUB-03, SUB-01, SUB-02, STAT-01, TEST-01, TEST-02, TEST-03, DOC-01, DOC-02
**Success Criteria** (what must be TRUE):
  1. A user can drop `opcua-publisher` onto a flow, connect it to an `opcua-pubsub-connection` (UDP), inject `msg.payload` with a field map, and a connected `opcua-subscriber` node emits a `msg` with `msg.payload`, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, and `msg.timestamp` populated correctly.
  2. Cyclic publish mode fires at `PublishingInterval` and sends a KeepAlive NetworkMessage when no field values changed between ticks.
  3. A ConfigurationVersion mismatch between Publisher and Subscriber surfaces as a visible `node.error()` on the Subscriber node — it is never silently dropped.
  4. Mocha round-trip tests pass for all three transport × encoding combinations shipped in v1: UDP-UADP, MQTT-UADP, MQTT-JSON (`npm test`).
  5. All three example flows (`10 - PubSub UDP-UADP Loopback.json`, `11 - PubSub MQTT-UADP.json`, `12 - PubSub MQTT-JSON.json`) import cleanly into Node-RED and can be deployed without errors.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:** 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Pre-Work | 3/3 | Complete | 2026-05-09 |
| 2. Encoders and Config Objects | 5/5 | Complete | 2026-05-13 |
| 3. Transports and Connection Config Node | 0/TBD | Not started | - |
| 4. Publisher, Subscriber, Tests, and Examples | 0/TBD | Not started | - |

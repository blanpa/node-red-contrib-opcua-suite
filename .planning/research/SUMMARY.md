# Project Research Summary

**Project:** node-red-contrib-opcua-suite — OPC UA PubSub Milestone
**Domain:** OPC UA Part 14 PubSub (Publisher/Subscriber) — UDP-UADP multicast, MQTT, AMQP transports; UADP binary + JSON encodings; Node.js / Node-RED
**Researched:** 2026-05-08
**Confidence:** HIGH

---

## Executive Summary

OPC UA Part 14 PubSub is a session-less publish-subscribe model layered over three transport families (UDP-UADP multicast, MQTT, AMQP 1.0). No open-source Node-RED package implements it today — this milestone is a genuine first-mover in the ecosystem. The correct build approach is a clean additive layer: a new `lib/pubsub/` subtree with stateless encoders, transport adapters behind a strategy-pattern interface, and manager classes that wire them together; plus a new `opcua-pubsub-connection` config node and `opcua-publisher` / `opcua-subscriber` worker nodes. Nothing in the existing eight Client/Server nodes needs to change. The two new direct runtime dependencies are `mqtt@^5.15.1` (MIT) and `rhea@^3.0.5` (Apache-2.0, AMQP 1.0); UADP encoding and JSON encoding are implemented in-tree using transitive `node-opcua-*` submodules already present in `node_modules/` — no new encoding library, no commercial bindings, full MIT posture preserved.

The build order is dictated by hard encoding-before-transport and publisher-before-subscriber dependencies, and it converges identically across all four research streams: UADP encoder first (gates all UADP transports), JSON encoder second (simpler, validates the DataSet schema model in parallel), UDP transport third (no broker, loopback-testable), MQTT fourth (highest user demand), AMQP last (most complex, lowest urgency). Each phase produces a testable artifact before the next begins, minimising rework.

The primary risk is pre-existing technical debt in `CONCERNS.md`. Eight items are explicitly flagged `[PubSub-impacted]`: reconnect logic split, subscription handling in consumers, subscription survival across reconnect, ref-count hysteresis, error-string matching, pre-1.0 schema churn, cert dropzone duplication, and error-message ID leakage. The PITFALLS agent recommends resolving these as "Phase 0 pre-work" before writing any PubSub code; the alternative is deliberately carrying forward known debt. **This is a roadmap decision the maintainer must make consciously** — see the "Roadmap Decision Required" section under Implications.

---

## Key Findings

### Recommended Stack

The stack is unusually lean. Only two new npm packages are needed: `mqtt@^5.15.1` for MQTT transport and `rhea@^3.0.5` for AMQP 1.0 transport. UDP multicast is covered by Node.js built-in `dgram`. All UADP encoding primitives (`BinaryStream`, `encodeUInt8/16/32`, `encodeVariant`, `encodeDataValue`, `UadpNetworkMessageContentMask`) are already present as transitive dependencies of `node-opcua@2.163.1` and are directly `require()`-able from CommonJS without compilation. The commercial `@sterfive/node-opcua-pubsub` is ruled out on three independent grounds: returns 404 on the public npm registry, carries a Sterfive EULA incompatible with the project's MIT constraint, and would create vendor lock-in. `amqplib` is ruled out because it implements AMQP 0-9-1, not AMQP 1.0 — using it for Part 14 AMQP transport would be spec non-conformant.

**Core technologies:**

- `mqtt@^5.15.1` (MIT): MQTT transport Publisher + Subscriber — only actively-maintained MQTT 5.0 client for Node.js; MQTT 5.0 required for `contentType` message property mandated by Part 14 §7.3.4; degrades gracefully to MQTT 3.1.1
- `rhea@^3.0.5` (Apache-2.0): AMQP 1.0 transport — Part 14 normatively references ISO/IEC 19464:2014 (AMQP 1.0); `amqplib` implements the wrong protocol version; Apache-2.0 is compatible with MIT projects
- Node.js `dgram` (built-in): UDP-UADP multicast — covers `addMembership`, `dropMembership`, `setMulticastTTL`, `setMulticastLoopback` without adding any dependency
- `node-opcua-binary-stream` + `node-opcua-basic-types` + `node-opcua-variant` + `node-opcua-data-value` + `node-opcua-types` (all transitive, MIT): UADP and JSON encoding primitives — already installed, directly `require()`-able; must NOT be added as direct dependencies to avoid version identity mismatches

**Critical installation note:** `npm install mqtt@^5.15.1 rhea@^3.0.5` is the complete dependency change.

**Files to create for encoding:**
- `lib/pubsub/encoders/uadp-encoder.js` — `encode(networkMessage, opts) → Buffer`, `decode(Buffer, metaDataMap) → networkMessage`
- `lib/pubsub/encoders/json-encoder.js` — `encode(networkMessage) → string`, `decode(string) → networkMessage`
- `lib/pubsub/chunk-assembler.js` — reassembly buffer for chunked UADP over UDP (30 s expiry)

### Expected Features

All four research streams agree on the same MVP boundary.

**Must have (table stakes) — v1 launch:**

- UADP binary encoder/decoder (in-tree) — gates all UADP transports; no fallback exists
- JSON NetworkMessage encoder/decoder — required for MQTT-JSON, the most demanded cloud integration path
- `opcua-pubsub-connection` config node — one unified config node with `transportType` dropdown; owns transport lifetime and ref-count
- `opcua-publisher` node — msg-driven and timer-driven publish; WriterGroup + DataSetWriter config
- `opcua-subscriber` node — DataSetReader filter config; emits one `msg` per DataSetMessage
- UDP-UADP Publisher + Subscriber
- MQTT-JSON Publisher + Subscriber
- MQTT-UADP Publisher + Subscriber
- Cyclic publish mode with PublishingInterval timer + KeepAlive
- Node status indicators (connected / publishing / disconnected / error)
- Three example flows (UDP-UADP loopback, MQTT-UADP, MQTT-JSON)
- Mocha round-trip tests for each transport × encoding pair

**Should have (differentiators) — v1.x after validation:**

- AMQP-UADP Publisher + Subscriber — demand exists; AMQP is safe to defer since UDP + MQTT cover the majority of industrial deployments
- DataSetMetaData publishing on MQTT retained topic — required for spec-conformant MQTT-UADP interoperability with third-party subscribers
- UADP message signing (SecurityMode = Sign) — high value for plant-floor integrity; requires careful nonce handling
- KeyFrame/DeltaFrame control (KeyFrameCount > 1) — bandwidth optimisation; KeyFrameCount=1 is always correct so deferral is safe
- Sequence number gap detection — diagnostic feature

**Defer (v2+):**

- UADP message encryption (SignAndEncrypt) — AES-CTR nonce wrap risk makes this unsafe without SKS
- SubscribedDataSet TargetVariables — PubSub-fed server address space; large integration scope
- SKS client integration — key fetch from external Security Key Service
- PubSub configuration via UA address space (Part 14 §6.2.7)

### Architecture Approach

The architecture is a clean three-layer additive subtree. The `lib/pubsub/` directory contains pure config objects (`dataset.js`), stateless encoder functions, transport adapters behind a `BaseTransport` EventEmitter interface, and manager classes that wire them. The `nodes/` directory adds three Node-RED integration file pairs. The only connection to existing code is read-only use of `lib/opcua-utils.js` and reuse of the cert upload HTTP endpoints. `OpcUaClientManager` is not touched.

**Major components:**

1. `lib/pubsub/dataset.js` — pure config objects: PublishedDataSet, DataSetWriter, WriterGroup, DataSetReader, ReaderGroup, DataSetMetaData; no I/O; makes encoders trivially unit-testable
2. `lib/pubsub/encoders/uadp-encoder.js` — stateless encode/decode; three-level flag cascade (UADPFlags / ExtendedFlags1 / ExtendedFlags2); UADP chunking; uses transitive `node-opcua-binary-stream` and `node-opcua-basic-types`
3. `lib/pubsub/encoders/json-encoder.js` — stateless JSON encode/decode per Part 14 §7.2.5; DateTime→ISO-8601, NodeId→string, ByteString→Base64, Variant→`{UaType, Value}`
4. `lib/pubsub/transports/base-transport.js` — abstract EventEmitter interface: `connect()`, `disconnect()`, `send(Buffer)`; emits `connected`, `disconnected`, `message`, `error`
5. `lib/pubsub/transports/udp-transport.js` — `dgram`; bind to `0.0.0.0`; explicit `multicastInterface`; MTU cap at `MaxNetworkMessageSize` (default 1400 bytes); chunk reassembly with 30 s expiry
6. `lib/pubsub/transports/mqtt-transport.js` — `mqtt@^5.15.1`; `retain=false` hard-coded on data topics; `retain=true` on metadata topics; QoS mapping per Part 14 §7.3.4; MQTT 5.0 with 3.1.1 fallback
7. `lib/pubsub/transports/amqp-transport.js` — `rhea@^3.0.5`; AMQP 1.0; `content_type: application/opcua+uadp` or `application/json`; `subject: ua-data` / `ua-metadata`
8. `lib/pubsub/pubsub-publisher.js` — `OpcUaPubSubPublisher extends EventEmitter`; owns `setInterval` for cyclic mode; calls encoder → transport; emits `publisher_started`, `publisher_sent`, `publisher_error`
9. `lib/pubsub/pubsub-subscriber.js` — `OpcUaPubSubSubscriber extends EventEmitter`; DataSetMetaData cache keyed by `writerGroupId+dataSetWriterId`; dispatches decoded DataSetMessages; emits `dataSet`, `subscriber_connected`, `subscriber_disconnected`
10. `nodes/opcua-pubsub-connection.js` — config node; instantiates correct `BaseTransport` subclass from `transportType`; ref-counts with 500 ms grace period; fans status events to worker nodes
11. `nodes/opcua-publisher.js` / `nodes/opcua-subscriber.js` — thin Node-RED integration; `msg.payload → publisher.publish(fields)` and `subscriber 'dataSet' event → node.send(msg)`

**Key architectural constraints:**

- Separate `opcua-pubsub-connection` config node — do not extend `opcua-endpoint`; PubSub is session-less
- Transport adapters are encoding-agnostic — manager selects the encoder; transport receives only `Buffer`
- Reconnect is delegated to transport libraries — do not copy `forceReconnect()` from `opcua-client.js`

### Critical Pitfalls

Top 5 that must be designed around from day one:

1. **UADP flag cascade omission** (Phase 1) — UADP header has three optional flag bytes with "SHALL be omitted if parent bit is false" semantics; a fixed-offset Buffer writer fails interop against every third-party stack. Implement as a conditional serializer: encode optional fields into scratch buffers, then walk ExtendedFlags2 → ExtendedFlags1 → UADPFlags cascade suppressing zero bytes before final assembly. Verify with open62541 or UA-.NETStandard decoding the first packet. Recovery if shipped: HIGH cost (encoder rewrite, version bump, all flows re-tested).

2. **UDP multicast bind address** (Phase 2) — binding the receiver socket to the multicast group IP or the local NIC IP causes the kernel to silently drop all multicast datagrams with no error. Always bind to `0.0.0.0`; require explicit `multicastInterface` parameter; surface the chosen NIC prominently in the node UI. This is the single most reported UDP PubSub bug in OPC Labs KB.

3. **MQTT RETAIN flag on data messages** (Phase 2) — setting `retain=true` on data topics poisons newly connected subscribers with stale payloads; Part 14 explicitly forbids RETAIN on data topics. Hard-code `retain=false` in the MQTT transport; add a unit test assertion. Recovery: MEDIUM cost (hot-fix + users must manually flush broker retained messages).

4. **Node-RED deployment race — async close without `done()`** (Phase 2) — not using the three-argument close form and invoking `done()` only after the socket is fully closed causes UDP `EADDRINUSE` errors and duplicate messages on rapid redeploy. All transport adapters must use `socket.close(done)` / `client.end(false, done)`. Add a 20-rapid-redeploy acceptance test.

5. **Delta frame subscriber cold-start stall** (Phase 1/3) — when `KeyFrameCount > 1`, a subscriber that joins after the initial key frame receives deltas it cannot apply, producing no output for potentially 100+ seconds. Default `KeyFrameCount=1`; force-enable KeepAlive validation (`KeepAliveTime >= PublishingInterval`); set `MessageReceiveTimeout = max(3 × KeepAliveTime, 5000 ms)` as the subscriber default. Recovery: LOW cost.

**Additional pitfalls requiring phase-level design:**
- Pitfall 2 (RawData type loss) — default to Variant encoding; treat RawData without MetaData as a hard error at the subscriber
- Pitfall 6 (UDP MTU) — `MaxNetworkMessageSize` must default to 1400 bytes, not 1500; implement chunk reassembly with 30 s expiry
- Pitfall 7 (ConfigurationVersion mismatch) — subscriber must surface MajorVersion mismatch as a visible node error, not silent empty output
- Pitfall 8 (AES-CTR nonce reuse) — refuse encryption-mode security policies in v1; encryption requires SKS key rotation to be safe

---

## Implications for Roadmap

### Roadmap Decision Required: Phase 0 Pre-work

Before any PubSub code is written, the PITFALLS research identifies eight `[PubSub-impacted]` items in `.planning/codebase/CONCERNS.md` that, if left unresolved, will either produce a third/fourth copy of known-bad patterns or silently amplify existing fragile areas. The maintainer must choose:

**Option A — Address pre-work first (recommended by PITFALLS research):**
Spend a Phase 0 resolving:
1. Consolidate reconnect logic into the manager — prevents a third copy of retry loop in PubSub subscriber
2. Introduce a unified subscription abstraction — prevents a fourth `monitorItem` duplicate pattern
3. Extract cert dropzone into a shared helper — prevents a third copy when adding the PubSub config node
4. Introduce status-code-based error classification — prevents PubSub from growing the brittle string-matching OR-chain
5. Add ref-count hysteresis (500 ms grace period) — prevents extra disconnect storms when PubSub adds another ref-holder
6. Freeze and document the v1.0 `msg.*` schema — prevents PubSub `msg.dataSet` / `msg.writerGroup` additions compounding with existing schema churn
7. Fix subscription survival across reconnect — identical problem applies to PubSub DataSetReaders
8. Add a diagnostics surface — PubSub adds another opaque transport state; diagnostics become more valuable

**Option B — Carry the debt deliberately:**
Proceed directly to PubSub, acknowledge the debt items in comments, and plan a dedicated cleanup phase after PubSub ships. Acceptable if schedule pressure is high, provided the PubSub manager does not copy `forceReconnect()` verbatim and uses the transport library's own reconnect.

**This decision must be recorded in PROJECT.md Key Decisions before roadmap creation proceeds.**

---

### Phase 1: Encoding Foundation

**Rationale:** All transport work depends on a working encoder. The UADP encoder surfaces spec ambiguities (optional header fields, bitmask layout, chunking) before any transport code is written. Writing the encoder first means UDP transport tests immediately serve as UADP encoder integration tests. JSON encoder can be developed in parallel since it has no dependency on UADP binary logic.

**Delivers:**
- `lib/pubsub/dataset.js` — pure config objects
- `lib/pubsub/encoders/uadp-encoder.js` — UADP encode/decode with full flag cascade, chunking support, MTU-safe defaults
- `lib/pubsub/encoders/json-encoder.js` — JSON encode/decode per Part 14 §7.2.5
- Unit tests: `test/pubsub-uadp-encode.test.js`, `test/pubsub-json-encode.test.js`

**Addresses:** UADP encoder (P1), JSON encoder (P1), WriterGroup config, DataSetWriter config, DataSetReader config
**Avoids:** Pitfall 1 (flag cascade), Pitfall 2 (RawData default → Variant), Pitfall 6 (MTU default 1400 bytes)

### Phase 2: Transport Adapters

**Rationale:** Transports require I/O and integration test infrastructure. UDP needs no broker (loopback tests use two `dgram` sockets on 127.0.0.1) and is the simplest conformance check. MQTT follows as the highest-demand user scenario. AMQP is last: most complex test infrastructure, weakest v1 demand.

**Delivers:**
- `lib/pubsub/transports/base-transport.js`
- `lib/pubsub/transports/udp-transport.js` — bind to `0.0.0.0`, explicit multicastInterface, chunk reassembly with 30 s expiry
- `lib/pubsub/transports/mqtt-transport.js` — `mqtt@^5.15.1`, `retain=false` enforced, QoS mapping, MQTT 5.0 + 3.1.1 fallback
- `lib/pubsub/transports/amqp-transport.js` — `rhea@^3.0.5`, AMQP 1.0, content-type header
- Integration tests per transport

**Uses:** `dgram` (built-in), `mqtt@^5.15.1`, `rhea@^3.0.5`
**Avoids:** Pitfall 4 (UDP bind address), Pitfall 5 (MQTT RETAIN), Pitfall 6 (chunk reassembly expiry), Pitfall 10 (async close / deployment race)

### Phase 3: Manager Layer and Node-RED Integration

**Rationale:** The manager layer is written after transports so its `send` path is tested against real transport loopback. The config node is written last so its API exactly matches what the managers expose. This phase produces the first end-to-end working flows.

**Delivers:**
- `lib/pubsub/pubsub-publisher.js` — cyclic and on-input publish modes, per-WriterGroup `setInterval`, KeepAlive
- `lib/pubsub/pubsub-subscriber.js` — DataSetMetaData cache, DataSetWriterId dispatch, `dataSet` events
- `nodes/opcua-pubsub-connection.js/.html` — config node; transport factory; ref-count with 500 ms grace period
- `nodes/opcua-publisher.js/.html` — WriterGroup + DataSetWriter config in editor
- `nodes/opcua-subscriber.js/.html` — DataSetReader filter config; structured `msg` output
- Round-trip tests and three example flows

**Implements:** Full publisher/subscriber data flow; cyclic publish mode; node status indicators; DataSetReader filters
**Avoids:** Pitfall 3 (delta frame cold-start — KeyFrameCount=1 default, KeepAlive validation), Pitfall 7 (ConfigurationVersion mismatch surfaced as node error), Anti-pattern: reconnect copied into node code

### Phase 4: AMQP + v1.x Differentiators

**Rationale:** AMQP requires the most complex test infrastructure and has weaker v1 demand. Completing UDP and MQTT first validates the architecture before adding AMQP complexity. DataSetMetaData and signing are polish; signing requires careful nonce design.

**Delivers:**
- AMQP-UADP Publisher + Subscriber (if deferred from Phase 2)
- DataSetMetaData publishing on MQTT retained topics
- KeyFrame/DeltaFrame control with subscriber cold-start handling
- UADP message signing (SecurityMode = Sign) with static pre-shared key
- Sequence number gap detection

**Avoids:** Pitfall 8 (AES-CTR nonce reuse — signing only, no encryption without SKS)

---

### Phase Ordering Rationale

- Encoding before transport — a transport `send()` call requires a `Buffer`; cannot test transport without a working encoder
- UADP before JSON — UADP is mandatory for UDP; UDP is the simplest transport and gives the fastest end-to-end test path; JSON + MQTT follows as the most-demanded user scenario
- UDP before MQTT before AMQP — complexity gradient from no-broker to single-broker to most-complex-broker
- Publisher before Subscriber in each transport — the encoder is simpler than the decoder; a working publisher gives a valid wire frame to feed decoder tests
- Manager after transports — the manager's `send` path is immediately testable against a real loopback transport
- Config node after manager — the config node API is defined by what the managers actually need

### Research Flags

**Needs deeper research during planning (`/gsd-research-phase`):**

- **Phase 1 (UADP encoder):** The `UADPFlags → ExtendedFlags1 → ExtendedFlags2` omission rules and the `ChunkNetworkMessage` payload header layout are specification-dense and have caused interop failures in multiple implementations (open62541 issue #2800, OPC Labs KB). Plan a focused spec-reading session against Part 14 §7.2.4 and cross-check against open62541 `UA_NetworkMessage_encodeBinary` source before writing the encoder.
- **Phase 4 (UADP signing):** AES-CTR nonce construction for PubSub has a known spec errata in Part 14 v1.04 §7.2.2.2.3.2. Read the corrigendum before implementation; do not implement from the base spec text alone. Nonce reuse under the same key is catastrophically exploitable.

**Standard patterns (skip research phase):**

- **Phase 2 (MQTT transport):** `mqtt@5` API is well-documented; Part 14 §7.3.4 MQTT mapping is clear with multiple conformant reference implementations. No research phase needed.
- **Phase 3 (Node-RED integration):** Config node + worker node pattern is identical to existing `opcua-endpoint` / `opcua-client`; mirror the existing ref-count and status fan-out implementation. No research phase needed.
- **Phase 2 (AMQP transport):** `rhea@3` API is well-documented; Part 14 §B.3 AMQP mapping is clear. No research phase needed.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against npm registry 2026-05-08; `amqplib` vs `rhea` AMQP version distinction verified against spec normative references; transitive dep availability verified with `node -e "require(...)"` |
| Features | HIGH | Primary source: OPC Foundation Part 14 v1.05 spec; cross-checked against UA-.NETStandard PubSub.md and open62541 docs; ecosystem gap confirmed (no existing open-source Node-RED PubSub) |
| Architecture | HIGH | Component boundary design cross-checked against two reference implementations; existing codebase fully read (ARCHITECTURE.md, CONCERNS.md); anti-patterns grounded in spec and existing debt |
| Pitfalls | HIGH (spec) / MEDIUM (Node.js-specific) | Spec-grounded pitfalls verified from primary sources; Node.js-specific items from Node.js issue tracker and Node-RED docs; performance estimates are MEDIUM inference |

**Overall confidence: HIGH**

### Gaps to Address

- **UADP spec errata for AES-CTR nonce construction:** The exact nonce layout must be read from the Part 14 v1.04 corrigendum, not the base spec text, before Phase 4 signing work begins. Flag this in the Phase 4 roadmap entry.
- **Multi-NIC UDP multicast behaviour on Linux/Docker:** The `dgram` bind address pitfall is well-documented, but behaviour when `multicastInterface` is the Docker bridge interface vs. the host NIC requires hands-on testing. Add a multi-NIC acceptance test to Phase 2 criteria.
- **AMQP 1.0 broker test infrastructure:** Integration tests require a running AMQP 1.0 broker (RabbitMQ with AMQP 1.0 plugin, or Apache Qpid). Confirm broker choice and add to `docker-compose.yml` during Phase 2/4 planning.
- **MQTT 5.0 broker for CI:** Full metadata topic testing requires an MQTT 5.0 broker. Confirm Mosquitto ≥2.0 is the version in the compose file before Phase 2.

---

## Sources

### Primary (HIGH confidence)

- [OPC UA Part 14 v1.05](https://reference.opcfoundation.org/Core/Part14/v105/docs/) — §7.2.4 UADP, §7.2.5 JSON, §7.3.2 UDP, §7.3.4 MQTT, §B.3 AMQP, §6.2.5 WriterGroup, §5.4.3 Security
- [OPC UA Part 6 v1.05 — JSON Encoding](https://reference.opcfoundation.org/Core/Part6/v105/docs/5.4) — NodeId, DateTime, ByteString, Variant JSON rules
- npm registry (verified 2026-05-08): `mqtt@5.15.1`, `rhea@3.0.5`, `amqplib@1.0.6`
- [Node.js v18 dgram documentation](https://nodejs.org/docs/latest-v18.x/api/dgram.html) — multicast socket API
- [UA-.NETStandard PubSub.md](https://github.com/OPCFoundation/UA-.NETStandard/blob/master/Docs/PubSub.md) — reference implementation class model
- [open62541 PubSub documentation](https://open62541.org/doc/master/pubsub.html) — C reference implementation confirming component boundary design
- [MQTT.js GitHub](https://github.com/mqttjs/MQTT.js/) — MQTT 5.0 since v3.0.0 confirmed
- [rhea GitHub](https://github.com/amqp/rhea) — AMQP 1.0 confirmed, Apache-2.0

### Secondary (MEDIUM confidence)

- [OPC Labs KB — PubSub Traps and Pitfalls](https://kb.opclabs.com/OPC_UA_PubSub_Traps_And_Pitfalls) — UDP NIC selection, RawData, delta frame issues; implementation-experience-based
- [Beckhoff TF6105 — KeyFrames, DeltaFrames, KeepAlive](https://infosys.beckhoff.com/content/1033/tf6105_tc3_opc_ua_pub_sub/10407882251.html) — KeepAlive/DeltaFrame config guidance
- [OPC Foundation UA-IIoT-StarterKit](https://opcfoundation.github.io/UA-IIoT-StarterKit/UaMqttPublisher/) — MQTT topic structure example
- [Node.js issue #1690](https://github.com/nodejs/node/issues/1690) — dgram multicast bind address behaviour confirmed
- [Node-RED issue #2067](https://github.com/node-red/node-red/issues/2067) — close event `done()` async pattern required
- [node-opcua issue #571](https://github.com/node-opcua/node-opcua/issues/571) — PubSub not implemented in open-source node-opcua

### Tertiary (LOW confidence — needs validation during implementation)

- RFC 3686 — AES Counter Mode nonce construction reference; needs spec corrigendum cross-check for Part 14 specifics
- [open62541 issue #2800](https://github.com/open62541/open62541/issues/2800) — DataSetMetaData not set; confirms MetaData pitfall is common

---

*Research completed: 2026-05-08*
*Ready for roadmap: yes — pending Phase 0 pre-work decision (see "Roadmap Decision Required" section)*

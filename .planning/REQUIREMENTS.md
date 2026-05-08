# Requirements: node-red-contrib-opcua-suite — OPC UA PubSub Milestone

**Defined:** 2026-05-08
**Core Value:** A Node-RED user can wire any OPC UA interaction — Client/Server (today) and Publisher/Subscriber (this milestone) — into a flow without writing function nodes, without losing connections silently, and with structured types preserved end-to-end.

## v1 Requirements

Requirements for the PubSub milestone (this release). Each maps to exactly one roadmap phase.

### Pre-Work (PubSub-impacting tech debt consolidation)

Before PubSub code is written, three `[PubSub-impacted]` items from `.planning/codebase/CONCERNS.md` are resolved so PubSub does not create a third/fourth copy of known-bad patterns. Per PITFALLS research recommendation (Option A).

- [ ] **DEBT-01**: Reconnect logic consolidated into `OpcUaClientManager` so the upcoming PubSub Subscriber does not become a third copy of the retry loop. Single-flight reconnect lock; remove direct `isConnected` mutations from node code.
- [ ] **DEBT-02**: Public certificate-handling helper extracted from `nodes/opcua-endpoint.js` (drag-and-drop upload, sanitisation, listing, deletion) so the upcoming `opcua-pubsub-connection` config node can reuse it without duplicating routes.
- [ ] **DEBT-03**: v1.0 `msg.*` schema documented and frozen for the existing eight nodes. PubSub adds `msg.dataSet`, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber` only; existing fields (`msg.payload`, `msg.statusCode`, `msg.sourceTimestamp`, `msg.serverTimestamp`, `msg.nodeId`, `msg.operation`, `msg.error`) are not renamed or repurposed.

### Encoding

The wire format primitives. Stateless, no I/O — directly unit-testable. Gates all transport work.

- [ ] **ENC-01**: UADP binary encoder/decoder for `NetworkMessage` and `DataSetMessage` per Part 14 §7.2.4, including the three-level flag cascade (UADPFlags → ExtendedFlags1 → ExtendedFlags2), sequence numbers, PublisherId variants, WriterGroupId, DataSetWriterId, timestamps, and chunk reassembly per §7.2.4.4.4.
- [ ] **ENC-02**: JSON `NetworkMessage` encoder/decoder per Part 14 §7.2.5 and Part 6 §5.4: NodeId → string, DateTime → ISO-8601, ByteString → Base64, Variant → `{UaType, Value}`. Self-describing; requires no metadata pre-exchange.

### Configuration Objects

Pure data classes shared by Publisher and Subscriber. No I/O.

- [ ] **WGRP-01**: WriterGroup configuration (PublishingInterval, KeepAliveTime, Priority, MaxNetworkMessageSize, WriterGroupId) with validation (`KeepAliveTime >= PublishingInterval`).
- [ ] **DSW-01**: DataSetWriter + PublishedDataSet configuration (DataSetWriterId, fieldList, DataSetFieldContentMask, KeyFrameCount). Default `KeyFrameCount=1` to avoid the delta-frame cold-start pitfall.
- [ ] **DSR-01**: DataSetReader configuration (PublisherId / WriterGroupId / DataSetWriterId filters; MessageReceiveTimeout for dead-publisher detection).

### Transports

Connection adapters behind a `BaseTransport` EventEmitter interface. Encoding-agnostic — receive a `Buffer` from the manager.

- [ ] **TRP-01**: UDP-UADP multicast transport using Node.js `dgram`. Bind to `0.0.0.0` (NEVER to NIC IP); explicit `multicastInterface` config field; default `MaxNetworkMessageSize = 1400 bytes`; chunk reassembly with 30 s expiry; `socket.close(done)` on Node-RED shutdown.
- [ ] **TRP-02**: MQTT transport using `mqtt@^5.15.1`. MQTT 5.0 with 3.1.1 fallback; `retain=false` HARD-CODED on data topics; `retain=true` allowed only on metadata topics; QoS mapping per Part 14 §7.3.4; uses library reconnect — does NOT copy `forceReconnect()` from `opcua-client.js`.

### Configuration Nodes

Node-RED config nodes that own transport state and ref-count worker nodes. Mirror the `opcua-endpoint` pattern (status fan-out via EventEmitter, ref-count with grace period).

- [ ] **CFG-01**: `opcua-pubsub-connection` config node with `transportType` dropdown (`udp` or `mqtt` for v1; `amqp` deferred to v2). Owns the `BaseTransport` instance. Reuses the cert helper from DEBT-02 for transport-level certificates and PubSub signing keys. Ref-count with 500 ms grace period to absorb redeploy thrash.
- [ ] **CFG-02**: PublisherId per connection — String (UUID auto-generated default), UInt16, UInt32, or UInt64. Surfaced in editor UI.

### Publisher

The Node-RED node and its underlying manager.

- [ ] **PUB-01**: `opcua-publisher` Node-RED node — references an `opcua-pubsub-connection` config node; declares one WriterGroup with one or more DataSetWriters; cyclic OR acyclic publish mode toggle.
- [ ] **PUB-02**: Cyclic publish mode — internal `setInterval` per WriterGroup at PublishingInterval; emits KeepAlive when no value change between ticks.
- [ ] **PUB-03**: msg-driven (acyclic) publish — `msg.payload` (object keyed by field name) becomes one DataSetMessage; one outbound NetworkMessage per input msg.

### Subscriber

- [ ] **SUB-01**: `opcua-subscriber` Node-RED node — references an `opcua-pubsub-connection` config node; declares one DataSetReader with PublisherId/WriterGroupId/DataSetWriterId filter.
- [ ] **SUB-02**: Outbound `msg` shape per received DataSetMessage: `msg.payload` = field map, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.timestamp`, `msg.statusCode`, `msg.encoding`, `msg.transport`, `msg.topic` (MQTT only). ConfigurationVersion mismatch surfaced as `node.error()`, NEVER silently dropped.

### Status / Lifecycle

- [ ] **STAT-01**: `node.status()` indicator on Publisher and Subscriber: `connected` (green dot), `publishing` / `subscribed` (green ring), `disconnected` (yellow), `error` (red). Status fan-out from config node mirrors `opcua-endpoint` pattern.

### Testing

- [ ] **TEST-01**: Mocha round-trip tests for each transport × encoding combination shipped in v1: UDP-UADP, MQTT-UADP, MQTT-JSON. Each test publishes a known DataSet and asserts the subscriber decodes identical fields, types, and sequence numbers.
- [ ] **TEST-02**: 20-rapid-redeploy acceptance test for the `opcua-pubsub-connection` config node — simulates Node-RED deploy/undeploy cycles; asserts no `EADDRINUSE` errors, no socket leaks, no duplicate messages.
- [ ] **TEST-03**: UADP encoder unit tests verified against open62541 reference output for the flag-cascade boundary cases (all 8 combinations of ExtendedFlags1/ExtendedFlags2 presence).

### Documentation / Examples

- [ ] **DOC-01**: Three example flows shipped under `examples/`:
  - `10 - PubSub UDP-UADP Loopback.json` (publisher + subscriber on same host, multicast)
  - `11 - PubSub MQTT-UADP.json` (against a Mosquitto broker)
  - `12 - PubSub MQTT-JSON.json` (cloud-friendly JSON over MQTT)
- [ ] **DOC-02**: README.md PubSub section explaining the configuration hierarchy (Connection → WriterGroup → DataSetWriter → PublishedDataSet on the Publisher; Connection → DataSetReader on the Subscriber), with msg-shape reference and the UDP NIC-selection caveat made explicit.

## v2 Requirements

Add after PubSub v1 ships and is validated. Tracked but not in current roadmap.

### AMQP Transport

- **TRP-03**: AMQP 1.0 transport using `rhea@^3.0.5` (NOT `amqplib`, which is AMQP 0-9-1).
- **PUB-04**: AMQP-UADP Publisher.
- **SUB-04**: AMQP-UADP Subscriber.

### Spec-Conformance Polish

- **META-01**: DataSetMetaData publishing on the MQTT retained metadata topic (`<prefix>/<encoding>/metadata/...`); enables third-party MQTT-UADP subscribers to decode without out-of-band schema knowledge. Triggered on first connect and on DataSet version change.
- **DELTA-01**: KeyFrame / DeltaFrame control with `KeyFrameCount > 1` and subscriber cold-start handling (visible status until first KeyFrame arrives).
- **GAP-01**: Sequence number gap detection on Subscriber — emit `msg.sequenceGap` when a sequence number gap is detected; valued for QoS monitoring in time-sensitive control loops.

### Security (Sign Only)

- **SEC-01**: UADP message signing (SecurityMode = Sign) with static pre-shared key OR external SKS endpoint reference. HMAC over NetworkMessage body. Encryption explicitly NOT in v2 — see Out of Scope.

### Dynamic Reconfiguration

- **DYN-01**: msg-driven DataSet reconfiguration — `msg.command = "setDataSet"` + `msg.fields = [...]` reconfigures the Publisher's PublishedDataSet without redeploying the flow.

## v3+ Requirements

Future consideration only. Not roadmapped.

- **ENC-03**: UADP message encryption (SecurityMode = SignAndEncrypt). Requires AES-CTR nonce safety guarantees that are unsafe without SKS key rotation.
- **SKS-01**: SKS client integration — fetch keys from external Security Key Service rather than static config.
- **TGT-01**: SubscribedDataSet TargetVariables — wires received DataSet fields directly into the embedded `opcua-server` address space.
- **META-02**: DataSetMetaData versioning + automatic resubscribe state machine (full Part 14 §7.3.4.7 compliance).

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| OPC UA SKS server implementation | Conformant SKS server is a separate milestone. v1/v2 supply keys via static config. |
| PubSub configuration via UA address space (Part 14 §9) | Requires embedding the full PubSub Information Model in `opcua-server`. Static Node-RED config is the v1/v2 mechanism. |
| Discovery announcements / reverse PubSub | Adds protocol state machine complexity disproportionate to v1/v2 benefit. Static PublisherId+topic config is sufficient. |
| WebSocket / HTTP transport | Not standardised in current Part 14. No conformant interoperability target. Use MQTT with broker-level WebSocket bridging instead. |
| Commercial node-opcua PubSub bindings (`@sterfive/...`) | Changes the suite's MIT licensing posture; vendor lock-in. UADP is implemented in-tree. |
| Per-field QoS or priority routing | Part 14 only defines Priority at WriterGroup level. Per-field QoS would be non-conformant. Use multiple WriterGroups. |
| Replacing or refactoring existing eight Client/Server nodes | PROJECT.md constraint: zero breaking changes. Any shared-utility improvements must be backwards-compatible. |
| `amqplib` for AMQP transport | Implements AMQP 0-9-1; Part 14 §B.3 normatively requires AMQP 1.0 (use `rhea` instead). |

## Traceability

Empty until ROADMAP.md is created. The `gsd-roadmapper` agent populates this table.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DEBT-01 | TBD | Pending |
| DEBT-02 | TBD | Pending |
| DEBT-03 | TBD | Pending |
| ENC-01 | TBD | Pending |
| ENC-02 | TBD | Pending |
| WGRP-01 | TBD | Pending |
| DSW-01 | TBD | Pending |
| DSR-01 | TBD | Pending |
| TRP-01 | TBD | Pending |
| TRP-02 | TBD | Pending |
| CFG-01 | TBD | Pending |
| CFG-02 | TBD | Pending |
| PUB-01 | TBD | Pending |
| PUB-02 | TBD | Pending |
| PUB-03 | TBD | Pending |
| SUB-01 | TBD | Pending |
| SUB-02 | TBD | Pending |
| STAT-01 | TBD | Pending |
| TEST-01 | TBD | Pending |
| TEST-02 | TBD | Pending |
| TEST-03 | TBD | Pending |
| DOC-01 | TBD | Pending |
| DOC-02 | TBD | Pending |

**Coverage:**
- v1 requirements: 23 total
- Mapped to phases: 0 (pending roadmap creation)
- Unmapped: 23 ⚠ (will be 0 after gsd-roadmapper runs)

---
*Requirements defined: 2026-05-08*
*Last updated: 2026-05-08 after research synthesis*

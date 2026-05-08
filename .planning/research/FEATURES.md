# Feature Research

**Domain:** OPC UA PubSub Publisher/Subscriber Node-RED nodes (Part 14 milestone)
**Researched:** 2026-05-08
**Confidence:** HIGH (primary sources: OPC Foundation Part 14 spec, open62541 docs, OPC Labs KB, UA-IIoT-StarterKit)

---

## Scope Boundary

This file covers **new PubSub features only**. The existing eight Client/Server nodes are shipped and out of scope. PubSub is purely additive; no existing node behaviour changes.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete or non-conformant with Part 14.

| Feature | Why Expected | Complexity | Part 14 Ref | Notes |
|---------|--------------|------------|------------|-------|
| **UADP binary encoder/decoder** | Every UDP-UADP and MQTT-UADP exchange requires it; it is the foundational wire format. No open-source `node-opcua` equivalent exists — must be in-tree. | HIGH (XL) | §7.2 | NetworkMessage + DataSetMessage binary layout with flag bytes, sequence numbers, PublisherId, WriterGroupId, DataSetWriterId, timestamps. Prerequisite for all UADP transports. |
| **JSON NetworkMessage encoder/decoder** | MQTT-JSON is the dominant OT/cloud integration pattern; industrial users expect human-readable payloads on MQTT brokers. | MEDIUM (M) | §7.2.3 | Follows `opcua:` key-naming convention; fields encoded per DataSetFieldContentMask. JSON encoding is self-describing and requires no metadata pre-exchange. |
| **UDP-UADP multicast Publisher** | "Brokerless" transport for plant-floor real-time control; many OT users have no broker infrastructure. Standard address `opc.udp://<multicast-ip>:<port>` (default 4840). | MEDIUM (M) | §7.3.2 | Requires UADP encoder. UDP socket on configurable bind-interface; multicast group join. PublishingInterval down to ~50 ms (per project perf requirement). |
| **UDP-UADP multicast Subscriber** | Counterpart to UDP Publisher; users need both directions. | MEDIUM (M) | §7.3.2 | Requires UADP decoder. Socket must join multicast group on correct NIC — wrong-NIC is the #1 UDP pitfall (OPC Labs KB). |
| **MQTT-UADP Publisher** | Broker-based UADP for sites with existing MQTT infrastructure (Sparkplug-adjacent). | MEDIUM (M) | §7.3.4 | Requires `mqtt` npm dep. Topic structure: `<prefix>/<encoding>/data/<PublisherId>/<WriterGroupName>[/<DataSetWriterName>]`. RETAIN=false for data; RETAIN=true for metadata. |
| **MQTT-UADP Subscriber** | Counterpart; wildcard subscriptions to broker topics. | MEDIUM (M) | §7.3.4 | Requires `mqtt` dep. Subscriber must handle reconnect and re-subscribe on broker loss. |
| **MQTT-JSON Publisher** | Most common cloud/analytics integration path; expected by any Node-RED user targeting Azure IoT Hub, AWS IoT Core, or HiveMQ. | MEDIUM (M) | §7.2.3, §7.3.4 | Requires JSON encoder. Same MQTT topic convention as MQTT-UADP but `encoding=json`. |
| **MQTT-JSON Subscriber** | Counterpart; needed for downstream flow nodes to process OPC UA data without custom parsing. | MEDIUM (M) | §7.2.3, §7.3.4 | JSON decoder; outputs Node-RED `msg.payload` as plain JS object keyed by DataSet field name. |
| **PubSub connection config node(s)** | Node-RED convention: shared infrastructure goes in config nodes. Users expect to configure the broker/UDP address once and reuse it across Publisher/Subscriber worker nodes — identical mental model to existing `opcua-endpoint`. | MEDIUM (M) | §6.2.1 | One config node per transport type: `opcua-pubsub-udp`, `opcua-pubsub-mqtt`, `opcua-pubsub-amqp`. Owns connection state, ref-counts worker nodes, emits status events. |
| **WriterGroup parameters in Publisher config** | WriterGroup is the direct container that controls publish timing. Users must be able to set PublishingInterval, KeepAliveTime, Priority, MaxNetworkMessageSize, WriterGroupId. | MEDIUM (S) | §6.2.5 | WriterGroup is mandatory; at minimum PublishingInterval (ms) must be exposed in the editor UI. |
| **DataSetWriter + PublishedDataSet config** | The user must declare *what* to publish. Minimum viable: a static list of `(fieldName, value-or-nodeId)` pairs on the Publisher node. | MEDIUM (M) | §6.2.6, §6.2.3 | DataSetWriterId (UInt16, unique per WriterGroup), DataSetFieldContentMask (value-only vs value+status+timestamps), KeyFrameCount. |
| **DataSetReader config on Subscriber** | Subscriber must declare which Publisher/WriterGroup/DataSetWriter it is interested in (filter by PublisherId + WriterGroupId + DataSetWriterId). Without explicit filter, subscriber sees everything which breaks multi-publisher setups. | MEDIUM (S) | §6.2.9 | PublisherId, WriterGroupId, DataSetWriterId as filter fields. MessageReceiveTimeout for dead-publisher detection. |
| **msg-driven Publisher input** | Node-RED idiom: wire a trigger or inject node into the Publisher to control what gets published. `msg.payload` (or `msg.dataset`) carries the field values to send as a DataSetMessage. | LOW (S) | — | Mirrors `opcua-client`'s `msg`-driven API. Publisher emits one NetworkMessage per input `msg` (acyclic mode) or on interval with last-known values (cyclic mode). |
| **msg output on Subscriber** | Subscriber emits one `msg` per received DataSetMessage with `msg.payload` = decoded field map, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.timestamp`. | LOW (S) | — | Standard Node-RED pattern; output must be structured identically to what users see from `opcua-client` subscribe operation for consistency. |
| **Configurable PublisherId** | PublisherId uniquely identifies the publisher on the network. Missing or clashing IDs cause subscriber filter failures. Must be set per connection config node. Types: Byte / UInt16 / UInt32 / UInt64 / String. | LOW (S) | §6.2.1 | Default: auto-generated String UUID to avoid collisions in dev environments. |
| **NetworkInterface selection for UDP** | Multi-homed Linux/Docker hosts (common deployment target) require explicit NIC selection for UDP multicast. Without it, wrong-interface publish/subscribe is the single most reported UDP PubSub bug. | LOW (S) | §7.3.2 | Exposed as a text config field on `opcua-pubsub-udp` config node. |
| **Node status indicators** | Every existing node uses `node.status()` for connection state. Users expect the same red/green/yellow pattern on Publisher and Subscriber nodes. | LOW (S) | — | States: `connected`, `publishing`, `disconnected`, `error`. Mirrors status fan-out pattern from `opcua-endpoint`. |
| **Round-trip test flows / examples** | Node-RED users evaluate packages by importing example flows. Without examples, PubSub nodes will not be adopted even if functional. | LOW (S) | — | Three example flows minimum: (1) UDP-UADP pub+sub loopback, (2) MQTT-UADP, (3) MQTT-JSON. See PROJECT.md Active requirements. |

### Differentiators (Competitive Advantage)

Features that set this package apart from the gap in the ecosystem (no open-source Node-RED PubSub package exists as of 2026-05).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **AMQP-UADP Publisher + Subscriber** | Covers the full Part 14 transport trinity (UDP + MQTT + AMQP). Industrial users targeting Azure Service Bus, RabbitMQ, or ActiveMQ expect AMQP support. Competitive SDKs (UA-.NETStandard) support it. | HIGH (L) | Uses `amqplib` npm dep. AMQP exchange/routing-key maps to WriterGroup/DataSetWriter naming. Implement after UDP+MQTT are stable — deferral candidate. |
| **DataSetMetaData publishing on MQTT** | Publishes metadata messages to the `<prefix>/<encoding>/metadata/...` retained topic so new subscribers can decode fields without prior configuration. Without it, MQTT-UADP subscribers require out-of-band schema knowledge. | MEDIUM (M) | §7.3.4.7 | Metadata topic uses RETAIN=true. Triggered on first connect and on DataSet version change. Dependent on MQTT transport. |
| **KeyFrame / DeltaFrame control** | `KeyFrameCount > 1` reduces bandwidth by sending only changed fields in delta frames. Valued in high-frequency OT scenarios (50 ms intervals with mostly-static values). | MEDIUM (M) | §6.2.6 | DeltaFrame pitfall: subscriber delays full dataset until first KeyFrame arrives. Must be documented prominently. |
| **Cyclic vs acyclic publish mode** | Cyclic: Publisher fires on `PublishingInterval` timer using last-known payload, emitting KeepAlive when no change. Acyclic: Publisher fires on each input `msg`. Both modes valued: cyclic for sensor polling, acyclic for event-driven publishing. | MEDIUM (M) | §5.4.1.2 | Mode toggle in node config. Cyclic requires an internal interval timer in the publisher manager. |
| **msg-driven DataSet reconfiguration** | `msg.command = "setDataSet"` + `msg.fields = [...]` lets flows reconfigure what gets published without redeploying. Useful for dynamic OT scenarios where tag lists change. | MEDIUM (M) | — | Follows `opcua-server`'s `msg.command` dispatch pattern. Deferred to v1.x. |
| **Reuse of opcua-certs upload UI for PubSub signing keys** | Users deploying signed/encrypted UADP messages need to supply pre-shared keys or certificates. Reusing the existing drag-and-drop cert upload endpoint removes new UI complexity. | LOW (S) | §5.4.3 | Extends `GET /opcua-endpoint/certs` to also serve from a PubSub key subdirectory, or adds a separate `opcua-pubsub-security` config node that reuses the same HTTP admin routes. |
| **UADP message signing (SecurityMode = Sign)** | Provides message integrity for UDP-UADP deployments without a broker. Required for any plant-floor deployment where network authenticity matters. | HIGH (XL) | §7.2.4 | Requires pre-shared key from SKS (external) or static key configuration. Signing = HMAC over NetworkMessage body. SKS client implementation is additive; static key is simpler v1 option. |
| **UADP message encryption (SecurityMode = SignAndEncrypt)** | Full confidentiality for OT data crossing DMZ. | HIGH (XL) | §A.3.6 | Builds on signing; adds AES-CTR or AES-CBC over DataSetMessage payload. Deferral candidate for v1.x. |
| **Sequence number gap detection on Subscriber** | Subscriber can detect dropped UDP packets by checking sequence number gaps and emitting a `msg.sequenceGap` warning. Valued for quality monitoring in time-sensitive control loops. | LOW (S) | §7.2.2 | Per-DataSetReader last-seen sequence number tracked in subscriber manager. |
| **SubscribedDataSet TargetVariables wiring** | Maps received DataSet fields directly to the embedded OPC UA server's address space (via `opcua-server` node). Enables PubSub-fed server variables without a function node. | HIGH (L) | §6.2.10 | Requires coordination between `opcua-subscriber` and `opcua-server` nodes. Deferred to v1.x. |

### Anti-Features (Deliberately NOT Building)

| Feature | Why Requested | Why Not Building | What Instead |
|---------|---------------|-----------------|-------------|
| **SKS (Security Key Service) server** | PubSub security requires a key distributor; users may assume it comes bundled. | Implementing a conformant SKS is a large, separate milestone. Scope risk. Out of scope per PROJECT.md. | Users supply pre-shared keys via static config, or point to an external SKS endpoint. |
| **PubSub config via UA address space (Part 14 §9)** | Some tools expect to configure PubSub by writing to a server's PubSubConfiguration object via OPC UA Client. | Requires embedding the full PubSub Information Model in `opcua-server`, which is a major server-side feature set. Out of scope per PROJECT.md. | Static Node-RED config (flow deploy) is the configuration mechanism for v1. |
| **Discovery announcements / reverse PubSub** | Part 14 §7.2.2 defines discovery probe/response messages so subscribers can auto-discover publishers. | Discovery requires additional message types (DiscoveryResponse, ApplicationDescription) and adds protocol state machine complexity disproportionate to v1 benefit. Out of scope per PROJECT.md. | Static PublisherId + topic configuration is sufficient. |
| **WebSocket / HTTP transport** | Part 14 mentions WebSocket as a future transport. Some Node-RED users are familiar with HTTP-based messaging. | Not standardised in current Part 14. No conformant interoperability target. Out of scope per PROJECT.md. | Use MQTT transport; most brokers support WebSocket bridging at the broker level. |
| **Commercial `node-opcua` PubSub bindings** | Would be the easiest path to a conformant implementation. | Changes the suite's MIT licensing posture; vendor lock-in; cost. Out of scope per PROJECT.md. | UADP encoder/decoder implemented in-tree under MIT. |
| **Per-field QoS or priority routing** | Seems natural for OT triage. | Part 14 defines Priority only at WriterGroup level, not per-field. Per-field QoS is not part of the spec and would be a non-conformant extension. | Use multiple WriterGroups with different priorities/intervals. |
| **Replacing/refactoring existing Client-Server nodes** | PubSub work might surface improvements to `opcua-endpoint`. | Breaking changes to shipped nodes violate the explicit constraint in PROJECT.md. | PubSub infrastructure is additive; any improvements to shared utilities (`opcua-utils.js`) must be backwards-compatible. |

---

## Feature Dependencies

```
UADP Encoder/Decoder (in-tree)
    └──required-by──> UDP-UADP Publisher
    └──required-by──> UDP-UADP Subscriber
    └──required-by──> MQTT-UADP Publisher
    └──required-by──> MQTT-UADP Subscriber
    └──required-by──> AMQP-UADP Publisher      (differentiator, phase 2)
    └──required-by──> AMQP-UADP Subscriber     (differentiator, phase 2)
    └──required-by──> UADP Signing             (differentiator, phase 2)
    └──required-by──> UADP Signing+Encryption  (differentiator, v1.x)

JSON Encoder/Decoder
    └──required-by──> MQTT-JSON Publisher
    └──required-by──> MQTT-JSON Subscriber

opcua-pubsub-mqtt config node
    └──required-by──> MQTT-UADP Publisher
    └──required-by──> MQTT-UADP Subscriber
    └──required-by──> MQTT-JSON Publisher
    └──required-by──> MQTT-JSON Subscriber
    └──enhanced-by──> DataSetMetaData publishing (RETAIN metadata topic)

opcua-pubsub-udp config node
    └──required-by──> UDP-UADP Publisher
    └──required-by──> UDP-UADP Subscriber

opcua-pubsub-amqp config node
    └──required-by──> AMQP-UADP Publisher
    └──required-by──> AMQP-UADP Subscriber

WriterGroup config (PublishingInterval, KeepAliveTime, WriterGroupId)
    └──required-by──> all Publisher nodes

DataSetWriter + PublishedDataSet config (DataSetWriterId, fieldList, DataSetFieldContentMask)
    └──required-by──> all Publisher nodes
    └──enhanced-by──> KeyFrame/DeltaFrame control (KeyFrameCount > 1)

DataSetReader config (PublisherId filter, WriterGroupId filter, DataSetWriterId filter)
    └──required-by──> all Subscriber nodes
    └──enhanced-by──> Sequence number gap detection

msg-driven Publisher input
    └──required-by──> acyclic publish mode
    └──enhanced-by──> msg-driven DataSet reconfiguration (v1.x)

Cyclic publish mode (internal timer)
    └──enhanced-by──> KeepAlive transmission when no data change

UADP Signing
    └──required-by──> UADP Signing+Encryption
    └──enhanced-by──> opcua-certs UI reuse for key management
```

### Dependency Notes

- **UADP Encoder is the single most critical prerequisite**: it gates all three UADP transports. Must be phase 1.
- **JSON Encoder is independent of UADP Encoder**: can be developed in parallel. Simpler (no binary bit-packing), good vehicle to validate the DataSet schema model before binary work lands.
- **MQTT transport depends on `mqtt` npm package**: low-risk, well-maintained, MIT license. Install once; serves three of six transport×encoding combinations.
- **AMQP transport depends on `amqplib`**: also MIT. However, AMQP is lowest-demand transport per community evidence; defer to after UDP+MQTT shipping.
- **DataSetMetaData enhances MQTT**: metadata publishing requires MQTT transport to be operational first. It is not required for JSON (JSON messages are self-describing) but is required for UADP-over-MQTT where field ordering is binary-encoded.
- **Signing conflicts with static-key-only operation**: once signing is enabled, all messages in the WriterGroup must be signed. Mixed signed/unsigned is not a valid Part 14 state.

---

## MVP Definition

### Launch With (v1 — this milestone)

Minimum viable product to validate concept and cover the three transports.

- [ ] **UADP encoder/decoder (in-tree)** — gates all UADP transports; no escape hatch
- [ ] **JSON NetworkMessage encoder/decoder** — simplest path to validate DataSet model; enables MQTT-JSON before MQTT-UADP is complete
- [ ] **`opcua-pubsub-udp` config node** — UDP multicast connection + NIC selection + PublisherId
- [ ] **`opcua-pubsub-mqtt` config node** — MQTT broker URL + credentials + TLS + MQTT protocol version
- [ ] **UDP-UADP Publisher node** — msg-driven acyclic publish; WriterGroup + DataSetWriter config in node editor
- [ ] **UDP-UADP Subscriber node** — DataSetReader filter config; emits `msg.payload` on receipt
- [ ] **MQTT-JSON Publisher node** — JSON encoding over MQTT; metadata topic support
- [ ] **MQTT-JSON Subscriber node** — JSON decoding; wildcard topic subscription
- [ ] **MQTT-UADP Publisher node** — binary UADP over MQTT (requires encoder + MQTT config)
- [ ] **MQTT-UADP Subscriber node** — binary UADP decode from MQTT
- [ ] **Cyclic publish mode** — internal PublishingInterval timer + KeepAlive
- [ ] **Mocha round-trip tests** for each transport×encoding pair (UDP-UADP, MQTT-JSON, MQTT-UADP)
- [ ] **Three example flows** (UDP loopback, MQTT-UADP, MQTT-JSON)

### Add After Validation (v1.x)

- [ ] **AMQP-UADP Publisher + Subscriber + `opcua-pubsub-amqp` config node** — demand exists but AMQP evidence is weaker; defer until v1 is stable
- [ ] **UADP message signing (SecurityMode = Sign)** — required for plant-floor authenticity; complex but high value
- [ ] **msg-driven DataSet reconfiguration** (`msg.command = "setDataSet"`) — add when users request dynamic tag lists
- [ ] **KeyFrame/DeltaFrame control** — bandwidth optimisation; add when high-frequency use cases are reported
- [ ] **Sequence number gap detection** — diagnostic feature; add when gap-reporting is requested

### Future Consideration (v2+)

- [ ] **UADP message encryption (SignAndEncrypt)** — builds on signing; significant key management complexity
- [ ] **SubscribedDataSet TargetVariables** — PubSub-fed OPC UA server variables; requires opcua-server node integration
- [ ] **DataSetMetaData versioning and automatic re-subscribe** — full Part 14 §7.3.4.7 compliance for MQTT; complex state machine
- [ ] **SKS client integration** — fetch keys from external Security Key Service rather than static config

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| UADP encoder/decoder | HIGH | HIGH | P1 |
| JSON encoder/decoder | HIGH | MEDIUM | P1 |
| `opcua-pubsub-udp` config node | HIGH | MEDIUM | P1 |
| `opcua-pubsub-mqtt` config node | HIGH | MEDIUM | P1 |
| UDP-UADP Publisher | HIGH | MEDIUM | P1 |
| UDP-UADP Subscriber | HIGH | MEDIUM | P1 |
| MQTT-JSON Publisher | HIGH | MEDIUM | P1 |
| MQTT-JSON Subscriber | HIGH | MEDIUM | P1 |
| MQTT-UADP Publisher | HIGH | MEDIUM | P1 |
| MQTT-UADP Subscriber | HIGH | MEDIUM | P1 |
| WriterGroup config (interval, KeepAlive) | HIGH | LOW | P1 |
| DataSetWriter + PublishedDataSet config | HIGH | MEDIUM | P1 |
| DataSetReader filter config | HIGH | LOW | P1 |
| Cyclic publish mode | MEDIUM | MEDIUM | P1 |
| Node status indicators | MEDIUM | LOW | P1 |
| Example flows | HIGH | LOW | P1 |
| DataSetMetaData on MQTT | MEDIUM | MEDIUM | P2 |
| AMQP Publisher + Subscriber | MEDIUM | HIGH | P2 |
| UADP signing | HIGH | HIGH | P2 |
| KeyFrame/DeltaFrame control | MEDIUM | MEDIUM | P2 |
| Sequence number gap detection | LOW | LOW | P2 |
| msg-driven DataSet reconfiguration | MEDIUM | MEDIUM | P2 |
| UADP encryption | MEDIUM | HIGH | P3 |
| SubscribedDataSet TargetVariables | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for v1 launch
- P2: Should have, add in v1.x after validation
- P3: Nice to have, defer to v2+

---

## Competitor / Ecosystem Analysis

| Feature | node-red-contrib-opcua (mikakaraila) | node-red-contrib-iiot-opcua | This package (target) |
|---------|--------------------------------------|-----------------------------|-----------------------|
| OPC UA PubSub Publisher | Not implemented | Not implemented | v1 milestone |
| OPC UA PubSub Subscriber | Not implemented | Not implemented | v1 milestone |
| UADP binary encoding | Not implemented | Not implemented | In-tree, MIT |
| MQTT-JSON encoding | Not implemented (uses classic sub) | Not implemented | v1 milestone |
| UDP multicast transport | Not implemented | Not implemented | v1 milestone |
| AMQP transport | Not implemented | Not implemented | v1.x |
| Connection config node pattern | `OpcUaEndpoint` config node | Multiple config nodes | `opcua-pubsub-{udp,mqtt,amqp}` |
| Status fan-out | Partial | Yes | Yes (mirrors opcua-endpoint) |
| MIT license | MIT | MIT (revitalized 2022) | MIT (constraint) |

No existing open-source Node-RED package implements OPC UA Part 14 PubSub. This is a greenfield differentiator in the Node-RED ecosystem.

---

## Configuration Model Reference

The following summarises the configuration hierarchy users will interact with. This directly informs the node editor UI design.

### Publisher side

```
opcua-pubsub-mqtt config node
  └── url: "mqtt://broker:1883"
  └── publisherId: "plant-a-gateway-1"   (String | UInt16 | UInt32)
  └── credentials: { username, password }
  └── tls: { caCert, clientCert, clientKey }

opcua-publisher node (references config node)
  └── transport: mqtt | udp | amqp
  └── encoding: uadp | json
  └── writerGroup:
  │     └── writerGroupId: 1             (UInt16, unique per PublisherId)
  │     └── publishingInterval: 1000     (ms, Duration)
  │     └── keepAliveTime: 5000          (ms, >= publishingInterval)
  │     └── priority: 0                  (0–255)
  │     └── maxNetworkMessageSize: 1472  (bytes, MTU-safe default for UDP)
  └── dataSetWriter:
  │     └── dataSetWriterId: 1           (UInt16, unique per WriterGroup)
  │     └── dataSetFieldContentMask: 0   (0=RawValue, 3=Value+StatusCode, 7=+Timestamps)
  │     └── keyFrameCount: 1             (1=every message is keyframe; >1=deltaframe on changes)
  └── publishMode: cyclic | acyclic
  └── fields: [ { name: "Temperature", value: null } ]  (static list; value overridden by msg.payload)
```

### Subscriber side

```
opcua-pubsub-mqtt config node   (shared with Publisher, same node type)

opcua-subscriber node (references config node)
  └── transport: mqtt | udp | amqp
  └── encoding: uadp | json
  └── topicFilter: "opcua/json/data/plant-a-gateway-1/#"  (MQTT only)
  └── dataSetReader:
        └── publisherId: "plant-a-gateway-1"   (filter; empty = accept all)
        └── writerGroupId: 1                   (filter; 0 = accept all)
        └── dataSetWriterId: 1                 (filter; 0 = accept all)
        └── messageReceiveTimeout: 10000       (ms; 0 = disabled)
```

### Output msg shape (Subscriber)

```javascript
msg = {
  payload: { Temperature: 23.4, Pressure: 1.01 },  // field name → decoded value
  publisherId: "plant-a-gateway-1",
  writerGroupId: 1,
  dataSetWriterId: 1,
  sequenceNumber: 42,
  timestamp: "2026-05-08T10:00:00.000Z",
  statusCode: "Good",
  encoding: "json",    // "uadp" or "json"
  transport: "mqtt",   // "mqtt", "udp", "amqp"
  topic: "opcua/json/data/plant-a-gateway-1/group1/writer1"  // MQTT only
}
```

---

## Sources

- [UA Part 14: PubSub — OPC Foundation Online Reference v1.05](https://reference.opcfoundation.org/Core/Part14/v105/docs/5)
- [UA Part 14: §6.2.5 WriterGroup Parameters](https://reference.opcfoundation.org/Core/Part14/v104/docs/6.2.5)
- [UA Part 14: §7.3.4 MQTT Mapping](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.3.4)
- [UA Part 14: §7.2.2 UADP Message Mapping](https://reference.opcfoundation.org/Core/Part14/v104/docs/7.2.2)
- [open62541 PubSub API documentation](https://open62541.org/doc/master/pubsub.html)
- [OPC Foundation UA-.NETStandard PubSub.md](https://github.com/OPCFoundation/UA-.NETStandard/blob/master/Docs/PubSub.md)
- [OPC UA IIoT StarterKit — UaMqttPublisher](https://opcfoundation.github.io/UA-IIoT-StarterKit/UaMqttPublisher/)
- [OPC Labs KB — OPC UA PubSub Traps and Pitfalls](https://kb.opclabs.com/OPC_UA_PubSub_Traps_And_Pitfalls)
- [Beckhoff TF6105 — KeyFrames, DeltaFrames, KeepAlive](https://infosys.beckhoff.com/content/1033/tf6105_tc3_opc_ua_pub_sub/10407882251.html)
- [Traffic-Aware Configuration of OPC UA PubSub in Industrial Automation Networks (arXiv 2602.19603)](https://arxiv.org/html/2602.19603)
- [industry40.tv — OPC UA PubSub Explained](https://www.industry40.tv/blog-post/opc-ua-pubsub-explained-understanding-publish-subscribe-communication-and-opc-ua-over-mqtt)

---
*Feature research for: OPC UA PubSub Publisher/Subscriber Node-RED nodes (Part 14 milestone)*
*Researched: 2026-05-08*

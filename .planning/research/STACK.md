# Stack Research

**Domain:** OPC UA PubSub (Part 14) — Publisher + Subscriber, UDP-UADP multicast + MQTT + AMQP transports, UADP binary + JSON encodings, Node.js / Node-RED context
**Researched:** 2026-05-08
**Confidence:** HIGH (all versions verified against npm registry as of 2026-05-08; spec requirements verified against OPC UA Online Reference v105)

---

## Executive Summary

Adding OPC UA PubSub (Part 14) to `node-red-contrib-opcua-suite` requires **two new direct runtime dependencies** (`mqtt` and `rhea`) plus **zero new encoding libraries** — all UADP binary primitives are already present as transitive dependencies of `node-opcua@2.163.1`. UDP multicast uses Node.js built-in `dgram`. JSON encoding uses standard `JSON.stringify/parse` with custom OPC UA type serializers written against already-available transitive modules. `@sterfive/node-opcua-pubsub` is definitively ruled out (commercial, non-public registry, incompatible licensing posture).

---

## Recommended Stack

### Core Technologies

| Technology | Version | License | Purpose | Why Recommended |
|------------|---------|---------|---------|-----------------|
| `mqtt` | `^5.15.1` | MIT | MQTT transport (Publisher + Subscriber) | Only actively-maintained MIT MQTT client for Node.js; ships MQTT 5.0 support (`protocolVersion: 5`) needed for `contentType` and `userProperties` headers required by Part 14 §7.3.4; 5.15.1 published 2026-03-24 — actively maintained |
| `rhea` | `^3.0.5` | Apache-2.0 | AMQP 1.0 transport (Publisher + Subscriber) | OPC UA Part 14 §7.3.4 normatively references AMQP **1.0** (ISO/IEC 19464:2014) — `amqplib` implements AMQP **0-9-1** and is therefore non-conformant for Part 14; `rhea` is the AMQP/Apache Foundation's own Node.js AMQP 1.0 library; 3.0.5 published 2026-04-28 — actively maintained; Apache-2.0 is compatible with MIT-licensed projects (permissive, no copyleft) |
| Node.js `dgram` (built-in) | Node.js ≥18 | N/A | UDP-UADP multicast transport | No npm dep needed; `dgram.createSocket('udp4')` + `socket.addMembership(multicastAddr)` covers IGMP join; `socket.dropMembership()` on close covers IGMP leave; `setMulticastTTL(1)` for LAN-only scope; all multicast methods available since Node.js 0.x, confirmed stable in v18 docs |

### UADP Binary Encoding — In-Tree, Using Transitive Deps

**Decision: implement UADP NetworkMessage and DataSetMessage encoding entirely in-tree.**

No new npm dependency is needed. The following submodules are already present under `node_modules/` as transitive dependencies of `node-opcua@2.163.1` and are directly `require()`-able from CommonJS without any build step (all ship pre-compiled `.js` in `dist/`):

| Transitive Module | Version (installed) | License | What it provides for UADP |
|-------------------|--------------------|---------|-----------------------------|
| `node-opcua-binary-stream` | 2.162.0 | MIT | `BinaryStream` (cursor-based LE buffer read/write), `BinaryStreamSizeCalculator` (pre-calculate frame size before allocation) |
| `node-opcua-basic-types` | 2.162.0 | MIT | `encodeUInt8/16/32/64`, `encodeFloat/Double`, `encodeDateTime`, `encodeNodeId`, `encodeGuid`, `encodeByteString`, `encodeString` + matching `decode*` functions — covers every primitive field in a UADP NetworkMessage header |
| `node-opcua-variant` | (via node-opcua) | MIT | `encodeVariant`, `decodeVariant`, `DataType`, `Variant`, `VariantArrayType` — covers DataSetMessage field values |
| `node-opcua-data-value` | (via node-opcua) | MIT | `encodeDataValue`, `decodeDataValue`, `DataValue` — covers DataSetMessage with status/timestamps |
| `node-opcua-types` | (via node-opcua) | MIT | `UadpNetworkMessageContentMask`, `UadpDataSetMessageContentMask`, `JsonDataSetMessage`, `DataSetWriterMessageDataType`, `UadpWriterGroupMessageDataType` — Part 14 content mask enums already defined |

**Wire format reference:** OPC UA Part 14 §7.2.4 (v105). The UADP NetworkMessage header is encoded with a `UADPVersion + Flags1` byte, optional `Flags2` byte, optional `PublisherId` (variable type/length), optional `DataSetClassId` (GUID, 16 bytes), optional `GroupHeader` (WriterGroup-related), optional `PayloadHeader` (array of DataSetWriterIds), then per-DataSetMessage payloads. All fields use LE binary encoding matching `BinaryStream`'s convention.

**Fragmentation/chunking:** Part 14 §7.2.4.4.4 defines chunk NetworkMessages (field: `ChunkOffset` UInt32, `TotalSize` UInt32, `MessageSequenceNumber` UInt16, `ChunkData` ByteString). The spec recommends keeping messages ≤1472 bytes (IPv4 single Ethernet frame = 1500B − 20B IP − 8B UDP). Implement chunking in-tree for the publisher; implement reassembly buffer in the subscriber. No external library required — a simple `Map<DataSetWriterId, { chunks, totalSize }>` accumulator pattern suffices.

### JSON Encoding — In-Tree

OPC UA Part 14 §7.2.5 JSON NetworkMessage encoding maps onto the OPC UA JSON rules in Part 6 §5.4. Key decisions:

- Use `JSON.stringify`/`JSON.parse` as the serialization base.
- `DateTime` → ISO 8601 string (`date.toISOString()`), with boundary handling (`"0001-01-01T00:00:00Z"` for min).
- `NodeId` → string per Part 6 §5.1.12 (e.g. `"ns=2;s=MyNode"` for string ids, `"i=1234"` for namespace 0 numeric).
- `ByteString` → Base64 (`Buffer.from(buf).toString('base64')`).
- `Variant` → `{ "UaType": <DataType enum>, "Value": <...> }` (CompactEncoding).
- `DataValue` → `{ "Value": <Variant>, "StatusCode": <number>, "SourceTimestamp": <ISO string>, ... }`.
- Implement as a small `lib/pubsub-json-encoder.js` — no external library needed; all type info comes from `node-opcua-types` and `node-opcua-variant` already loaded.
- Content-type: `application/json` (MQTT `contentType` property / AMQP `content-type` field).

### Supporting Libraries

| Library | Version | License | Purpose | When to Use |
|---------|---------|---------|---------|-------------|
| `node-opcua-binary-stream` (transitive) | 2.162.0 | MIT | UADP frame serializer/deserializer | Always — every UADP encode/decode path |
| `node-opcua-basic-types` (transitive) | 2.162.0 | MIT | Primitive encode/decode | Always — every UADP field |
| `node-opcua-variant` (transitive) | (installed) | MIT | Variant encode/decode | Always — DataSetMessage field values |
| `node-opcua-data-value` (transitive) | (installed) | MIT | DataValue encode/decode | When `DataSetFieldContentMask` includes StatusCode / timestamps |
| `node-opcua-types` (transitive) | (installed) | MIT | Content mask enums, JSON type stubs | Always — mask flag constants for UADP header |

### Development Tools

No new dev tools required beyond the existing Mocha / Chai / Sinon suite. Round-trip Pub→Sub tests for each transport can use:
- **UDP tests:** Two `dgram` sockets on loopback (`127.0.0.1`), no multicast group needed for unit tests. Use the real `224.0.0.114` address for integration tests.
- **MQTT tests:** `mqtt` broker can be a lightweight in-process broker or an external Mosquitto container (already supported via the `docker-compose.yml` pattern).
- **AMQP tests:** `rhea` can be tested in loopback mode (the library supports peer-to-peer without a broker via `container.listen()`). Add ActiveMQ or Apache Qpid for integration tests.

---

## Installation

```bash
# New direct runtime dependencies only — two packages
npm install mqtt@^5.15.1 rhea@^3.0.5

# No new dev dependencies required
# node-opcua-binary-stream, node-opcua-basic-types, node-opcua-variant,
# node-opcua-data-value, node-opcua-types are already in node_modules/
# as transitive deps of node-opcua@^2.115.0 (resolved 2.163.1)
```

**package.json additions:**
```json
"dependencies": {
  "mqtt": "^5.15.1",
  "rhea": "^3.0.5"
}
```

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| MQTT client | `mqtt@^5.15.1` | `async-mqtt` | `async-mqtt` is a thin wrapper over `mqtt` v4, not updated for v5, last published 2022 — effectively abandoned |
| MQTT client | `mqtt@^5.15.1` | `aedes` (broker) | `aedes` is a broker, not a client — wrong tool |
| AMQP transport | `rhea@^3.0.5` | `amqplib@^1.0.6` | **Spec non-conformant**: Part 14 normatively references AMQP 1.0 (ISO/IEC 19464); `amqplib` only implements AMQP 0-9-1 (RabbitMQ wire protocol). Different protocol. |
| AMQP transport | `rhea@^3.0.5` | `@azure/service-bus` | Azure SDK introduces cloud-specific dep, massive transitive graph, not generic AMQP 1.0 |
| UADP encoding | In-tree using transitive deps | `@sterfive/node-opcua-pubsub` | **License incompatible + unavailable**: commercial package under Sterfive EULA; not published on public npm registry (`npm view` returns 404); would change the suite's MIT licensing posture; violates PROJECT.md constraint |
| UADP encoding | In-tree using transitive deps | A new standalone UADP library | None exists in the npm ecosystem with MIT license and active maintenance as of 2026-05-08 |
| UDP multicast | `dgram` (built-in) | `multicast-dns`, `node-udp-multicast` | DNS-level abstraction or abandonware; `dgram` covers every OPC UA UADP requirement (join/leave/TTL/loopback) without adding a dep |
| JSON encoding | In-tree (`JSON.stringify` + custom type serializers) | `opcua-coders` / third-party | No suitable maintained MIT library exists; OPC UA JSON encoding is straightforward to implement using Part 6 §5.4 rules |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@sterfive/node-opcua-pubsub` | Commercial EULA; not on public npm registry (404); would void MIT licensing posture of the suite. PROJECT.md explicitly rules this out. | Implement UADP encoding in-tree using transitive `node-opcua-*` submodules |
| `amqplib` | Implements AMQP **0-9-1**, not AMQP 1.0. OPC UA Part 14 §2 normatively references AMQP 1.0 (ISO/IEC 19464:2014). Using 0-9-1 for Part 14 AMQP transport would be spec non-conformant. | `rhea` (AMQP 1.0, Apache-2.0) |
| `async-mqtt` | Last published 2022; thin wrapper around `mqtt` v4 that did not track v5 upgrade; deprecated in practice. | `mqtt@^5.15.1` directly |
| Any TypeScript-native PubSub library (e.g. `opcua-ts-*`) | Project constraint is CommonJS plain JS, no TypeScript, no transpiler. TypeScript-only packages ship `.d.ts` + require `tsc`; incompatible with build-less deploy model. | In-tree JS implementation |
| WebSocket/HTTP PubSub transports | Explicitly out of scope per PROJECT.md — Part 14 lists them as "future" | UDP-UADP, MQTT, AMQP only |
| DTLS for UDP security | Part 14 mentions DTLS 1.3 for UDP transport security; not in scope for v1 (SKS server is out of scope). | Plain UDP for v1; security layer is a future milestone |

---

## Stack Patterns by Transport

**UDP-UADP multicast (Publisher):**
- Use `dgram.createSocket({ type: 'udp4', reuseAddr: true })`
- `socket.bind(4840, () => { socket.setMulticastTTL(1); socket.setMulticastLoopback(true); })`
- `socket.send(uadpBuffer, 0, uadpBuffer.length, 4840, '224.0.0.114', cb)`
- Keep `MaxNetworkMessageSize` ≤ 1472 bytes to stay within single Ethernet frame; implement UADP chunking for larger messages
- Encoding: UADP binary via in-tree `lib/pubsub-uadp-codec.js`

**UDP-UADP multicast (Subscriber):**
- `socket.bind(4840, '0.0.0.0', () => { socket.addMembership('224.0.0.114', localIface); })`
- `socket.on('message', (msg, rinfo) => { /* decode UADP */ })`
- `socket.dropMembership()` + `socket.close()` on node stop
- Handle chunked messages: accumulate by `DataSetWriterId` + `MessageSequenceNumber`

**MQTT (Publisher, MQTT 5.0 preferred):**
- `mqtt.connect(brokerUrl, { protocolVersion: 5, ... })`
- Topic: `opcua/json/<PublisherId>/<WriterGroupName>` or `opcua/uadp/<PublisherId>/<WriterGroupName>` per Part 14 §7.3.4
- Publish with `properties: { contentType: 'application/json' }` (MQTT 5.0) or `properties: { contentType: 'application/opcua+uadp' }` for UADP
- Fall back to `protocolVersion: 4` (MQTT 3.1.1) if broker rejects v5; omit `contentType` header in that case

**MQTT (Subscriber):**
- `client.subscribe(topic, { qos: 1 })` — use QoS 1 (AtLeastOnce) as default per Part 14 §7.3.4 QoS mapping
- Detect encoding from `packet.properties.contentType` (MQTT 5.0) or topic path segment (`json` vs `uadp`) for 3.1.1
- Decode accordingly with `lib/pubsub-uadp-codec.js` or `lib/pubsub-json-decoder.js`

**AMQP 1.0 (Publisher):**
- `rhea.connect({ host, port: 5672, username, password })` for `amqp://` or TLS for `amqps://`
- `connection.open_sender(queueOrTopicAddress)`
- Message: `{ subject: 'ua-data', content_type: 'application/json', body: <Buffer|string> }` per Part 14 §B.3
- `subject: 'ua-metadata'` for DataSetMetaData messages

**AMQP 1.0 (Subscriber):**
- `connection.open_receiver(queueOrTopicAddress)`
- Handle `container.on('message', ...)` event
- Filter by `message.subject` (`'ua-data'` vs `'ua-metadata'`)
- Decode from `message.body` using content_type

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `mqtt@^5.15.1` | Node.js ≥16.0.0 | engines field confirmed; project requires Node.js ≥18 — fully compatible |
| `rhea@^3.0.5` | Node.js ≥18 (inferred) | No `engines` field in package.json but actively tested on current LTS; single dep (`debug@^4.3.3`) — minimal footprint |
| `node-opcua-binary-stream@2.162.0` (transitive) | node-opcua@2.163.1 | Already installed; do not add as direct dep — version must track node-opcua's resolved version |
| `node-opcua-basic-types@2.162.0` (transitive) | node-opcua@2.163.1 | Same as above |
| `node-opcua-types@*` (transitive) | node-opcua@2.163.1 | Same as above; exports UADP content mask enums which must stay in sync with node-opcua's type definitions |

**Important:** Do NOT add `node-opcua-binary-stream`, `node-opcua-basic-types`, `node-opcua-variant`, `node-opcua-data-value`, or `node-opcua-types` as direct dependencies. Pin them through `node-opcua@^2.115.0`. If added directly, npm may resolve a different version than the one node-opcua internally uses, causing type-identity mismatches (e.g. two `Variant` class instances that fail `instanceof` checks).

---

## UADP Binary Encoding Strategy — Explicit

**Approach: custom in-tree codec, no external library.**

Rationale:
1. No MIT-licensed standalone UADP codec exists on npm (verified 2026-05-08).
2. All required primitives are already installed as transitive deps and are verified to be directly `require()`-able from CommonJS without compilation.
3. The `node-opcua-types` transitive dep already exports `UadpNetworkMessageContentMask` and `UadpDataSetMessageContentMask` enums — the exact Part 14 bit-flag definitions, eliminating the need to define them from scratch.
4. Full control over conformance to Part 14 §7.2.4 without adapter shim overhead.

**Files to create:**
- `lib/pubsub-uadp-codec.js` — `encodeNetworkMessage(msg)` → Buffer, `decodeNetworkMessage(buf)` → msg object
- `lib/pubsub-json-codec.js` — `encodeNetworkMessage(msg)` → JSON string, `decodeNetworkMessage(str)` → msg object
- `lib/pubsub-chunk-assembler.js` — reassembly buffer for chunked UADP over UDP

**Primitive usage pattern (UADP encode example):**
```js
const { BinaryStream, BinaryStreamSizeCalculator } = require('node-opcua-binary-stream');
const { encodeUInt8, encodeUInt16, encodeUInt32, encodeNodeId, encodeDateTime } = require('node-opcua-basic-types');
const { encodeVariant } = require('node-opcua-variant');
const { encodeDataValue } = require('node-opcua-data-value');
const { UadpNetworkMessageContentMask } = require('node-opcua-types');

// 1. Pre-calculate size with BinaryStreamSizeCalculator to avoid over-allocation
// 2. Allocate Buffer of exact size
// 3. Encode with BinaryStream using matching encode* functions
```

---

## Sources

- npm registry (verified 2026-05-08): `mqtt@5.15.1` (MIT, published 2026-03-24), `rhea@3.0.5` (Apache-2.0, published 2026-04-28), `amqplib@1.0.6` (MIT, published 2026-05-06, AMQP 0-9-1 only)
- [OPC UA Part 14 §7.3 Transport Protocol Mappings](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.3) — confirmed UDP, MQTT, AMQP transports
- [OPC UA Part 14 §7.3.2.1 UDP General](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.3.2.1) — MTU 1472 bytes IPv4, port 4840, `opc.udp://` scheme
- [OPC UA Part 14 §7.3.2.2 UDP Multicast](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.3.2.2) — IGMP V3 / MLD V2 join/leave requirements
- [OPC UA Part 14 §7.3.4 MQTT](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.3.4) — MQTT 3.1.1 and 5.0 both supported; `contentType` header requires MQTT 5.0; topic pattern `<Prefix>/<Encoding>/<MsgType>/<PublisherId>/...`
- [OPC UA Part 14 §B.3 AMQP](https://reference.opcfoundation.org/Core/Part14/v105/docs/B.3) — AMQP 1.0, `subject: "ua-data"` / `"ua-metadata"`, `content_type: "application/json"` or `"application/opcua+uadp"`
- [OPC UA Part 14 §2 Normative References](https://reference.opcfoundation.org/Core/Part14/v104/docs/2) — ISO/IEC 19464:2014 (AMQP 1.0) is normative
- [OPC UA Part 14 §7.2.4.4.4 UADP Chunk NetworkMessage](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.2.4.4.4) — chunk header fields, reassembly algorithm
- [OPC UA Part 6 §5.4 JSON Encoding](https://reference.opcfoundation.org/Core/Part6/v105/docs/5.4) — NodeId, DateTime, ByteString, Variant JSON rules
- [Node.js v18 dgram documentation](https://nodejs.org/docs/latest-v18.x/api/dgram.html) — `addMembership`, `dropMembership`, `setMulticastTTL`, `setMulticastLoopback`, `setMulticastInterface` confirmed available on Node.js 18+
- [node-opcua/node-opcua GitHub issue #571](https://github.com/node-opcua/node-opcua/issues/571) — PubSub not implemented in open-source node-opcua; sponsor-funded feature, unresolved
- [Sterfive premium packages (awesome-node-opcua)](https://github.com/node-opcua/node-opcua/wiki/awesome-node-opcua) — `@sterfive/node-opcua-pubsub` listed as commercial; not on public npm registry (404 confirmed)
- [rhea GitHub](https://github.com/amqp/rhea) — AMQP 1.0, Apache-2.0, 3.0.5 published 2026-04-28
- [MQTT.js GitHub](https://github.com/mqttjs/MQTT.js/) — MIT, MQTT 5.0 since v3.0.0 (`protocolVersion: 5`), 5.15.1 published 2026-03-24
- Verified via `node -e "require('node-opcua-binary-stream')"` etc. — all transitive modules confirmed `require()`-able from CommonJS in the existing `node_modules/`

---

*Stack research for: OPC UA PubSub Part 14 — UDP-UADP multicast + MQTT + AMQP transports, UADP binary + JSON encodings*
*Researched: 2026-05-08*

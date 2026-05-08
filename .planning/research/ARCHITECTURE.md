# Architecture Research

**Domain:** OPC UA PubSub (Part 14) inside a Node-RED contrib package
**Researched:** 2026-05-08
**Confidence:** HIGH (OPC UA spec §5, §7 consulted directly; open62541 and UA-.NETStandard reference implementations cross-checked; existing codebase fully read)

---

## Standard Architecture

### System Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         Node-RED Layer (nodes/)                            │
│                                                                            │
│  ┌───────────────────────┐       ┌───────────────────────┐                │
│  │   opcua-publisher     │       │   opcua-subscriber    │                │
│  │  (Node-RED input node)│       │ (Node-RED output node)│                │
│  │  msg.payload → pub    │       │  sub → msg.payload    │                │
│  └──────────┬────────────┘       └──────────┬────────────┘                │
│             │ ref-counted                   │ ref-counted                  │
│  ┌──────────▼────────────────────────────────▼────────────┐                │
│  │           opcua-pubsub-connection config node          │                │
│  │  (one per transport endpoint; owns transport state)    │                │
│  └──────────┬────────────────────────────────┬────────────┘                │
└─────────────┼────────────────────────────────┼────────────────────────────┘
              │                                │
┌─────────────▼────────────────────────────────▼────────────────────────────┐
│                         PubSub Manager Layer (lib/)                        │
│                                                                            │
│  ┌────────────────────────┐       ┌────────────────────────┐              │
│  │  OpcUaPubSubPublisher  │       │  OpcUaPubSubSubscriber │              │
│  │  (lib/pubsub/          │       │  (lib/pubsub/          │              │
│  │   pubsub-publisher.js) │       │   pubsub-subscriber.js)│              │
│  │                        │       │                        │              │
│  │  ┌──────────────────┐  │       │  ┌──────────────────┐  │              │
│  │  │  WriterGroup     │  │       │  │  ReaderGroup     │  │              │
│  │  │  DataSetWriter   │  │       │  │  DataSetReader   │  │              │
│  │  │  PublishedDataSet│  │       │  │  DataSetMetaData │  │              │
│  │  └────────┬─────────┘  │       │  └────────┬─────────┘  │              │
│  └───────────┼────────────┘       └───────────┼────────────┘              │
│              │                                │                            │
│  ┌───────────▼────────────────────────────────▼────────────┐              │
│  │              NetworkMessage Encoder / Decoder            │              │
│  │   (lib/pubsub/encoders/uadp-encoder.js)                 │              │
│  │   (lib/pubsub/encoders/json-encoder.js)                 │              │
│  └───────────┬────────────────────────────────┬────────────┘              │
│              │                                │                            │
│  ┌───────────▼────────────────────────────────▼────────────┐              │
│  │               Transport Adapter Layer                    │              │
│  │   (lib/pubsub/transports/udp-transport.js)              │              │
│  │   (lib/pubsub/transports/mqtt-transport.js)             │              │
│  │   (lib/pubsub/transports/amqp-transport.js)             │              │
│  └─────────────────────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────────────────────┘
              │                                │
┌─────────────▼────────────────────────────────▼────────────────────────────┐
│                          Shared Utilities (lib/)                           │
│   lib/opcua-utils.js  ←  parseNodeId, serializeExtensionObject, etc.      │
│   (no changes; used as-is by PubSub field encoding)                        │
└────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Location |
|-----------|---------------|----------|
| `opcua-pubsub-connection` config node | Owns transport identity (URL, transport type, security config, cert paths); ref-counts transport lifetime; fans transport state events to worker nodes | `nodes/opcua-pubsub-connection.js` |
| `opcua-publisher` node | Receives Node-RED `msg`, maps `msg.payload` fields onto a `PublishedDataSet`, triggers `WriterGroup.publish()` | `nodes/opcua-publisher.js` |
| `opcua-subscriber` node | Registers a `DataSetReader` with the subscriber manager; emits a Node-RED `msg` per received `DataSetMessage` | `nodes/opcua-subscriber.js` |
| `OpcUaPubSubPublisher` | Owns `PublishedDataSet`, `WriterGroup`, one-or-more `DataSetWriter` configs; drives the publish timer; calls encoder then transport | `lib/pubsub/pubsub-publisher.js` |
| `OpcUaPubSubSubscriber` | Owns `ReaderGroup`, `DataSetReader` configs, `DataSetMetaData` cache; receives raw frames from transport; calls decoder then dispatches | `lib/pubsub/pubsub-subscriber.js` |
| `UadpEncoder` / `UadpDecoder` | Stateless encode/decode of `NetworkMessage` and `DataSetMessage` in UADP binary per Part 14 §7.2.4 | `lib/pubsub/encoders/uadp-encoder.js` |
| `JsonEncoder` / `JsonDecoder` | Stateless encode/decode in OPC UA JSON per Part 14 §7.2.5 | `lib/pubsub/encoders/json-encoder.js` |
| `UdpTransport` | Wraps Node.js `dgram` socket; supports unicast / multicast; scheme `opc.udp://`; UADP only | `lib/pubsub/transports/udp-transport.js` |
| `MqttTransport` | Wraps `mqtt` npm package; schemes `mqtt://`, `mqtts://`, `ws://`, `wss://`; UADP or JSON; QoS mapping per spec §7.3.4 | `lib/pubsub/transports/mqtt-transport.js` |
| `AmqpTransport` | Wraps `rhea` npm package (AMQP 1.0, not 0-9-1); scheme `amqps://`; content-type `application/opcua+uadp` or `application/json` | `lib/pubsub/transports/amqp-transport.js` |
| `lib/opcua-utils.js` | Shared NodeId/ExtensionObject helpers; no change required | existing file |

---

## Recommended Project Structure

```
lib/
├── opcua-client-manager.js   # existing — unchanged
├── opcua-utils.js            # existing — unchanged; shared with PubSub field encoding
└── pubsub/
    ├── pubsub-publisher.js   # OpcUaPubSubPublisher class (EventEmitter)
    ├── pubsub-subscriber.js  # OpcUaPubSubSubscriber class (EventEmitter)
    ├── dataset.js            # PublishedDataSet, DataSetWriter, WriterGroup,
    │                         #   ReaderGroup, DataSetReader, DataSetMetaData
    │                         #   pure config objects — no I/O
    ├── encoders/
    │   ├── uadp-encoder.js   # encode(networkMsg) → Buffer; decode(Buffer) → networkMsg
    │   └── json-encoder.js   # encode(networkMsg) → string; decode(string) → networkMsg
    └── transports/
        ├── base-transport.js # abstract interface: connect(), disconnect(), send(buf),
        │                     #   on('message', cb), on('error', cb), on('connected', cb)
        ├── udp-transport.js  # dgram socket, multicast join, MTU cap
        ├── mqtt-transport.js # mqtt npm client, topic pub/sub, QoS mapping
        └── amqp-transport.js # rhea AMQP 1.0 client, content-type header

nodes/
├── opcua-pubsub-connection.js   # config node — owns transport + ref-count
├── opcua-pubsub-connection.html # editor UI — transport type selector, broker URL,
│                                #   security, cert dropzones (reuse pattern from
│                                #   opcua-endpoint.html)
├── opcua-publisher.js           # worker node — input: msg.payload → publish
├── opcua-publisher.html         # editor UI
├── opcua-subscriber.js          # worker node — output: DataSetMessage → msg
└── opcua-subscriber.html        # editor UI

test/
├── pubsub-uadp-encode.test.js   # unit: encode/decode round-trip UADP
├── pubsub-json-encode.test.js   # unit: encode/decode round-trip JSON
├── pubsub-udp-transport.test.js # integration: loopback UDP publisher → subscriber
├── pubsub-mqtt-transport.test.js
├── pubsub-amqp-transport.test.js
└── pubsub-roundtrip.test.js     # end-to-end: opcua-publisher → opcua-subscriber
                                 #   per transport
```

### Structure Rationale

- **`lib/pubsub/` subtree:** All PubSub logic lives under its own directory. The existing `lib/opcua-client-manager.js` is session-based; mixing PubSub code into it would conflate two orthogonal models. A clean subtree enables independent test, lint, and eventual extraction as its own package.
- **`lib/pubsub/dataset.js` as pure config objects:** `PublishedDataSet`, `DataSetWriter`, `WriterGroup`, `DataSetReader`, `ReaderGroup`, `DataSetMetaData` are plain JS objects with no I/O. Keeping them separate from the manager makes unit-testing encoders trivial — you construct a config object, pass it to the encoder, inspect the Buffer.
- **`lib/pubsub/encoders/`:** Encoder modules are pure functions — `encode(networkMsg, opts) → Buffer` and `decode(Buffer, metaData) → networkMsg`. No state, no EventEmitter. This makes them independently unit-testable and swappable per `DataSetWriter.messageSettings.encoding`.
- **`lib/pubsub/transports/`:** The `base-transport.js` interface contract decouples the publisher/subscriber managers from transport specifics. The publisher calls `transport.send(buffer)` and the subscriber listens on `transport.on('message', ...)`. Swapping UDP for MQTT requires only swapping the transport instance.
- **Separate `opcua-pubsub-connection` config node (not extending `opcua-endpoint`):** `opcua-endpoint` is a session-bearing TCP connection. PubSub is session-less. The ref-count pattern is re-used but the underlying managed resource (a transport socket/client vs a TCP session) is different. Extending `opcua-endpoint` would entangle two unrelated lifecycles. (`PROJECT.md` Key Decisions confirms this.)
- **`nodes/opcua-publisher.html` cert dropzones:** Reuse the `setupCertUpload()` pattern from `opcua-endpoint.html`. CONCERNS.md notes the dropzone is duplicated — before PubSub adds a third copy, extract it to a shared static asset (e.g. `nodes/shared/cert-upload.js`) and import it in all three HTML files.

---

## Architectural Patterns

### Pattern 1: Transport Adapter (Strategy Pattern)

**What:** The publisher and subscriber managers hold a reference to an abstract `BaseTransport` instance. They call `transport.send(buffer)` (publisher) or listen to `transport.on('message', handler)` (subscriber). The concrete transport (UDP / MQTT / AMQP) is constructed by the `opcua-pubsub-connection` config node based on its `transportType` config field and injected into the manager.

**When to use:** Mandatory. Part 14 defines three transport protocol families with incompatible framing, addressing, and authentication. A single code path cannot serve all three without conditional branching that grows without bound.

**Trade-offs:** One more indirection layer (the interface) in exchange for clean separation. The interface is trivial (5 methods / events), so the cost is low.

**Example (CommonJS, no TypeScript):**
```js
// lib/pubsub/transports/base-transport.js
'use strict';
const EventEmitter = require('events');
class BaseTransport extends EventEmitter {
  // Must emit: 'connected', 'disconnected', 'message' (Buffer), 'error' (Error)
  async connect() { throw new Error('not implemented'); }
  async disconnect() { throw new Error('not implemented'); }
  async send(buffer) { throw new Error('not implemented'); }
}
module.exports = BaseTransport;

// lib/pubsub/transports/udp-transport.js
'use strict';
const dgram = require('dgram');
const BaseTransport = require('./base-transport');
class UdpTransport extends BaseTransport {
  constructor({ address, port, multicast, interfaceAddress }) { ... }
  async connect() {
    this._sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    if (this._multicast) this._sock.addMembership(this._address, this._interfaceAddress);
    this._sock.on('message', (buf) => this.emit('message', buf));
    this.emit('connected');
  }
  async send(buffer) { /* sock.send */ }
}
```

### Pattern 2: Stateless Encoder / Decoder Functions

**What:** `uadp-encoder.js` and `json-encoder.js` export pure functions. The encoder receives a plain `NetworkMessage` object (fields: `publisherId`, `writerGroupId`, `dataSetMessages[]`) plus an options object (content mask flags), and returns a `Buffer`. The decoder receives a `Buffer` plus optional `DataSetMetaData` (for field-name mapping), and returns a `NetworkMessage` object.

**When to use:** Always for encoding. Managers hold no encoding state; the same encoder is called from the Publisher manager's publish timer and can be independently tested in isolation.

**Trade-offs:** The UADP encoder must allocate `Buffer`s. For 50 ms intervals this is ~20 allocations/second — manageable, but prefer `Buffer.allocUnsafe` + explicit writes over string concatenation to avoid GC pressure at high rates. Use a pre-allocated scratch buffer for the header and only concatenate once per field payload.

**Example:**
```js
// lib/pubsub/encoders/uadp-encoder.js
'use strict';
function encode(networkMessage, opts = {}) {
  // opts: { publisherIdType, contentMask, groupContentMask, dataSetContentMask }
  const parts = [];
  parts.push(encodeNetworkMessageHeader(networkMessage, opts));
  for (const dsMsg of networkMessage.dataSetMessages) {
    parts.push(encodeDataSetMessage(dsMsg, opts));
  }
  return Buffer.concat(parts);
}
function decode(buffer, metaDataMap = {}) { ... }
module.exports = { encode, decode };
```

### Pattern 3: Periodic Publish Timer in the Manager (not the Node)

**What:** `OpcUaPubSubPublisher` owns a `setInterval` (or a `setImmediate` loop for sub-100ms intervals) keyed to `writerGroup.publishingInterval`. On each tick it collects the current field values from the registered `PublishedDataSet`, builds the `NetworkMessage` object, calls the encoder, calls `transport.send(buffer)`, then emits `publisher_sent` so the Node-RED node can update its status badge.

**When to use:** Required. The timer must live in the manager, not the `opcua-publisher` Node-RED node. A Node-RED `msg` arrives on-demand; PubSub publishing is time-driven. The Node-RED node configures the dataset and hands control to the manager; the manager drives the periodic send loop.

**Trade-offs:** The manager needs to sample data between publish ticks. For "push" mode (Node-RED `msg` triggers publish) the manager simply publishes on every `msg` arrival. For "timer" mode (the manager samples at `publishingInterval`) the manager needs a data cache that the Node-RED node writes to. Support both modes; select via a `publishMode: 'onInput' | 'timer'` config field.

### Pattern 4: DataSetMetaData Cache in the Subscriber Manager

**What:** `OpcUaPubSubSubscriber` maintains a `Map<writerGroupId+dataSetWriterId, DataSetMetaData>`. On each received `NetworkMessage`, it looks up the correct metadata by `DataSetWriterId`. If the `ConfigurationVersion` in the received `DataSetMessage` header does not match the cached metadata, it marks the reader as needing a metadata refresh. For v1 (static configuration), metadata is provided at construction time; dynamic refresh via UA metadata NetworkMessages is deferred.

**When to use:** Required for UADP binary decoding. The UADP binary format can encode field values as raw `Variant` or `DataValue` types. Without the field name list from `DataSetMetaData`, the decoder produces an ordered array of values with no names. The metadata cache maps the positional array into a named object — the form a Node-RED user expects in `msg.payload`.

**Trade-offs:** Static metadata at startup is sufficient for v1. It means the Subscriber config node must declare the same field list as the Publisher. This matches Node-RED's static-flow philosophy.

---

## Data Flow

### Publisher: msg arrival → wire

```
msg.payload arrives at opcua-publisher node
    │
    ▼
node validates msg, extracts field values
    │
    ▼
OpcUaPubSubPublisher.publish(fields)
    │  (if publishMode='onInput': immediate)
    │  (if publishMode='timer': write to data cache; timer loop below)
    ▼
PublishedDataSet.collectFields(fields)
    │  — applies field name mapping, DataType coercion via opcua-utils._createVariant
    ▼
DataSetWriter.buildDataSetMessage(dataset)
    │  — sets DataSetWriterId, sequenceNumber, configurationVersion, timestamp
    │  — applies DataSetFieldContentMask (DataValue / Variant / RawData)
    ▼
WriterGroup.buildNetworkMessage(dataSetMessages[])
    │  — sets PublisherId, WriterGroupId, NetworkMessageNumber, GroupVersion
    │  — applies NetworkMessageContentMask
    ▼
encoder.encode(networkMessage, opts)  ← uadp-encoder.js OR json-encoder.js
    │  — returns Buffer (UADP) or string→Buffer (JSON)
    ▼
transport.send(buffer)  ← UdpTransport / MqttTransport / AmqpTransport
    │  — UDP: sock.send to multicast/unicast address
    │  — MQTT: client.publish(topic, buffer, { qos })
    │  — AMQP: sender.send({ body: buffer, content_type: 'application/opcua+uadp' })
    ▼
OpcUaPubSubPublisher emits 'publisher_sent' → opcua-publisher node.status update
```

### Subscriber: wire → msg output

```
transport.on('message', buffer)  ← UdpTransport / MqttTransport / AmqpTransport
    │
    ▼
OpcUaPubSubSubscriber._onRawMessage(buffer)
    │
    ▼
decoder.decodeNetworkMessageHeader(buffer)
    │  — reads UADPFlags / ExtendedFlags1 / ExtendedFlags2 / PublisherId
    │  — fast path: PublisherId filter (discard if not in ReaderGroup.publisherIds)
    ▼
decoder.decodeDataSetMessages(buffer, dataSetCount)
    │  — for each: read DataSetWriterId from PayloadHeader, look up DataSetReader
    │  — retrieve DataSetMetaData from cache by DataSetWriterId + GroupId
    │  — decode field values using metadata field list
    ▼
DataSetReader.onDataSetMessage(dataSet)
    │  — applies SubscribedDataSet field name mapping
    │  — sets msg.dataSetWriterId, msg.writerGroupId, msg.sequenceNumber,
    │    msg.publisherId, msg.configurationVersion, msg.timestamp
    ▼
OpcUaPubSubSubscriber emits 'dataSet' event
    │
    ▼
opcua-subscriber node.on('dataSet', ds)
    │  — builds msg: { payload: ds.fields, topic: ds.dataSetName, ... }
    ▼
node.send(msg)  → downstream Node-RED flow
```

### Key Data Structures

```
NetworkMessage {
  publisherId: string | number,
  writerGroupId: number,
  networkMessageNumber: number,
  sequenceNumber: number,          // optional (GroupHeader)
  timestamp: Date,                 // optional (ExtendedFlags1)
  dataSetMessages: DataSetMessage[]
}

DataSetMessage {
  dataSetWriterId: number,
  sequenceNumber: number,
  configurationVersion: { majorVersion, minorVersion },
  timestamp: Date,
  status: number,
  fields: [{ name: string, value: Variant, statusCode?, sourceTimestamp? }]
}

DataSetMetaData {
  name: string,
  fields: [{ name, dataType, valueRank, description }],
  configurationVersion: { majorVersion, minorVersion }
}
```

---

## Integration with Existing Code

### What PubSub Shares (and Why)

| Shared Item | Where It Lives | Why Shared |
|-------------|---------------|------------|
| `parseNodeId()`, `nodeIdToString()` | `lib/opcua-utils.js` | Field definitions in `PublishedDataSet` reference OPC UA NodeIds; same parsing applies |
| `serializeExtensionObject()` | `lib/opcua-utils.js` | `DataSetMessage` fields can be ExtensionObjects; same serialization to JSON |
| `_createVariant()` logic | Inline in `lib/pubsub/dataset.js` | DataType coercion for `DataSetMessage` field values; copy the pure logic, do NOT import the manager method (it has session context) |
| Cert upload HTTP API | `nodes/opcua-endpoint.js` endpoints | PubSub security uses the same `opcua-certs/` directory; reuse `GET/POST/DELETE /opcua-endpoint/upload-cert(s)`. No new routes needed for PubSub cert management in v1 |
| Cert dropzone JS | `nodes/opcua-endpoint.html setupCertUpload()` | Extract to `nodes/shared/cert-upload.js` static asset; import in `opcua-pubsub-connection.html` and `opcua-endpoint.html`. CONCERNS.md flags this duplication |
| `registerStatusCallback` / `unregisterStatusCallback` pattern | `nodes/opcua-endpoint.js` | Identical fan-out pattern; re-implement in `opcua-pubsub-connection.js` with PubSub-specific event names (`publisher_started`, `subscriber_connected`, `transport_error`) |
| Node-RED config node ref-count pattern | `nodes/opcua-endpoint.js` | `getSharedManager()` / `releaseSharedManager()` / `_refCount` pattern is correct; reproduce in `opcua-pubsub-connection.js` with `getPublisher()` / `getSubscriber()` / `releasePublisher()` / `releaseSubscriber()` |

### What PubSub Does NOT Share (and Why)

| Item | Why Not Shared |
|------|----------------|
| `OpcUaClientManager` | All operations go through `this.session`; PubSub has no session. Importing the manager from PubSub would pull in dead session-management code and create confusing API surface |
| `getSharedManager()` ref-counting on `opcua-endpoint` | PubSub transport state is independent of the OPC UA session. A PubSub publisher should be runnable without any `opcua-endpoint` node in the flow |
| `isConnectionLostError()` string matcher | The error phrases are node-opcua `OPCUAClient` messages. Transport error semantics are different per transport (MQTT `disconnect`, AMQP `connection.close`, UDP `ECONNRESET`). Each transport adapter defines its own error classifier |
| `forceReconnect()` / `scheduleReconnect()` | PubSub reconnect is simpler for broker transports (MQTT and AMQP both have built-in reconnect in their client libraries). UDP is connectionless, so there is nothing to reconnect. The manager calls `transport.connect()` on `transport.on('disconnected')` with backoff, but without the two-layer duplication that CONCERNS.md flags as a debt item |
| `subscriptions: Map`, `ClientMonitoredItem` | OPC UA monitored items are session-bound; `DataSetReader`s are transport-bound. No shared structure makes sense |

---

## Build Order

The build order is driven by three dependency axes:

1. **Encoding before transport** — a transport `send()` call requires a `Buffer`; you cannot test a transport without a working encoder that produces a valid frame.
2. **UADP before JSON** — UADP is mandatory for UDP; UDP is the simplest transport (no broker to run, no auth). Start with UADP + UDP to get a working end-to-end path as fast as possible. JSON + MQTT comes second as it is the most demanded user scenario (Industrie 4.0 MQTT stack). JSON + AMQP comes last as AMQP is the most complex broker (AMQP 1.0, content-type headers, chunking).
3. **Publisher before Subscriber** — the encoder is simpler than the decoder (encode is a known-structure serializer; decode must handle optional fields, bitmask parsing, version mismatch). A Publisher end-to-end run gives you a valid wire frame to feed into Subscriber decode tests.

```
Phase 1 — Foundation (pure logic, no I/O, fully unit-testable in isolation)
  1a. lib/pubsub/dataset.js
       PublishedDataSet, DataSetWriter, WriterGroup config objects
       DataSetMetaData, DataSetReader, ReaderGroup config objects
       Reason: all subsequent layers depend on these shapes

  1b. lib/pubsub/encoders/uadp-encoder.js
       NetworkMessage header encode/decode
       DataSetMessage header encode/decode
       DataSetField values (DataValue, Variant, RawData modes)
       Reason: UDP transport requires UADP; encoder is pure Buffer math,
               zero I/O, trivially unit-testable

  1c. lib/pubsub/encoders/json-encoder.js
       JSON NetworkMessage / DataSetMessage per Part 14 §7.2.5
       Reason: MQTT/AMQP users expect JSON; can be built in parallel with
               UDP transport work if resources allow

Phase 2 — Transport Layer (I/O, requires integration test infrastructure)
  2a. lib/pubsub/transports/base-transport.js (interface only, 20 lines)
  2b. lib/pubsub/transports/udp-transport.js
       dgram socket, multicast addMembership, MTU cap at MaxNetworkMessageSize
       Reason: simplest transport — no broker, no auth, no TLS;
               loopback test (127.0.0.1 unicast) needs no external service

  2c. lib/pubsub/transports/mqtt-transport.js
       mqtt npm client, QoS0/1/2 mapping, MetaData topic ($Metadata suffix)
       Reason: most-demanded user scenario; requires a local broker
               (Mosquitto in Docker test helper)

  2d. lib/pubsub/transports/amqp-transport.js
       rhea AMQP 1.0 client (NOT amqplib which is AMQP 0-9-1)
       content-type header: application/opcua+uadp or application/json
       Reason: most complex; requires RabbitMQ or ActiveMQ in test environment

Phase 3 — Manager Layer (wires encoder + transport, owns timers)
  3a. lib/pubsub/pubsub-publisher.js
       OpcUaPubSubPublisher extends EventEmitter
       publish(fields) method, publishMode='onInput'|'timer'
       owns setInterval for timer mode
       emits: publisher_started, publisher_sent, publisher_error, publisher_stopped

  3b. lib/pubsub/pubsub-subscriber.js
       OpcUaPubSubSubscriber extends EventEmitter
       DataSetMetaData cache, DataSetWriterId dispatch table
       emits: subscriber_connected, dataSet, subscriber_error, subscriber_disconnected

Phase 4 — Node-RED Integration Layer
  4a. nodes/opcua-pubsub-connection.js + .html
       Config node: transport type select, URL, port, security mode
       getPublisher(config) / getSubscriber(config) / release* with ref-count
       registerStatusCallback / unregisterStatusCallback

  4b. nodes/opcua-publisher.js + .html
       Input node: msg.payload → publisher.publish(fields)
       DataSet field mapping config (field name → msg.payload key)

  4c. nodes/opcua-subscriber.js + .html
       Output node: subscriber 'dataSet' event → node.send(msg)
       DataSetReader config (filter by PublisherId, WriterGroupId, DataSetWriterId)

Phase 5 — Tests and Examples
  5a. Unit tests: uadp-encode, json-encode (no I/O)
  5b. Integration tests: udp loopback, mqtt loopback, amqp loopback
  5c. Round-trip tests: opcua-publisher → opcua-subscriber per transport
  5d. Example flows: 10-PubSub-UDP-UADP.json, 11-PubSub-MQTT-JSON.json
```

**Why this order avoids rework:**
- Encoder shapes drive `DataSetMessage` field layout. Writing the manager before the encoder forces backtracking once the exact byte layout of optional fields is understood.
- UADP encoder surfaces UADP spec ambiguities (optional header fields, bitmask layout) before transport code is written, not after. UDP transport tests then serve as UADP encoder integration tests.
- Manager written after transports means the manager's `send` path is tested against a real transport loopback — no extra mocking needed.
- Config node written last means its API exactly matches what the managers need — no forward-guessing of API surface.

---

## Anti-Patterns

### Anti-Pattern 1: Merging PubSub into OpcUaClientManager

**What people do:** Add `pubsub` methods to the existing `OpcUaClientManager` class to "reuse" the connection infrastructure.

**Why it's wrong:** `OpcUaClientManager` is built around `this.session` — every method assumes a live `ClientSession`. Adding session-less PubSub paths creates a class that does two unrelated things. The existing CONCERNS.md debt (reconnect split, subscription in consumer, client internals exposed) is already stressing that class. Adding PubSub code amplifies each concern.

**Do this instead:** A sibling manager in `lib/pubsub/` that shares only the pure utilities from `lib/opcua-utils.js`.

### Anti-Pattern 2: Implementing a Transport Base Class with Node-RED node-level lifecycle

**What people do:** Put `connect()` / `disconnect()` directly in the Node-RED `on('input')` and `on('close')` handlers, bypassing the config node ref-count.

**Why it's wrong:** When two `opcua-publisher` nodes share the same `opcua-pubsub-connection`, each would open its own UDP socket or MQTT client to the same broker. The ref-count pattern in the config node prevents this — but only if the transport lifecycle is managed there.

**Do this instead:** Config node owns one transport instance, ref-counted. Worker nodes call `getPublisher()` / `releasePublisher()`.

### Anti-Pattern 3: Re-implementing Reconnect Logic in Node-Level Code

**What people do:** Copy the `forceReconnect()` / `isConnectionLostError()` pattern from `opcua-client.js` into `opcua-subscriber.js`.

**Why it's wrong:** CONCERNS.md §Tech Debt item 1 documents exactly this problem for the existing nodes. PubSub would become the third copy. For MQTT and AMQP, the client libraries (mqtt, rhea) handle reconnect internally; wrapping a working reconnect in another reconnect creates competing state machines.

**Do this instead:** For broker transports, enable the library's own reconnect option (`mqtt({ reconnectPeriod: 2000 })`, `rhea reconnectLimit`). For UDP (connectionless), reconnect is not applicable. The manager listens to `transport.on('disconnected')` and emits `subscriber_disconnected`; the Node-RED node updates its status badge. No retry loop needed at the manager level for UDP.

### Anti-Pattern 4: Encoding the DataSetMessage Inside the Transport Adapter

**What people do:** Put JSON serialization inside `mqtt-transport.js` because "MQTT carries JSON anyway."

**Why it's wrong:** Transport adapters become encoding-aware, breaking the separation that allows UADP over MQTT. The transport should receive a `Buffer` and transmit it. The manager selects the encoder based on `DataSetWriter.messageSettings.encoding`; the transport is encoding-agnostic.

**Do this instead:** Manager → encoder → `Buffer` → transport. Transport always receives and returns `Buffer`.

### Anti-Pattern 5: One config node per transport type

**What people do:** Create three separate config node types: `opcua-pubsub-udp`, `opcua-pubsub-mqtt`, `opcua-pubsub-amqp`.

**Why it's wrong:** A Publisher and Subscriber for the same logical connection must share a transport instance. Three config node types means users must ensure they use the right type on both sides and creates three registration paths in `package.json`. It also triples the HTML editor UI surface.

**Do this instead:** One `opcua-pubsub-connection` config node with a `transportType` dropdown (UDP / MQTT / AMQP). The config node instantiates the correct `BaseTransport` subclass at deploy time. Publisher and Subscriber nodes reference the same config node.

---

## Integration Points

### External Services

| Service | Transport | Node.js Library | Notes |
|---------|-----------|----------------|-------|
| UDP multicast / unicast | `opc.udp://` | `dgram` (built-in) | No extra dep; default port 4840; UADP only per spec §7.3.1 |
| MQTT broker | `mqtt://`, `mqtts://`, `ws://` | `mqtt` npm (~70 KB) | QoS0→AtMostOnce, QoS1→AtLeastOnce, QoS2→ExactlyOnce; UADP or JSON; MetaData topic = `<topic>/$Metadata` with RETAIN |
| AMQP 1.0 broker | `amqps://` | `rhea` npm | Must be AMQP 1.0 (not 0-9-1); `amqplib` is 0-9-1 and is the wrong library; content-type header differentiates UADP from JSON |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|--------------|-------|
| `opcua-publisher` node ↔ `OpcUaPubSubPublisher` | Direct method call `publisher.publish(fields)` | Config node creates and ref-counts the publisher; node retrieves it via `connection.getPublisher(config)` |
| `OpcUaPubSubSubscriber` ↔ `opcua-subscriber` node | EventEmitter `'dataSet'` event | Subscriber manager emits; node listens and calls `node.send(msg)` |
| `OpcUaPubSubPublisher` ↔ encoder | Direct sync call `encoder.encode(nm, opts)` | No async; Buffer returned synchronously |
| `OpcUaPubSubSubscriber` ↔ decoder | Direct sync call `decoder.decode(buffer, metaDataMap)` | No async |
| Encoder ↔ transport | Buffer handoff — manager calls `transport.send(buffer)` | Encoding-agnostic transport |
| `opcua-pubsub-connection` ↔ `lib/opcua-utils.js` | `require('../../opcua-utils')` | parseNodeId used when resolving field NodeIds at config time |
| `opcua-pubsub-connection` cert management ↔ `opcua-endpoint` cert routes | Shared HTTP endpoints `POST/GET/DELETE /opcua-endpoint/upload-cert(s)` | No new routes; PubSub security keys uploaded via same UI |

### Connection Config Node vs Endpoint Config Node

```
opcua-endpoint (existing)              opcua-pubsub-connection (new)
─────────────────────────────          ─────────────────────────────
Owns: OpcUaClientManager               Owns: BaseTransport instance
      TCP socket + Session                     (UdpTransport | MqttTransport
      Certificate paths                         | AmqpTransport)
Ref-count: TCP session                 Ref-count: transport socket/client
Security: OPC UA SecureChannel         Security: TLS (MQTT/AMQP) or none (UDP)
Certs: client + user certs             Certs: signing/encryption keys (SKS, v2+)
Reconnect: scheduleReconnect()         Reconnect: delegated to transport library
                                                  (MQTT built-in, UDP: none)
```

The two config nodes are deliberately independent. A flow can use both (classic OPC UA client reading values and republishing them via PubSub) without the endpoint needing to know about PubSub.

---

## Scaling Considerations

| Scale | Architecture Impact |
|-------|-------------------|
| 1 WriterGroup, 50 ms interval | In-tree UADP encoder is sufficient; pre-allocated Buffer scratch avoids GC at 20 msg/s |
| 5 WriterGroups, mixed intervals | Each WriterGroup owns its own `setInterval`; no cross-group serialization needed |
| 50 ms with large DataSets (>1460 bytes) | UADP chunk support (Part 14 §7.2.2.2.4) required; chunked message reassembly in subscriber needed before scaling this path |
| MQTT + high-frequency (50 ms) | `mqtt` npm client buffers; QoS 0 is fire-and-forget, appropriate for real-time data. QoS 1/2 at 50 ms will saturate PUBACK round-trips — use QoS 0 for sub-100 ms intervals |
| Multiple subscriber nodes on same topic | Transport receives once; subscriber manager dispatches to multiple registered `DataSetReader`s — single socket, multiple consumers, no problem |

### Scaling Priorities

1. **First bottleneck:** UADP encoder memory allocation at high frequency. Fix: pre-allocate a reusable scratch `Buffer` in the encoder for the header section; only allocate for variable-length payload.
2. **Second bottleneck:** MQTT broker round-trip latency at QoS 1+. Fix: use QoS 0 for time-critical data; document the constraint.

---

## Sources

- [OPC UA Part 14 PubSub §5 Concepts](https://reference.opcfoundation.org/Core/Part14/v105/docs/5) — component model, data flow, Publisher/Subscriber roles [HIGH confidence]
- [OPC UA Part 14 §7.2.4 UADP Message Mapping](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.2.4) — UADP byte structure, UADPFlags, ExtendedFlags1/2, DataSetMessage header [HIGH confidence]
- [OPC UA Part 14 §7.3 Transport Protocol Mappings](https://reference.opcfoundation.org/Core/Part14/v104/docs/7.3) — UDP, MQTT, AMQP framing, URL schemes, content-type headers [HIGH confidence]
- [UA-.NETStandard PubSub.md](https://github.com/OPCFoundation/UA-.NETStandard/blob/master/Docs/PubSub.md) — reference implementation class model (UAPubSubApplication, PubSubConnection, UadpNetworkMessage, JsonNetworkMessage) [HIGH confidence]
- [open62541 PubSub documentation](https://open62541.org/doc/master/pubsub.html) — C reference implementation component hierarchy confirming component boundary design [MEDIUM confidence — C not JS, but component model is spec-driven]
- [node-opcua PubSub episode 1](https://node-opcua.github.io/concepts/2022/02/16/node-opcua-pubsub-episode1.html) — confirms PubSub in node-opcua is commercial (Sterfive EULA); in-tree implementation is correct approach [HIGH confidence]
- [Prosys OPC UA PubSub Explained](https://prosysopc.com/blog/opc-ua-pubsub-explained/) — transport pattern, Publisher/Subscriber decoupling [MEDIUM confidence]
- [amqplib documentation](https://amqp-node.github.io/amqplib/) — confirmed AMQP 0-9-1 library; NOT suitable for OPC UA AMQP transport (which requires AMQP 1.0) [HIGH confidence]
- [rhea GitHub](https://github.com/amqp/rhea) — confirmed AMQP 1.0 reactive messaging library; correct choice for Part 14 AMQP transport [HIGH confidence]

---
*Architecture research for: OPC UA PubSub (Part 14) in node-red-contrib-opcua-suite*
*Researched: 2026-05-08*

---
phase: 04-publisher-subscriber-tests-examples
created: 2026-06-13
source: orchestrator-authored (gsd-sdk tooling unavailable); interface reference in 04-RESEARCH.md
---

# Phase 4 Context — Publisher, Subscriber, Tests, Examples

Locks the cross-cutting contract so the four plans (publisher, subscriber, round-trip
tests, examples+docs) stay consistent. Every plan MUST honor these decisions; the full
exact API signatures of Phase 2/3 modules they call are in `04-RESEARCH.md`.

## Scope

Build the two user-facing worker nodes that make PubSub usable end-to-end, then prove
the loop with tests and ship examples + docs. Requirements: PUB-01, PUB-02, PUB-03,
SUB-01, SUB-02, STAT-01, TEST-01, TEST-02, TEST-03, DOC-01, DOC-02.

## Locked Decisions

### D4-01 — Node names and registration
Two new nodes: `opcua-publisher` (`nodes/opcua-publisher.js` + `.html`) and
`opcua-subscriber` (`nodes/opcua-subscriber.js` + `.html`), category `function`.
Register both in `package.json` `node-red.nodes` (keys `opcua-publisher`,
`opcua-subscriber`) — insert right after `opcua-pubsub-connection`.

### D4-02 — Connection reference
Both nodes have a `connection` config property pointing at an `opcua-pubsub-connection`
node, resolved via `RED.nodes.getNode(config.connection)`. If absent → red ring status
`"no connection"` and return early (mirror `opcua-event.js` lines 18-22). Both acquire
the shared transport with `connection.acquireTransport()` and pair every acquire with
`connection.releaseTransport()` on node `close`.

### D4-03 — Encoding selection (UDP=UADP only; MQTT=UADP or JSON)
Encoding is an explicit `messageEncoding` property on BOTH publisher and subscriber:
values `"uadp"` | `"json"`. Default derives from the connection's `transportType`
(udp → `uadp`). Hard rule: when the connection is UDP, `messageEncoding` MUST be `uadp`
— reject `json` with a `node.error()` + red status at startup (UDP-JSON is not a shipped
v1 combination). MQTT allows either. The three shipped combinations are UDP-UADP,
MQTT-UADP, MQTT-JSON (no UDP-JSON). Encoder module is chosen at runtime:
`messageEncoding === "json" ? require("../lib/json-encoder") : require("../lib/uadp-encoder")`.

### D4-04 — Publisher configuration hierarchy (editor → config objects)
The publisher editor declares exactly one WriterGroup with one or more DataSetWriters,
each bound to one PublishedDataSet. At node construct time the publisher builds frozen
config objects via the Phase 2 factories (`WriterGroup`, `DataSetWriter`,
`PublishedDataSet` from `lib/pubsub-config.js`) and surfaces any thrown validation error
as `node.error(err.message)` + red status. The PublishedDataSet `fields[]` (each
`{ name, dataType }`) is the authority for typing outgoing field values.

### D4-05 — Publisher input contract (PUB-03, acyclic)
On `input`, `msg.payload` is an object keyed by field name: `{ <fieldName>: <rawValue> }`.
The publisher maps each declared PublishedDataSet field to a Variant
`{ dataType: <field.dataType>, value: msg.payload[field.name] }`, assembles ONE
DataSetMessage (`messageType: "keyframe"`, incrementing `sequenceNumber`) per DataSetWriter,
wraps them in ONE NetworkMessage (publisherId from connection, groupHeader.writerGroupId
from the WriterGroup, payloadHeader.dataSetWriterIds from the writers), encodes via the
selected encoder, and calls `transport.send(payload)`. Missing fields in `msg.payload`
→ that field is omitted from the frame (do not fabricate). One inbound msg → one outbound
NetworkMessage.

### D4-06 — Publisher cyclic mode (PUB-02)
A `publishMode` property: `"acyclic"` (default, msg-driven per D4-05) or `"cyclic"`.
In cyclic mode a single `setInterval` per WriterGroup fires every
`writerGroup.publishingInterval` ms, publishing the most-recently-received field values
(seeded by inbound `msg.payload` updates, or empty until first msg). When NO field value
changed since the previous tick, send a KeepAlive NetworkMessage (a DataSetMessage with
`messageType: "keepalive"`, no field payload) instead of a keyframe. The interval is
created on first connect and MUST be cleared in `node.on("close")` (Pitfall: leaked
timers across redeploy). `sequenceNumber` increments on every emitted NetworkMessage
(keyframe AND keepalive).

### D4-07 — Subscriber message reception (SUB-01)
The subscriber registers its OWN listener on the acquired transport:
`transport.on("message", handler)`. On `close` it MUST
`transport.removeListener("message", handler)` BEFORE `releaseTransport()` so the
shared, ref-counted transport does not accumulate dead listeners across redeploys.
Decode with the selected encoder's `decodeNetworkMessage(bufferOrString)`. For UDP the
payload is a `Buffer`; for MQTT-JSON it is a `Buffer` that must be `.toString()`-ed before
JSON decode (handler normalizes). Decode errors are caught and surfaced as
`node.error()` — the listener never throws out (keep the shared transport alive).

### D4-08 — Subscriber filter + ConfigurationVersion (SUB-02)
The subscriber builds a `DataSetReader` (Phase 2 factory) from editor fields
(`publisherId` / `writerGroupId` / `dataSetWriterId`, at least one required). For each
decoded DataSetMessage it applies the filter (a set filter field that does not match →
silently skip that message; this is normal filtering, NOT an error). On a match where the
decoded `configurationVersion` does NOT equal the reader's expected version (when the
reader declares one), surface a VISIBLE `node.error()` ("ConfigurationVersion mismatch:
expected M.m, got X.y") — the message is dropped from output but NEVER silently swallowed.

### D4-09 — Subscriber output msg shape (SUB-02, exact)
Per matched DataSetMessage emit one `msg`:
```
msg.payload          // { <fieldName>: <decodedValue> }  — field map, values unwrapped from Variant
msg.publisherId      // from the NetworkMessage
msg.writerGroupId    // from groupHeader
msg.dataSetWriterId  // from the DataSetMessage / payloadHeader
msg.sequenceNumber   // from groupHeader (or DataSetMessage sequenceNumber)
msg.timestamp        // Date, from the message timestamp if present, else receive time
msg.statusCode       // from the DataSetMessage status (default 0 / Good)
msg.encoding         // "uadp" | "json"
msg.transport        // "udp" | "mqtt"
msg.topic            // MQTT only: the source topic from message metadata; omit for UDP
```
Field values in `msg.payload` are unwrapped to raw scalars (the Variant/DataValue wrapper
is removed; for DataValue encoding, `value.value` is used and `statusCode`/timestamps are
carried up where present).

### D4-10 — Status indicators (STAT-01)
Both nodes register a status callback via
`connection.registerStatusCallback(cb)` and unregister on close. Mapping:
- `connected` → green dot, text `"connected"`
- active work → green ring: publisher `"publishing"`, subscriber `"subscribed"`
- `disconnected` → yellow ring `"disconnected"`
- `error` → red ring `"error"` (+ short reason)
Initial status before connect: blue dot `"idle"`.

### D4-11 — MQTT round-trip test broker (TEST-01)
Phase 3 unit tests mocked `mqtt`. For Phase 4 round-trip tests we need a REAL loopback.
Use `aedes` (in-process MQTT broker) as a `devDependency`, started on an ephemeral
loopback port per test and torn down in `afterEach`. UDP round-trip uses real `dgram`
loopback multicast (as Phase 3 already proved). Every round-trip test builds the
publisher + subscriber with the project's OWN hand-rolled `createRED()` mock pattern
(see `test/opcua-nodes.test.js`) — `node-red-node-test-helper` is NOT a project
dependency and must NOT be introduced. Wire both nodes to a REAL `opcua-pubsub-connection`
node instance (or a thin stub whose `acquireTransport()` returns a REAL UdpTransport/
MqttTransport), publish a known DataSet, and assert the subscriber's `node.send` stub
received a msg with identical fields, types, and sequence numbers. Cover all three:
UDP-UADP, MQTT-UADP, MQTT-JSON.

### D4-12 — TEST-02 redeploy acceptance
A Mocha test driving a direct construct/close cycle (via the hand-rolled `createRED()`
mock, firing each node's registered `close` handler) of connection + publisher +
subscriber, 20 rapid iterations, asserting no `EADDRINUSE`, no unhandled errors, and no
leaked sockets/timers.
This is the config-node-level companion to Phase 3's transport-level EADDRINUSE test.

### D4-13 — TEST-03 open62541 reference upgrade = documented MANUAL step
The 8-combination flag-cascade vectors in `test/fixtures/uadp-vectors.js` are already
hand-derived and verified against encoder output (Phase 2). Upgrading their provenance to
captured open62541 v1.4.x output requires a live open62541 publisher via Docker —
infrastructure not available to an automated executor. Phase 4 satisfies TEST-03 by:
(a) confirming the existing 8-combo matrix tests pass, and (b) shipping/【verifying the
`test-server/capture-open62541-vectors.js` capture script + a documented manual procedure
in the README/DOCKER notes. The byte-for-byte open62541 swap is a tracked human-action
follow-up, NOT an automated gate. Do NOT fake captured vectors.

### D4-14 — Example flows (DOC-01) and README (DOC-02)
Ship three example flows in `examples/`:
- `10 - PubSub UDP-UADP Loopback.json`
- `11 - PubSub MQTT-UADP.json`
- `12 - PubSub MQTT-JSON.json`
Each must import cleanly into Node-RED and deploy without errors (validated by the
existing `test/run-examples.js` harness pattern — extend it to cover the new flows).
Add a README PubSub section documenting the configuration hierarchy (Connection →
WriterGroup → DataSetWriter → PublishedDataSet on the publisher; Connection → DataSetReader
on the subscriber), the full `msg` shape from D4-09, the UDP-only-UADP rule (D4-03), and
the UDP NIC-selection caveat (multicastInterface).

## Wave Plan

- **Wave 1** (parallel, independent files): 04-01 opcua-publisher, 04-02 opcua-subscriber
- **Wave 2** (depends on 04-01 + 04-02): 04-03 round-trip + redeploy tests (TEST-01/02/03)
- **Wave 3** (depends on working nodes): 04-04 examples + README (DOC-01/02)

## Constraints carried from Phase 1-3

- Commits authored under `blanpa` only — NO Co-Authored-By / AI attribution.
- `gsd-sdk` / `gsd-tools query` are unavailable — use plain `git`; do not call them.
- `npm test` glob is now quoted (commit 35e6087) — new test files under any `test/`
  subdir are auto-discovered. Keep the existing "use strict" + double-quote + 2-space style.
- Existing baseline after Phase 3: **504 passing / 8 pending**. New tests add on top; zero
  regressions allowed.

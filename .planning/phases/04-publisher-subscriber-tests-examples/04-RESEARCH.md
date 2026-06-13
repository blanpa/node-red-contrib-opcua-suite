---
phase: 04-publisher-subscriber-tests-examples
created: 2026-06-13
source: live codebase read of Phase 2/3 modules
---

# Phase 4 Research — Exact API Reference for Worker Nodes

Exact public signatures the publisher/subscriber call. Verify against source before use;
line numbers are as of 2026-06-13.

## lib/pubsub-config.js
```js
module.exports = {
  validateWriterGroup, WriterGroup,
  validateDataSetWriter, DataSetWriter,
  validatePublishedDataSet, PublishedDataSet,
  validateDataSetReader, DataSetReader,
};
```
Each `Xxx(cfg)` factory returns a **frozen** object or throws `createError` (err.code,
err.errors=Issue[]). Each `validateXxx(cfg)` returns `{ valid, errors:[{path,code,message}] }`.

- **WriterGroup(cfg)** → `{ publishingInterval (req,>0), keepAliveTime (def=publishingInterval), maxNetworkMessageSize (def 1400), priority (def 128, 0-255), writerGroupId (req, 1..65535) }`. Throws if keepAliveTime < publishingInterval.
- **PublishedDataSet(cfg)** → `{ name (req), fields:[{ name(req), dataType(req e.g. "Double"/"String"/"Int32"), valueRank?, maxStringLength? }] (req,non-empty), configurationVersion:{major,minor} (def {1,0}) }`.
- **DataSetWriter(cfg)** → `{ dataSetWriterId (req,1..65535), dataSetName?, keyFrameCount (def 1), dataSetFieldContentMask (def 0=Variant; 0x20=RawData), publishedDataSet? (req if RawData) }`.
- **DataSetReader(cfg)** → `{ publisherId?, writerGroupId?, dataSetWriterId?, keepAliveTime?, messageReceiveTimeout (def max(3*keepAliveTime,5000)), dataSetFieldContentMask (def 0) }`. Requires ≥1 of publisherId/writerGroupId/dataSetWriterId.

## lib/uadp-encoder.js
```js
module.exports = { encodeNetworkMessage, decodeNetworkMessage, encodeDataSetMessage, decodeDataSetMessage };
```
- **encodeNetworkMessage(nm, opts?={mtu})** → `Buffer | Buffer[]` (array when > mtu, default 1400). `transport.send()` accepts both.
- **decodeNetworkMessage(buffer, opts?)** → NetworkMessage model; throws createError on malformed. When chunk-typed, `nm.chunk` populated and `nm.payload=[]` (reassembly is the UDP transport's job — already done in Phase 3).

**NetworkMessage model** (encode input / decode output):
```js
{
  publisherId?: string|number|bigint,
  dataSetClassId?: string,                 // GUID
  groupHeader?: { writerGroupId, groupVersion, networkMessageNumber, sequenceNumber },
  payloadHeader?: { dataSetWriterIds: number[] },
  timestamp?: Date, picoseconds?: number,
  payload: DataSetMessage[],
}
```
Flag bytes (UADPFlags/ExtendedFlags1/2) are NEVER model fields — derived from presence.

**DataSetMessage model** (encodeDataSetMessage input):
```js
{
  dataSetWriterId?, fieldEncoding?="variant"("variant"|"rawdata"|"datavalue"),
  messageType?="keyframe"("keyframe"|"deltaframe"|"keepalive"|"event"),
  valid?=true, sequenceNumber?, status?,
  configurationVersion?:{major,minor}, timestamp?:Date, picoseconds?,
  fields: { [name]: Variant|DataValue|RawValue },
}
```
Field value shapes:
- variant: `{ dataType:string|number, value:any }`
- datavalue: `{ value:{dataType,value}, statusCode?, sourceTimestamp?, serverTimestamp?, ... }`
- rawdata: `{ dataType, value }` (decode needs external metadata; throws UADP_RAWDATA_DECODE_REQUIRES_METADATA)

## lib/json-encoder.js
```js
module.exports = { encodeNetworkMessage, decodeNetworkMessage };
```
- **encodeNetworkMessage(nm, opts?)** → JSON **string** (Part 14 §7.2.5, fixed field order: MessageId, MessageType="ua-data", PublisherId, …, Messages[]).
- **decodeNetworkMessage(jsonString, opts?)** → NetworkMessage model; throws createError {code,path,message}. Requires MessageId, MessageType==="ua-data", Messages[]. Each Message: DataSetWriterId, SequenceNumber, MetaDataVersion{MajorVersion,MinorVersion}, Timestamp(ISO), Status, MessageType("ua-keyframe"|...), Payload{ field:{UaType,Value} }.

NOTE: JSON decode takes a **string** — subscriber must `.toString()` the incoming Buffer for MQTT-JSON.

## lib/transports/base-transport.js
```js
module.exports = { BaseTransport };   // extends EventEmitter
```
- `async connect()` / `async close()` (idempotent) / `send(payload:Buffer|Buffer[], opts?)` (sync throw on error).
- Events: `connected`, `disconnected`, `reconnecting` (MQTT only), `error(err)`, `message(buffer, metadata?)`, `warn(err)`.
- MQTT `message` metadata includes `{ topic, packet }` (per 03-03). UDP `message` emits `(buffer, {rinfo?})`.

## nodes/opcua-pubsub-connection.js (config node — public API)
Resolved by `RED.nodes.getNode(config.connection)`. Methods:
- `acquireTransport()` → `BaseTransport` (lazy-creates+connects; cancels grace timer; ref-counts).
- `releaseTransport()` → void (decrements; 500ms grace timer at 0).
- `registerStatusCallback(cb)` → void. `cb(status:"connected"|"disconnected"|"reconnecting"|"error", err?)`.
- `unregisterStatusCallback(cb)` → void.
Properties: `publisherId`, `publisherIdType` ("String"|"UInt16"|"UInt32"|"UInt64"), `transportType` ("udp"|"mqtt"), UDP: `multicastGroup`,`multicastInterface`,`port`,`mtu`; MQTT: `brokerUrl`,`topicPrefix`,`qos`.

IMPORTANT: the connection fans out STATUS events only. **Incoming data is NOT re-emitted by the connection** — the subscriber must `transport.on("message", handler)` on the transport returned by `acquireTransport()`, and `transport.removeListener("message", handler)` before `releaseTransport()` on close (shared ref-counted transport; multiple subscribers each add their own listener).

## Node-RED worker node skeleton (from opcua-item.js / opcua-event.js)
```js
module.exports = function (RED) {
  function NodeCtor(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const conn = RED.nodes.getNode(config.connection);
    if (!conn) { node.status({fill:"red",shape:"ring",text:"no connection"}); return; }
    node.status({fill:"blue",shape:"dot",text:"idle"});
    node.on("input", function (msg, send, done) {
      try { /* ... */ send(msg); done(); }
      catch (e) { node.error(e.message, msg); done(e); }
    });
    node.on("close", function (removed, done) { /* cleanup */ done(); });
  }
  RED.nodes.registerType("opcua-xxx", NodeCtor);
};
```
node.status shapes: green dot=connected, green ring=active, yellow ring=connecting/disconnected, red ring=error.

## package.json node-red.nodes (current)
opcua-client, opcua-server, opcua-item, opcua-endpoint, opcua-pubsub-connection, opcua-event, opcua-method, opcua-browser, opcua-browse-client. → Add `opcua-publisher`, `opcua-subscriber` after opcua-pubsub-connection.

## TEST-03 status
`test/fixtures/uadp-vectors.js` has all 8 ExtendedFlags1/2 combinations, "hand-derived from Part 14 §7.2.4 Table 75, verified against encoder output." `test/uadp-encoder.test.js` (~lines 567-656) asserts the cascade matrix + hex round-trips. `test-server/capture-open62541-vectors.js` exists (manual capture, not run by npm test). OUTSTANDING: byte-for-byte swap to captured open62541 v1.4.x output (needs live Docker publisher) — see D4-13 (manual follow-up, not automated gate).

## Test infra available
- The project does NOT use `node-red-node-test-helper` (not a dependency — do NOT add it). Node tests use a hand-rolled `createRED()` mock in `test/opcua-nodes.test.js` (RED.nodes.createNode stubs node.on/status/log/warn/error via sinon; registerType captures the ctor; getNode returns overrides). Read that file (lines 1-60) and reuse the pattern for publisher/subscriber tests.
- `test/run-examples.js` — existing harness that loads example flow JSON and validates importability; extend for flows 10-12.
- Example flows are plain JSON arrays of node objects (`{id,type,...props}`) plus a `tab` node — see `examples/04 - Subscribe to Changes.json`. No live runtime needed to validate import.
- MQTT round-trip broker: add `aedes` devDependency (D4-11). UDP round-trip uses real dgram loopback.

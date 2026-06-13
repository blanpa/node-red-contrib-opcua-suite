---
phase: 04-publisher-subscriber-tests-examples
plan: 01
subsystem: api
tags: [opcua, pubsub, publisher, node-red, uadp, json, networkmessage, writergroup]

# Dependency graph
requires:
  - phase: 02 (pubsub config + encoders)
    provides: WriterGroup/DataSetWriter/PublishedDataSet factories (lib/pubsub-config.js); uadp-encoder + json-encoder encodeNetworkMessage
  - phase: 03 (transports + connection node)
    provides: opcua-pubsub-connection config node (acquireTransport/releaseTransport/registerStatusCallback/transportType/publisherId)
provides:
  - opcua-publisher worker node (acyclic msg-driven + cyclic interval-with-KeepAlive publishing)
  - frozen publisher editor config schema consumed by Plans 04-03 (round-trip tests) and 04-04 (example flows + README)
  - emitted NetworkMessage + DataSetMessage (keyframe/keepalive) shape that the subscriber decodes in 04-03
affects: [04-02 opcua-subscriber, 04-03 round-trip tests, 04-04 example flows + README]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Worker node references a opcua-pubsub-connection config node, acquires the shared ref-counted transport, registers a status callback, releases + unregisters on close"
    - "Config objects built at construct time through Phase 2 validating factories; any throw → node.error + red status with NO transport acquired"
    - "NetworkMessage assembled as a plain model (testable) separate from encode/send; encoder selected at runtime by messageEncoding"

key-files:
  created:
    - nodes/opcua-publisher.js
    - nodes/opcua-publisher.html
    - test/opcua-publisher.test.js
  modified:
    - package.json

key-decisions:
  - "messageEncoding defaults to uadp for both transports; JSON must be chosen explicitly and is rejected over UDP at startup (D4-03)"
  - "Cyclic interval logic was implemented in the Task 1 commit (clean GREEN) rather than added in Task 2; Task 2 added only tests + the editor HTML"
  - "DataSetWriters are edited as a JSON-array textarea in the editor (full hierarchy editable); oneditsave validates via JSON.parse before storing"

patterns-established:
  - "Pattern: per-writer dsmSeq + single nmSeq incremented on every emitted NetworkMessage including keepalive (D4-06 sequence rule)"
  - "Pattern: missing payload fields are omitted from the frame, never fabricated (D4-05)"

requirements-completed: [PUB-01, PUB-02, PUB-03, STAT-01]

# Metrics
duration: 4min
completed: 2026-06-13
---

# Phase 4 Plan 01: OPC UA Publisher Node Summary

**opcua-publisher worker node — builds WriterGroup/DataSetWriter/PublishedDataSet config via the Phase 2 factories, assembles UADP/JSON NetworkMessages, and publishes them over the shared PubSub transport in both acyclic (msg-driven) and cyclic (interval + KeepAlive) modes with status fan-in.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-06-13T11:37:34Z
- **Completed:** 2026-06-13T11:41:04Z
- **Tasks:** 2 (TDD)
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments
- `nodes/opcua-publisher.js`: connection ref + guard, encoder selection with UDP-JSON reject, factory-built frozen config, acyclic publish, cyclic mode with KeepAlive, status mapping, transport acquire/release + status (un)register on close.
- `nodes/opcua-publisher.html`: editor with connection picker, encoding/publishMode selects, WriterGroup fields, DataSetWriters JSON editor, help panel.
- `test/opcua-publisher.test.js`: 20 Mocha tests using the project's hand-rolled `createRED()` mock (no node-red-node-test-helper).
- `package.json`: registered `opcua-publisher` immediately after `opcua-pubsub-connection`.

## Task Commits

1. **Task 1 (RED): failing tests** - `899beff` (test)
2. **Task 1 (GREEN): publisher node + package.json** - `6764791` (feat)
3. **Task 2: cyclic tests + editor HTML** - `5f10014` (feat)

## FINAL editor config property schema (frozen contract — confirms `<interfaces>`)

The HTML `defaults` block as written (these EXACT names are what Plans 04-03 and 04-04 must set):

| Property | Type / default | Role |
|----------|----------------|------|
| `name` | String `""` | node label |
| `connection` | id of `opcua-pubsub-connection`, required | config node ref (PUB-01) |
| `messageEncoding` | `"uadp"` \| `"json"`, default `"uadp"` | encoder select (D4-03) |
| `publishMode` | `"acyclic"` \| `"cyclic"`, default `"acyclic"` | mode toggle (D4-06) |
| `publishingInterval` | Number ms, default `1000`, required | WriterGroup.publishingInterval + cyclic interval period |
| `keepAliveTime` | Number ms, default `""` (→ publishingInterval in factory) | WriterGroup.keepAliveTime |
| `writerGroupId` | Number 1..65535, default `1`, required | WriterGroup.writerGroupId + groupHeader.writerGroupId |
| `priority` | Number 0..255, default `128` | WriterGroup.priority |
| `maxNetworkMessageSize` | Number, default `1400` | encoder opts.mtu |
| `writers` | JSON string → `Array<{ dataSetWriterId, dataSetName, publishedDataSet:{ name, fields:[{name,dataType}], configurationVersion? } }>` | DataSetWriters |

Default `writers` value (single writer, field `value:Double`):
`[{"dataSetWriterId":1,"dataSetName":"DataSet1","publishedDataSet":{"name":"DataSet1","fields":[{"name":"value","dataType":"Double"}]}}]`

## Emitted NetworkMessage + DataSetMessage shape

Per emitted frame (per inbound msg in acyclic; per tick in cyclic):

```js
{
  publisherId: conn.publisherId,                 // String from the connection
  groupHeader: { writerGroupId, sequenceNumber },// sequenceNumber++ on EVERY frame (keyframe AND keepalive)
  payloadHeader: { dataSetWriterIds: [...] },    // one entry per DataSetWriter
  timestamp: new Date(),
  payload: [ /* one DataSetMessage per DataSetWriter */ ]
}
```

Keyframe DataSetMessage (acyclic, or cyclic-with-change):
```js
{
  dataSetWriterId, messageType: "keyframe", sequenceNumber, // per-writer increment
  configurationVersion: { major, minor },
  fields: { [name]: { dataType, value } }   // only fields PRESENT in source values; missing omitted
}
```

KeepAlive DataSetMessage (cyclic, no change since last tick):
```js
{ dataSetWriterId, messageType: "keepalive", sequenceNumber, fields: {} }
```

Encoding: `messageEncoding === "json" ? json-encoder.encodeNetworkMessage(nm) (→ String) : uadp-encoder.encodeNetworkMessage(nm, { mtu: maxNetworkMessageSize }) (→ Buffer|Buffer[])`, then `transport.send(encoded)`.

## Decisions Made
- Cyclic interval logic placed in the Task 1 implementation commit so Task 1's GREEN run is clean and the node is whole; Task 2 contributes the cyclic *tests* and the editor HTML. This is not a deviation from the plan's behavioral contract — both tasks' behaviors and tests are present and pass.

## Deviations from Plan
None - plan executed exactly as written (D4-05 omit-not-fabricate and D4-06 keepalive/sequence behaviors implemented and verified verbatim).

## Issues Encountered
None. Encoders accepted the exact NetworkMessage model on first integration (smoke-tested before implementation).

## Test count
- New publisher tests: **20** (12 Task 1 + 8 Task 2).
- Full suite: **524 passing / 8 pending** = baseline 504 + 20, zero regressions.

## Next Phase Readiness
- Publisher node + frozen config schema + NetworkMessage shape are ready for Plan 04-02 (subscriber) and Plan 04-03 (round-trip tests will publish via this node and assert identical decoded fields/types/sequence numbers).
- No external setup required.

## TDD Gate Compliance
RED (`899beff` test) → GREEN (`6764791` feat) gate sequence present for Task 1. Task 2 added tests alongside the editor HTML (cyclic runtime behavior already shipped in the Task 1 feat commit); all gates green.

## Self-Check: PASSED
- nodes/opcua-publisher.js — FOUND
- nodes/opcua-publisher.html — FOUND
- test/opcua-publisher.test.js — FOUND
- package.json opcua-publisher registration — FOUND (after opcua-pubsub-connection)
- Commits 899beff, 6764791, 5f10014 — FOUND in git log

---
*Phase: 04-publisher-subscriber-tests-examples*
*Completed: 2026-06-13*

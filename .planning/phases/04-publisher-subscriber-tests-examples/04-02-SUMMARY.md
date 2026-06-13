---
phase: 04-publisher-subscriber-tests-examples
plan: 02
subsystem: api
tags: [opcua, pubsub, subscriber, node-red, uadp, json, networkmessage, datasetreader]

# Dependency graph
requires:
  - phase: 02 (pubsub config + encoders)
    provides: DataSetReader factory (lib/pubsub-config.js); uadp-encoder + json-encoder decodeNetworkMessage
  - phase: 03 (transports + connection node)
    provides: opcua-pubsub-connection config node (acquireTransport/releaseTransport/registerStatusCallback/transportType/publisherId); transport "message" event
  - phase: 04 plan 01 (publisher)
    provides: sibling worker-node skeleton + the NetworkMessage/DataSetMessage shape decoded here
provides:
  - opcua-subscriber worker node (DataSetReader filter, own transport message listener, decode + unwrap, D4-09 msg emit, status mapping)
  - frozen subscriber editor config schema + emitted msg shape consumed by Plans 04-03 (round-trip tests) and 04-04 (example flows + README)
affects: [04-03 round-trip + redeploy tests, 04-04 example flows + README]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Receive-only worker node (inputs:0): registers its OWN transport.on('message') listener on the shared ref-counted transport; removeListener BEFORE releaseTransport on close (D4-07)"
    - "Decoder selected at construct time by messageEncoding; MQTT-JSON Buffer is .toString()-ed before json decode, UADP Buffer passed as-is"
    - "Decode errors caught inside the listener and surfaced via node.error — the EventEmitter callback never throws out (keeps shared transport + siblings alive)"
    - "Per-DataSetMessage: silent filter skip (normal) is code-distinct from visible ConfigurationVersion mismatch node.error (dropped but logged)"

key-files:
  created:
    - nodes/opcua-subscriber.js
    - nodes/opcua-subscriber.html
    - test/opcua-subscriber.test.js
  modified:
    - package.json

key-decisions:
  - "dataSetWriterId is derived per-DataSetMessage as dsm.dataSetWriterId ?? nm.payloadHeader.dataSetWriterIds[index] — the UADP decoder carries the id in payloadHeader only, the JSON decoder carries it on the DataSetMessage (verified by real round-trip)"
  - "sequenceNumber prefers nm.groupHeader.sequenceNumber, falls back to dsm.sequenceNumber — JSON-encoded NetworkMessages have no groupHeader so the dsm value is used"
  - "writerGroupId filter only matches UADP (JSON encoding carries no groupHeader/writerGroupId); MQTT-JSON subscribers should filter on publisherId/dataSetWriterId"

patterns-established:
  - "Pattern: unwrap(w) handles both DataValue { value:{dataType,value} } and Variant { dataType, value } wrappers, returning the raw scalar"

requirements-completed: [SUB-01, SUB-02, STAT-01]

# Metrics
duration: 4min
completed: 2026-06-13
---

# Phase 4 Plan 02: OPC UA Subscriber Node Summary

**opcua-subscriber worker node — declares one DataSetReader filter, registers its own listener on the shared PubSub transport, decodes each UADP/JSON NetworkMessage, filters + ConfigurationVersion-checks every DataSetMessage, and emits one unwrapped msg per match in the exact D4-09 shape, with status fan-in and leak-free listener cleanup across redeploys.**

## Performance
- **Duration:** ~4 min
- **Tasks:** 2 (Task 1 TDD)
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments
- `nodes/opcua-subscriber.js`: connection ref + guard, encoding select with UDP-JSON reject, DataSetReader filter build, own `transport.on("message")` listener, decode (UADP buffer / MQTT-JSON Buffer→string), per-DataSetMessage filter + ConfigurationVersion check, scalar field unwrap, D4-09 msg emit, status mapping, decode-error tolerance, `removeListener` before `releaseTransport` on close.
- `nodes/opcua-subscriber.html`: connection picker, messageEncoding dropdown (oneditprepare forces UADP for UDP), three DataSetReader filter inputs + optional expectedConfigVersion, help panel documenting the D4-09 msg shape; `inputs:0 / outputs:1`.
- `test/opcua-subscriber.test.js`: 19 Mocha tests (13 runtime + 6 editor/registration) using the project's hand-rolled `createRED()` mock + a fake `EventEmitter` transport and stub connection; runtime tests use the REAL encoders to build genuine round-trip buffers.
- `package.json`: registered `opcua-subscriber` immediately after `opcua-publisher` (which follows `opcua-pubsub-connection`).

## Task Commits
1. **Task 1 (RED): failing tests** — `804837f` (test)
2. **Task 1 (GREEN): subscriber node + package.json** — `e50d13a` (feat)
3. **Task 2: editor HTML** — `657caa8` (feat)

## FINAL subscriber editor config property schema (frozen contract — confirms `<interfaces>`)

The HTML `defaults` block as written (these EXACT names are what Plans 04-03 and 04-04 must set):

| Property | Type / default | Role |
|----------|----------------|------|
| `name` | String `""` | node label |
| `connection` | id of `opcua-pubsub-connection`, required | config node ref (SUB-01/D4-02) |
| `messageEncoding` | `"uadp"` \| `"json"`, default `"uadp"` | decoder select (D4-03) |
| `publisherId` | String `""` | DataSetReader filter (optional, string\|number) |
| `writerGroupId` | String `""` → Number | DataSetReader filter (optional) |
| `dataSetWriterId` | String `""` → Number | DataSetReader filter (optional) |
| `expectedConfigVersion` | String `""` ("M.m") | optional ConfigurationVersion check (D4-08) |

At least one of `publisherId` / `writerGroupId` / `dataSetWriterId` MUST be set (DataSetReader throws `FILTER_REQUIRED` otherwise → node.error + red "invalid reader" status, no transport acquired).

## Emitted msg shape (as implemented — confirms D4-09 EXACT)

Per matched DataSetMessage, one `node.send(msg)`:

```js
{
  payload:         { [fieldName]: <decodedScalar> },  // Variant/DataValue wrapper removed
  publisherId:     nm.publisherId,
  writerGroupId:   nm.groupHeader && nm.groupHeader.writerGroupId,   // undefined for JSON encoding
  dataSetWriterId: dsm.dataSetWriterId ?? nm.payloadHeader.dataSetWriterIds[index],
  sequenceNumber:  nm.groupHeader.sequenceNumber ?? dsm.sequenceNumber,
  timestamp:       dsm.timestamp || nm.timestamp || new Date(),   // Date
  statusCode:      dsm.status ?? 0,    // 0 = Good
  encoding:        "uadp" | "json",
  transport:       "udp" | "mqtt",
  topic:           metadata.topic      // MQTT only; key OMITTED entirely for UDP
}
```

## Field-unwrap rule (D4-09)

`unwrap(w)`:
- DataValue wrapper `{ value: { dataType, value } }` → returns `value.value`
- Variant wrapper `{ dataType, value }` → returns `value`
- otherwise returns `w` unchanged

The current encoders emit Variant-form fields (`{ dataType, value }`), so `payload[name]` is the raw scalar (e.g. `{ Temp: 21.5 }`).

## Decoder output field names consumed (verified against real round-trip)

- **UADP** `decodeNetworkMessage(Buffer)` → NetworkMessage with `publisherId`, `groupHeader.{writerGroupId,sequenceNumber}`, `payloadHeader.dataSetWriterIds[]`, and `payload[]` DataSetMessages carrying `sequenceNumber`, `status`, `configurationVersion.{major,minor}`, `fields{ [name]:{dataType,value} }`. **The UADP DataSetMessage does NOT carry its own `dataSetWriterId`** — it is read positionally from `payloadHeader.dataSetWriterIds[index]`.
- **JSON** `decodeNetworkMessage(String)` → NetworkMessage with `publisherId` and `payload[]` DataSetMessages carrying `dataSetWriterId`, `sequenceNumber`, `configurationVersion`, `status`, `fields`. **There is NO `groupHeader`** — `writerGroupId` is `undefined` and `sequenceNumber` falls back to the dsm value.

This is the one decoder-shape nuance Plans 04-03/04-04 must respect: filter MQTT-JSON subscribers on `publisherId` or `dataSetWriterId`, not `writerGroupId`.

## package.json insertion position
`"opcua-subscriber": "nodes/opcua-subscriber.js"` inserted immediately after `"opcua-publisher"` (itself after `"opcua-pubsub-connection"`). No existing entries reordered or removed; file remains valid JSON.

## Deviations from Plan
None - plan executed exactly as written. The two clarifications above (dataSetWriterId positional fallback for UADP; writerGroupId/sequenceNumber fallback for JSON) are not behavioral deviations — they implement the `<interfaces>` `??` fallbacks the plan already specified (`sequenceNumber: nmSeq !== undefined ? nmSeq : dsm.sequenceNumber`) and were verified against real encoder output before implementation.

## Issues Encountered
None. The real-encoder round-trip in the tests confirmed the decoded shapes on first integration.

## Test count
- New subscriber tests: **19** (13 Task 1 runtime + 6 Task 2 editor/registration).
- Full suite: **543 passing / 8 pending** = baseline 524 + 19, zero regressions.

## Next Phase Readiness
- Subscriber node + frozen config schema + emitted msg shape are ready for Plan 04-03 (round-trip: publisher emits → subscriber decodes → assert identical fields/types/sequence) and the D4-12 redeploy test (the 20-cycle no-leak property is already proven at unit level here).
- No external setup required.

## TDD Gate Compliance
RED (`804837f` test) → GREEN (`e50d13a` feat) gate sequence present for Task 1. Task 2 added the editor HTML; its file-content tests were authored in the RED commit and passed once the HTML + package.json registration landed. All gates green.

## Self-Check: PASSED
- nodes/opcua-subscriber.js — FOUND
- nodes/opcua-subscriber.html — FOUND
- test/opcua-subscriber.test.js — FOUND
- package.json opcua-subscriber registration — FOUND (after opcua-publisher / opcua-pubsub-connection)
- Commits 804837f, e50d13a, 657caa8 — FOUND in git log

---
*Phase: 04-publisher-subscriber-tests-examples*
*Completed: 2026-06-13*

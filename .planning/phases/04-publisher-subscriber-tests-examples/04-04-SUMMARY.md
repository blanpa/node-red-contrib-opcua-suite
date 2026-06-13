---
phase: 04-publisher-subscriber-tests-examples
plan: 04
subsystem: docs
tags: [opcua, pubsub, examples, node-red, readme, uadp, json, mqtt, udp, documentation]

# Dependency graph
requires:
  - phase: 04 plan 01 (publisher)
    provides: opcua-publisher node + frozen editor config schema (connection, messageEncoding, publishMode, publishingInterval, writerGroupId, priority, maxNetworkMessageSize, writers)
  - phase: 04 plan 02 (subscriber)
    provides: opcua-subscriber node + frozen editor config schema (connection, messageEncoding, publisherId, writerGroupId, dataSetWriterId, expectedConfigVersion) + D4-09 msg shape
  - phase: 03 (connection node)
    provides: opcua-pubsub-connection config node defaults (transportType, multicastGroup, multicastInterface, port, mtu, brokerUrl, topicPrefix, qos, publisherIdType, publisherId, cert placeholders)
provides:
  - three importable PubSub example flows (UDP-UADP loopback, MQTT-UADP, MQTT-JSON)
  - npm-test-discoverable static validation suite for all bundled example flows
  - PubSub-aware live run-examples.js runner
  - README OPC UA PubSub documentation section (DOC-02)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Example flows: config node (opcua-pubsub-connection) has no z/x/y; worker/inject/debug/comment nodes carry z=<tabId>, x/y, wires"
    - "Static flow validation runs under npm test with no Node-RED runtime: parse + tab + unique-id + referential integrity, table-driven PubSub transport/encoding assertions"

key-files:
  created:
    - "examples/10 - PubSub UDP-UADP Loopback.json"
    - "examples/11 - PubSub MQTT-UADP.json"
    - "examples/12 - PubSub MQTT-JSON.json"
    - test/example-flows.test.js
  modified:
    - test/run-examples.js
    - README.md

key-decisions:
  - "Reconciled the plan's <interfaces> publisher sketch (separate WriterGroup/DataSetWriter/PublishedDataSet objects) against the SHIPPED opcua-publisher defaults: the real node uses FLAT WriterGroup fields (publishingInterval, keepAliveTime, writerGroupId, priority, maxNetworkMessageSize) plus a single `writers` JSON-string property holding the DataSetWriters array. The example flows use the real flat keys."
  - "Flow 12 (MQTT-JSON) subscriber filters on publisherId + dataSetWriterId and leaves writerGroupId empty: JSON NetworkMessages have no groupHeader so writerGroupId is undefined (per 04-02/04-03)."
  - "Static suite written in the project's chai-expect Mocha style (not node assert) to match existing test files; auto-discovered by the package.json mocha glob with no package.json change."

requirements-completed: [DOC-01, DOC-02]

# Metrics
duration: ~10min
completed: 2026-06-13
---

# Phase 4 Plan 04: PubSub Example Flows + README Documentation Summary

**Shipped the PubSub discoverability layer: three importable example flows (self-contained UDP-UADP loopback, MQTT-UADP, MQTT-JSON), a 65-test npm-discoverable static validation suite covering every bundled flow, a PubSub-aware live runner, and a README OPC UA PubSub section documenting both config hierarchies, the SUB-02 msg shape, the UDP-only-UADP rule, and the multicast NIC caveat.**

## Accomplishments

- **examples/10 - PubSub UDP-UADP Loopback.json** — self-contained loopback: one `opcua-pubsub-connection` (udp, multicast `239.0.0.1:4840`) shared by publisher + subscriber, inject → publisher, subscriber → debug. Runs with zero external infrastructure.
- **examples/11 - PubSub MQTT-UADP.json** — `transportType:"mqtt"`, `brokerUrl:"mqtt://localhost:1883"`, both worker nodes `messageEncoding:"uadp"`. Tab info documents the broker prerequisite.
- **examples/12 - PubSub MQTT-JSON.json** — MQTT with both worker nodes `messageEncoding:"json"`; subscriber filters on `publisherId`/`dataSetWriterId` (no `writerGroupId`).
- **test/example-flows.test.js** — 65 static assertions (no Node-RED, no network) over all 12 flows.
- **test/run-examples.js** — records per-example `transports`, prints a dim broker note for MQTT flows, documents the no-op endpoint patch for PubSub flows; flows 01-09 unchanged.
- **README.md** — new `## OPC UA PubSub` section + Examples list entries 9-12.

## Task Commits

1. **Task 1 — three PubSub example flows** — `d61b8bc` (feat)
2. **Task 2 — static validation suite + PubSub-aware runner** — `30f8419` (test)
3. **Task 3 — README PubSub section + examples list** — `3b274f1` (docs)

## Node-id scheme and property keys per flow

Stable file-prefixed ids: `ex10-conn / ex10-tab / ex10-comment / ex10-inject / ex10-pub / ex10-sub / ex10-debug` (and `ex11-*`, `ex12-*`). Ids are unique across all bundled examples.

**opcua-pubsub-connection** (shipped defaults, nodes/opcua-pubsub-connection.html): `name, transportType, multicastGroup, multicastInterface, port, mtu, brokerUrl, topicPrefix, qos, publisherIdType, publisherId, certificateFile, privateKeyFile, caCertificateFile`. Flow 10 `transportType:"udp"`; flows 11/12 `transportType:"mqtt"`, `brokerUrl:"mqtt://localhost:1883"`. Distinct fixed UUID `publisherId` per flow (`10000000-…-010`, `11000000-…-011`, `12000000-…-012`).

**opcua-publisher** (shipped defaults, nodes/opcua-publisher.html): `name, connection, messageEncoding, publishMode, publishingInterval, keepAliveTime, writerGroupId, priority, maxNetworkMessageSize, writers`. The `writers` value is a JSON STRING: `[{"dataSetWriterId":1,"dataSetName":"DemoDataSet","publishedDataSet":{"name":"DemoDataSet","fields":[{"name":"Temperature","dataType":"Double"},{"name":"Label","dataType":"String"}]}}]`. `publishMode:"acyclic"`, `publishingInterval:1000`, `writerGroupId:1`. Encoding `uadp` (10/11), `json` (12).

**opcua-subscriber** (shipped defaults, nodes/opcua-subscriber.html): `name, connection, messageEncoding, publisherId, writerGroupId, dataSetWriterId, expectedConfigVersion`. Flows 10/11 filter on `writerGroupId:1` + `dataSetWriterId:1` + `publisherId`; flow 12 filters on `publisherId` + `dataSetWriterId:1` with `writerGroupId:""`.

### RECONCILIATION (derived plan names vs shipped node defaults)

The plan's `<interfaces>` sketched the publisher as nested `WriterGroup`/`DataSetWriter`/`PublishedDataSet` config keys. The SHIPPED `opcua-publisher` editor `defaults` instead expose **flat** WriterGroup fields (`publishingInterval`, `keepAliveTime`, `writerGroupId`, `priority`, `maxNetworkMessageSize`) plus a single `writers` JSON-string property containing the DataSetWriters array (each `{ dataSetWriterId, dataSetName, publishedDataSet:{ name, fields:[{name,dataType}] } }`). The example flows use the shipped flat keys — confirmed against nodes/opcua-publisher.html and the 04-01/04-03 summaries. No invented keys.

## test/example-flows.test.js structure

For **every** `examples/*.json` (all 12): parses as a JSON array; exactly one `tab` with a non-empty `label`; every node has a string `type` and a unique `id`; every `connection`/`endpoint` ref and every `wires[][]` target resolves to an id in the same file. A guard asserts ≥12 flows and the presence of every `01 - … 12 -` prefix. A global assertion enforces D4-03: no publisher/subscriber on a udp connection uses `messageEncoding:"json"`.

**Explicit PubSub coverage** (table-driven for 10/11/12): one connection + one publisher + one subscriber + ≥1 inject + ≥1 debug; connection `transportType` matches (udp / mqtt / mqtt); publisher and subscriber `messageEncoding` match the table AND each other; both workers' `connection` equals the in-file connection id; MQTT flows target `mqtt://localhost:1883`.

The negative path was proven: mutating flow 10's publisher to `messageEncoding:"json"` fails the suite (identical-encoding + D4-03 assertions), then was reverted.

## test/run-examples.js changes (PubSub-aware annotations)

`loadAndPatchExamples()` now records `transports` (the set of `opcua-pubsub-connection.transportType` values) and `brokerUrls` per example, with a comment noting the endpoint-patch loop is a harmless no-op for PubSub flows (they have no `opcua-endpoint`). The per-example run loop prints a dim `PubSub transport: …` line and, for MQTT flows, a dim broker-requirement note (`mqtt://localhost:1883`, `docker run -p 1883:1883 eclipse-mosquitto`) — informational, not counted as a flow defect. Flows 01-09 behavior is unchanged; `node -c` syntax-clean.

## README PubSub section placement and headings

New top-level `## OPC UA PubSub` inserted between `## Nodes` and `## Reference`. Subsections: intro (three combinations, no UDP-JSON), `### Configuration hierarchy` (publisher Connection → WriterGroup → DataSetWriter → PublishedDataSet; subscriber Connection → DataSetReader), `### Publisher input` (msg.payload field map, acyclic vs cyclic), `### Subscriber output (msg shape)` (D4-09 table incl. `msg.encoding`, `msg.transport`, `msg.topic` MQTT-only + ConfigurationVersion error note), `### Encoding rules` (UDP-only-UADP), `### UDP multicast NIC selection` (multicastInterface caveat), `### PubSub examples` (pointer to 10/11/12 + broker note). The `## Examples` list gained entries 9-12.

## Deviations from Plan

### Reconciliation (not a behavioral deviation)

The publisher property shape was reconciled from the plan's nested `<interfaces>` sketch to the shipped flat `writers`-JSON-string schema (see RECONCILIATION above). This is the parallel-availability caveat the plan anticipated ("if 04-01 exists, use its EXACT keys") — the shipped node defaults were authoritative.

### Static suite style

The plan sketched `node assert`; the suite was written with `chai`'s `expect` to match every existing `test/*.test.js` in the project. Behavior is identical; it remains auto-discovered by the existing mocha glob with no package.json change.

## Test count

- New tests: **65** (static example-flow validation).
- Full suite: **619 passing / 8 pending** = baseline 554 + 65, zero regressions. Suite exits cleanly (`--exit`).

## Known Stubs

None. The example flows wire real publisher → real subscriber pipelines; no placeholder/empty-data stubs were introduced.

## Human Verification Pending

Task 4 is a `type="checkpoint:human-verify"` gate that **cannot be executed by the agent** (no running Node-RED, no live broker). The automated portion (flows authored, static `npm test` validation green, README written, all committed) is **COMPLETE**; the import/deploy check is **PENDING** the user. Verbatim checklist:

> 1. From the repo root: `npm install`, then install this package into a local Node-RED
>    (e.g. `npm install /path/to/this/repo` in your ~/.node-red, or run the bundled
>    `docker compose up -d` dev stack) and restart Node-RED. Open the editor (typically
>    http://localhost:1880, or http://localhost:1881 for the Docker stack).
> 2. Confirm the editor sidebar shows the new nodes: opcua-pubsub-connection (config),
>    opcua-publisher, opcua-subscriber.
> 3. Flow 10 (UDP-UADP loopback — no external infra):
>    a. Menu -> Import -> Examples -> node-red-contrib-opcua-suite -> "10 - PubSub UDP-UADP Loopback"
>       (or Import -> file and pick `examples/10 - PubSub UDP-UADP Loopback.json`).
>    b. The flow imports with NO "unknown node type" errors and a populated config node.
>    c. Click Deploy. No deploy errors; the publisher/subscriber status indicators settle
>       (idle/connected/subscribed — not red error).
>    d. Click the "Publish DataSet" inject. The debug sidebar shows a received msg whose
>       msg.payload has the published fields (Temperature, Label), plus msg.encoding "uadp",
>       msg.transport "udp", and a sequenceNumber.
> 4. Flow 11 (MQTT-UADP) and Flow 12 (MQTT-JSON):
>    a. Start a local MQTT broker first, e.g. `docker run -p 1883:1883 eclipse-mosquitto`.
>    b. Import each flow, Deploy (no errors), click the inject, and confirm the debug node shows
>       the round-tripped DataSet (flow 12 msg.encoding "json", flow 11 "uadp"; both
>       msg.transport "mqtt"). msg.topic is present for the MQTT flows.
> 5. Confirm the Node-RED log shows no errors referencing opcua-publisher / opcua-subscriber /
>    opcua-pubsub-connection during import or deploy of any of the three flows.

**Resume signal:** Type "approved" if all three flows import and deploy cleanly (flow 10 standalone; flows 11/12 with a broker running), OR describe the specific import/deploy/runtime errors observed (e.g. "flow 11 publisher shows red 'error' status" or "unknown property X on opcua-subscriber").

## Self-Check: PASSED

- examples/10 - PubSub UDP-UADP Loopback.json — FOUND
- examples/11 - PubSub MQTT-UADP.json — FOUND
- examples/12 - PubSub MQTT-JSON.json — FOUND
- test/example-flows.test.js — FOUND
- test/run-examples.js (modified) — FOUND
- README.md ## OPC UA PubSub section — FOUND
- Commits d61b8bc, 30f8419, 3b274f1 — FOUND in git log

---
*Phase: 04-publisher-subscriber-tests-examples*
*Completed: 2026-06-13*

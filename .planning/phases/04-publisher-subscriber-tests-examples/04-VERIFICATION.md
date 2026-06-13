---
status: human_needed
phase: 04-publisher-subscriber-tests-examples
verified: 2026-06-13
requirements: [PUB-01, PUB-02, PUB-03, SUB-01, SUB-02, STAT-01, TEST-01, TEST-02, TEST-03, DOC-01, DOC-02]
plans_complete: 4
plans_total: 4
must_haves_verified: 5
must_haves_total: 5
---

# Phase 4 Verification — Publisher, Subscriber, Tests, Examples

Goal-backward verification against the 5 ROADMAP success criteria. All automated criteria
pass; one human-verify checkpoint (import the 3 example flows into a running Node-RED) is
pending and owned by the user.

## Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Publisher→UDP connection→inject msg.payload→subscriber emits msg with payload/publisherId/writerGroupId/dataSetWriterId/sequenceNumber/timestamp | ✅ PASS | `test/pubsub-roundtrip.test.js` UDP-UADP "round-trips fields/types/sequenceNumber (real dgram loopback)" + monotonic-sequence test |
| 2 | Cyclic mode fires at PublishingInterval, sends KeepAlive when no value changed | ✅ PASS | `nodes/opcua-publisher.js:236` `setInterval` per WriterGroup; `:193` `messageType:"keepalive"` on no-change; `:287` `clearInterval` on close; `test/pubsub-redeploy.test.js` cyclic-timer-cleared guard |
| 3 | ConfigurationVersion mismatch surfaces as visible node.error() on subscriber, never silently dropped | ✅ PASS | `nodes/opcua-subscriber.js:166-174` visible "ConfigurationVersion mismatch" node.error; D4-08 distinguishes silent filter-skip from visible version-mismatch; subscriber unit tests cover both |
| 4 | Mocha round-trip tests pass for UDP-UADP, MQTT-UADP, MQTT-JSON | ✅ PASS | `test/pubsub-roundtrip.test.js` three describe blocks, all green; MQTT via in-process aedes loopback, UDP via real dgram loopback |
| 5 | 3 example flows import cleanly into Node-RED and deploy without errors | ✅ PASS (visual pending) | `examples/10,11,12` created; `test/example-flows.test.js` (65 assertions) validates parse/tab/ids/referential integrity/transport+encoding coverage for all 12 flows. Visual import/deploy = human-verify checkpoint below |

## Requirement Traceability

| Req | Where satisfied |
|-----|-----------------|
| PUB-01 | opcua-publisher: connection ref + WriterGroup/DataSetWriter(s)/PublishedDataSet + publishMode toggle |
| PUB-02 | cyclic setInterval + KeepAlive + clearInterval on close |
| PUB-03 | acyclic: msg.payload field map → one DataSetMessage → one NetworkMessage |
| SUB-01 | opcua-subscriber: connection ref + DataSetReader filter |
| SUB-02 | exact D4-09 msg shape; ConfigurationVersion mismatch → node.error |
| STAT-01 | both nodes: registerStatusCallback → node.status (idle/connected/publishing|subscribed/disconnected/error) |
| TEST-01 | pubsub-roundtrip.test.js — 3 combinations |
| TEST-02 | pubsub-redeploy.test.js — 20 UDP + 5 MQTT construct/close cycles, no EADDRINUSE/leaks |
| TEST-03 | 8-combo UADP matrix confirmed passing; open62541 byte-for-byte capture = tracked MANUAL follow-up (D4-13), provenance guard prevents faking |
| DOC-01 | examples/10,11,12 + run-examples + example-flows.test.js |
| DOC-02 | README "OPC UA PubSub" section (hierarchy, msg shape, UDP-only-UADP, NIC caveat) |

## Test Results

- Full suite: **619 passing / 8 pending / 0 failing** (Phase 3 end 504 → +115 across the 4 Phase-4 plans).
- No regressions in existing Client/Server or Phase 1-3 PubSub suites.

## Integration Bugs Caught & Fixed (Wave 2 round-trip)

The round-trip integration tests caught two DEAD code paths that mock-based unit tests
could not — both now fixed and verified by real transport round-trip:
1. `nodes/opcua-publisher.js` never passed `{writerGroupId, dataSetWriterId}` to
   `transport.send` → MQTT publish threw `TOPIC_INVALID_CHARACTER`; the entire MQTT
   publish path was non-functional.
2. `lib/transports/mqtt-transport.js` never called `client.subscribe` → the entire MQTT
   receive path was non-functional.
These would have shipped MQTT PubSub completely broken despite green unit tests.

## TEST-03 — Tracked Manual Follow-up (not an automated gate)

Upgrade `test/fixtures/uadp-vectors.js` provenance from encoder-self-output to byte-for-byte
captured open62541 v1.4.x output (needs live open62541 publisher via Docker + the existing
`test-server/capture-open62541-vectors.js`). A provenance guard in `test/pubsub-redeploy.test.js`
fails loudly if fake "captured" provenance is introduced without real vectors.

## Human Verification Pending (Checkpoint — Plan 04-04 Task 4)

Plan 04-04 is `autonomous: false`. Importing the three example flows into a running
Node-RED and deploying them is a visual check the executor cannot perform. The verbatim
5-step checklist is in `04-04-SUMMARY.md`. Flow 10 (UDP-UADP) is self-contained; flows
11/12 need a local MQTT broker.

## Disposition

Automated verification: **PASS** (5/5 criteria, 11/11 requirements, 619 tests green).
Status: **human_needed** — example-flow import/deploy checkpoint awaits user confirmation
in Node-RED (shared with the Phase 3 editor-UX checkpoint).

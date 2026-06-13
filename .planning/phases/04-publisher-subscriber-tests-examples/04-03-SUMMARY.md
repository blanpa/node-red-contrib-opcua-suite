---
phase: 04-publisher-subscriber-tests-examples
plan: 03
subsystem: tests
tags: [opcua, pubsub, integration-test, round-trip, redeploy, aedes, mqtt, udp, uadp, json]

# Dependency graph
requires:
  - phase: 02 (encoders + pubsub config)
    provides: uadp-encoder/json-encoder encode+decodeNetworkMessage; uadp-vectors 8-combo matrix fixture
  - phase: 03 (transports + connection node)
    provides: UdpTransport (dgram multicast loopback), MqttTransport, capture-open62541-vectors.js script
  - phase: 04 plan 01 (publisher)
    provides: opcua-publisher node + frozen editor config schema + NetworkMessage shape
  - phase: 04 plan 02 (subscriber)
    provides: opcua-subscriber node + frozen editor config schema + D4-09 emitted msg shape
provides:
  - end-to-end round-trip proof for all three shipped combinations (UDP-UADP, MQTT-UADP, MQTT-JSON)
  - config-node-level 20-cycle redeploy/leak acceptance (TEST-02)
  - TEST-03 automated portion (8-combo matrix pass + capture-script provenance guard)
  - in-process aedes MQTT round-trip harness (createRED + real-transport pattern) reusable by 04-04
affects: [04-04 examples + README]

# Tech tracking
tech-stack:
  added:
    - "aedes ^1.0.2 (devDependency) — in-process MQTT broker for loopback round-trip tests (D4-11)"
  patterns:
    - "Round-trip harness: real publisher + real subscriber via hand-rolled createRED() ctor-capture, wired to ONE conn stub whose acquireTransport() returns a REAL UdpTransport/MqttTransport"
    - "Determinism: resolve on the subscriber's send() stub; publish only after the transport 'connected' event; Mocha timeout is the sole failsafe — no delivery sleeps"
    - "aedes 1.x async factory: const broker = await Aedes.createBroker(); net.createServer(broker.handle).listen(0, '127.0.0.1') for an ephemeral loopback port, torn down per test"

key-files:
  created:
    - test/pubsub-roundtrip.test.js
    - test/pubsub-redeploy.test.js
  modified:
    - package.json
    - package-lock.json
    - nodes/opcua-publisher.js
    - lib/transports/mqtt-transport.js
    - test/transports/mqtt-transport.test.js

key-decisions:
  - "aedes 1.x removed the synchronous default-export factory (aedes()); the broker is created via the async Aedes.createBroker() static and bound through net.createServer(broker.handle)"
  - "Two real-code defects blocking the required MQTT round-trips were fixed inline (Rule 1/2): the publisher never passed topic opts to send (MQTT publish dead) and MqttTransport never subscribed (MQTT receive dead)"
  - "mqtt-transport.test.js made order-independent by evicting the cached transport module in before/after so the mqtt stub binds even though pubsub round-trip tests load the real transport earlier"

patterns-established:
  - "Pattern: makeConnStub(transport, props) shares ONE real transport between publisher+subscriber and kicks off connect() on first acquire; fireClose(node) awaits the registered close handler (fails if absent — the D4-02 leak this test catches)"

requirements-completed: [TEST-01, TEST-02, TEST-03]

# Metrics
duration: ~20min
completed: 2026-06-13
---

# Phase 4 Plan 03: PubSub Round-trip + Redeploy Integration Tests Summary

**Goal-backward proof that the real opcua-publisher and opcua-subscriber actually talk to each other over real transports — a known DataSet published over UDP-UADP, MQTT-UADP, and MQTT-JSON is decoded by the real subscriber into identical fields, JS types, and sequence numbers — plus a 20-cycle config-node-level redeploy/leak acceptance and the automated portion of the TEST-03 UADP reference matrix.**

## Accomplishments

- `test/pubsub-roundtrip.test.js` (4 tests, TEST-01): real publisher + real subscriber over real transports for UDP-UADP (real dgram multicast loopback), MQTT-UADP and MQTT-JSON (in-process aedes broker on an ephemeral 127.0.0.1 port). Asserts `msg.payload` deep-equals the published field map, Double/String/Int32 JS-type checks, the publisher's `sequenceNumber`, `encoding`/`transport`/`topic`, and sequence-number monotonicity across two consecutive publishes.
- `test/pubsub-redeploy.test.js` (7 tests, TEST-02 + TEST-03): 20 rapid UDP construct/close cycles + 5 MQTT cycles asserting zero EADDRINUSE, zero unhandled rejections, null `_socket`/`_client` after close, and `"message"` listener counts returning to baseline; a cyclic-mode interval-cleared-on-close guard (D4-06); and the TEST-03 guards (8-combo matrix count + encode→decode regression, capture-script presence + Docker docs, honest open62541 MANUAL-follow-up provenance).
- `package.json` / `package-lock.json`: `aedes ^1.0.2` added to **devDependencies** only.
- Fixed two real defects that made the entire MQTT PubSub path non-functional (see Deviations).

## Task Commits

1. **Task 1 — round-trip tests + MQTT publish/receive fixes** — `7b9237b` (test)
2. **Task 2 — 20-cycle redeploy + TEST-03 guards + mqtt-transport test-ordering fix** — `f0ae8cf` (test)

## Round-trip results (per combination, verified)

| Combination | payload exact | types | sequenceNumber | topic | notes |
|-------------|---------------|-------|----------------|-------|-------|
| UDP-UADP    | yes           | number/string/int | 1 (→2 on 2nd publish) | `undefined` | real dgram loopback; `dataSetWriterId` positional from payloadHeader |
| MQTT-UADP   | yes           | number/string/int | 1 | `ua/pub1/1/1` | in-process aedes loopback |
| MQTT-JSON   | yes           | number/string/int | 1 (dsm fallback) | `ua/pub1/1/1` | no groupHeader → `writerGroupId` undefined; filter on publisherId |

## Editor property names the tests drive (resolved against the shipped nodes)

- **Publisher** (`nodes/opcua-publisher.js`): `connection`, `messageEncoding` (`"uadp"`/`"json"`), `publishMode` (`"acyclic"`/`"cyclic"`), `publishingInterval`, `writerGroupId`, `priority`, `maxNetworkMessageSize`, `writers` (JSON string array of `{ dataSetWriterId, dataSetName, publishedDataSet:{ name, fields:[{name,dataType}] } }`).
- **Subscriber** (`nodes/opcua-subscriber.js`): `connection`, `messageEncoding`, and the DataSetReader filter `publisherId` / `writerGroupId` / `dataSetWriterId` (at least one required). MQTT-JSON tests filter on `publisherId` (no groupHeader/writerGroupId in JSON, per 04-02).

No TODOs remained — the real nodes existed and their schemas matched the `<interfaces>` contract.

## Readiness-detection mechanism (determinism)

Each round-trip publishes only after the transport `"connected"` event (MQTT issues its topic SUBSCRIBE inside the connect handler before `connected` resolves; UDP loopback is ready once the socket is bound), then resolves on the subscriber's `send()` stub. A `setImmediate` gives the broker a microtask to register the subscription grant before the first MQTT publish. No `setTimeout(done, …)` / sleep is used to wait for delivery — the only time bound is the Mocha timeout failsafe (10s round-trip, 20s redeploy).

## UDP port range (redeploy loop)

`45678 + Math.floor(Math.random() * 5000)` — the same `freshPort()` range proven by Phase 3's `test/transports/udp-transport.test.js`, so repeated local runs do not collide.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Publisher never passed topic opts to transport.send → MQTT publish was dead**
- **Found during:** Task 1 (empirical probe before writing the MQTT round-trip).
- **Issue:** `node._emit` called `node.transport.send(encoded)` with NO opts. `MqttTransport.send` builds `${prefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}` from `opts` and throws `TOPIC_INVALID_CHARACTER` when `writerGroupId`/`dataSetWriterId` are missing — so every MQTT publish threw (caught by the input handler → `node.error`) and nothing was ever published. The real MQTT publish path was non-functional.
- **Fix:** `_emit` now passes `{ writerGroupId: writerGroup.writerGroupId, dataSetWriterId: writers[0].dataSetWriterId }` (the topic granularity matching the emitted frame). UDP ignores opts, so the UDP path is unaffected.
- **Files modified:** `nodes/opcua-publisher.js`
- **Commit:** `7b9237b`

**2. [Rule 2 - Missing critical functionality] MqttTransport never subscribed → MQTT receive was dead**
- **Found during:** Task 1 (same probe).
- **Issue:** `MqttTransport.connect()` wired `client.on("message", …)` but never called `client.subscribe(...)`, so the broker forwarded nothing and the subscriber's `transport.on("message")` listener never fired. The real MQTT receive path was non-functional.
- **Fix:** subscribe to `${topicPrefix}/#` inside the connect handler (software DataSetReader filtering selects the relevant frames). Subscribe errors surface as an `error` event but do not block `connected`. Verified against the existing mqtt-transport unit tests (mock `client.subscribe` is a no-op stub — all 28 still pass).
- **Files modified:** `lib/transports/mqtt-transport.js`
- **Commit:** `7b9237b`

**3. [Rule 3 - Blocking] mqtt-transport.test.js was order-dependent under the new test files**
- **Found during:** Task 2 (full-suite run).
- **Issue:** `test/transports/mqtt-transport.test.js` poisons `require.cache["mqtt"]` and re-requires the transport in `before()`, assuming it is the first file to load the transport. The new pubsub round-trip files load the **real** `mqtt-transport` earlier in the alphabetical suite, so the poisoned re-require returned the already-cached real-mqtt-bound module and 18 stub-dependent tests failed in the full run (they passed in isolation).
- **Fix:** evict the cached transport module (`delete require.cache[transportPath]`) in that test's `before` (so it re-binds to the mqtt stub) and `after` (so later files get the real-mqtt-bound module again). Makes the suite order-independent — verified in both forward and reverse order.
- **Files modified:** `test/transports/mqtt-transport.test.js`
- **Commit:** `f0ae8cf`

### Tooling note (not a code deviation)

aedes 1.x removed the synchronous default-export factory shown in the plan sketch (`const broker = aedes()`). The current API is `const broker = await Aedes.createBroker()`, bound via `net.createServer(broker.handle)`. The tests use this async form; the loopback/ephemeral-port/per-test-teardown contract (D4-11) is unchanged.

## TEST-03 open62541 MANUAL follow-up (exact wording)

> **MANUAL follow-up (D4-13):** Upgrade `test/fixtures/uadp-vectors.js` provenance from encoder-self-output to **byte-for-byte captured open62541 v1.4.x output**. This requires a live open62541 publisher via Docker (`docker pull open62541/open62541`; `docker run --rm --network=host open62541/open62541 --pubsub-uadp --port=4840`), then `node test-server/capture-open62541-vectors.js` to capture the UADP packets, and replacing each `hex: "..."` entry while updating its `provenance` to `"open62541 v<version> captured <date>"`. This is a tracked human-action follow-up, NOT an automated gate. Do NOT fabricate captured vectors — the `test/pubsub-redeploy.test.js` provenance guard fails loudly if fake "captured from open62541" provenance is introduced without real vectors.

## Test count

- New tests: **11** (4 round-trip + 7 redeploy/TEST-03).
- Full suite: **554 passing / 8 pending** = baseline 543 + 11, zero regressions. Suite exits cleanly (`--exit`), no hung handles.

## Known Stubs

None. No placeholder/empty-data stubs were introduced — all three round-trips drive real data through real transports.

## Self-Check: PASSED
- test/pubsub-roundtrip.test.js — FOUND
- test/pubsub-redeploy.test.js — FOUND
- package.json aedes devDependency — FOUND
- Commits 7b9237b, f0ae8cf — FOUND in git log

---
*Phase: 04-publisher-subscriber-tests-examples*
*Completed: 2026-06-13*

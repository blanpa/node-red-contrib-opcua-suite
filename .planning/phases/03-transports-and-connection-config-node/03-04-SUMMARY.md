---
phase: 03-transports-and-connection-config-node
plan: 04
subsystem: config-node
tags: [pubsub, config-node, node-red, refcount, grace-timer, status-fanout, publisherid, cert-dropzone]

# Dependency graph
requires:
  - phase: 03-transports-and-connection-config-node
    plan: 01
    provides: BaseTransport abstract class (D-01 instanceof contract + event vocabulary)
  - phase: 03-transports-and-connection-config-node
    plan: 02
    provides: UdpTransport (UDP-UADP multicast adapter)
  - phase: 03-transports-and-connection-config-node
    plan: 03
    provides: MqttTransport (MQTT 5.0/3.1.1 adapter)
  - phase: 01
    plan: cert-store
    provides: registerCertRoutes + getCertsDir (DEBT-02 reuse)
provides:
  - opcua-pubsub-connection Node-RED config node (owns transport lifecycle)
  - "Public API for Phase 4: acquireTransport / releaseTransport / registerStatusCallback / unregisterStatusCallback"
  - "Node properties for Phase 4: publisherId, publisherIdType, transportType"
  - Editor UI (transportType dropdown, conditional UDP/MQTT, PublisherId UX, cert dropzone under Advanced)
affects: [phase-04-publisher-subscriber]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Ref-count + 500ms grace timer (RECONNECT_GRACE_MS): release at refCount 0 schedules close; re-acquire within window clearTimeout-cancels and reuses the SAME _sharedTransport pointer (D-06 / Pitfall 5)"
    - "Status fan-out via Set + forEach with safeCb try/catch wrapper (mirrors opcua-endpoint.js 92-104); a throwing subscriber cannot break siblings"
    - "transport 'warn' event surfaced to node.warn (W-4, UDP_REASSEMBLY_OVERFLOW) — NOT part of the 4-event status fan-out set"
    - "Two-argument node.on('close', (removed, done)) handler — config-node mandate; cancels grace timer, awaits transport.close(), then done() (T-03-07)"
    - "_redactConfig(cfg) strips password + userName before any diagnostic log (T-03-03)"
    - "Editor cross-suite test isolation: this test file never require()s mqtt-transport/mqtt at top level so transports/mqtt-transport.test.js can poison require.cache[mqtt] in its root before() and re-require the transport against the stub"

key-files:
  created:
    - nodes/opcua-pubsub-connection.js
    - nodes/opcua-pubsub-connection.html
    - test/opcua-pubsub-connection.test.js
  modified:
    - package.json

key-decisions:
  - "PublisherId UUID default generated in BOTH layers: browser webcrypto UUID v4 in oneditprepare at node-create (D-10), plus a defensive crypto.randomUUID() server-side guard in the constructor for the empty-String case"
  - "Cert dropzone present but under a collapsed Advanced section with 'reserved for v2 mTLS' copy (RESEARCH A1) — keeps the three cert placeholder fields in the schema for Phase 3.1 stability without exposing unimplemented mTLS UI"
  - "Open Question 2 resolved — multicast NIC info text: 'Leave as 0.0.0.0 to let the OS choose the outgoing NIC. On a multi-NIC host the OS may pick the wrong interface for multicast — set an explicit NIC IP if datagrams are not received. The socket always binds to 0.0.0.0; this field only pins the interface used to join the group and send.'"
  - "Test #8 (MQTT dispatch) asserts constructor.name === 'MqttTransport' + instanceof BaseTransport instead of instanceof MqttTransport, so the test file avoids a top-level mqtt-transport require that would defeat the transports suite's require.cache mqtt mock"

requirements-completed: [CFG-01, CFG-02]

# Metrics
metrics:
  duration: ~30m
  completed: 2026-06-13
  tasks-automated: 2
  tasks-pending-human-verify: 1
  tests-added: 27
  suite-total: "504 passing / 8 pending"
---

# Phase 3 Plan 04: Transports and Connection Config Node Summary

The `opcua-pubsub-connection` Node-RED config node and editor UI (CFG-01, CFG-02). The node
owns a single shared PubSub transport (UDP-UADP multicast or MQTT), mirroring the proven
`opcua-endpoint.js` ref-count + status fan-out pattern and adding a 500ms grace timer
(D-05/D-06/D-08) so a release→acquire during a Node-RED redeploy reuses the SAME transport
instance instead of tearing the socket down and re-binding.

## What was built

- **`nodes/opcua-pubsub-connection.js`** — config-node module. Registers the type with a
  credentials block, registers cert routes once at module load via
  `registerCertRoutes(RED, "/opcua-pubsub-connection", getCertsDir(RED))`. Per-node it
  implements `acquireTransport()` (refCount++, cancel grace timer, dispatch
  UDP/MQTT, wire status fan-out, kick off connect), `releaseTransport()` (refCount--, 500ms
  grace timer on 0), `registerStatusCallback`/`unregisterStatusCallback`, a two-argument
  `node.on('close', (removed, done))` handler, `_createTransport()` dispatch, and
  `_redactConfig()` credential redaction.
- **`nodes/opcua-pubsub-connection.html`** — editor UI. transportType dropdown with conditional
  `#udp-section` / `#mqtt-section` (updateTransportUI), PublisherId type dropdown with adaptive
  text/number value input (updatePublisherIdUI), browser webcrypto UUID v4 default for a fresh
  String PublisherId, cert dropzone (client/key/CA) under a collapsed Advanced section, and a
  help panel covering UDP NIC binding, MQTT scheme/topic rules, and PublisherId types.
- **`test/opcua-pubsub-connection.test.js`** — 27 Mocha tests (18 core + 18b W-4 + 8 HTML
  content checks).
- **`package.json`** — registered `opcua-pubsub-connection` under `node-red.nodes`.

## Final field schema (defaults block, as written)

```javascript
defaults: {
  name:               { value: "" },
  transportType:      { value: "udp" },
  multicastGroup:     { value: "239.0.0.1" },
  multicastInterface: { value: "0.0.0.0" },
  port:               { value: 4840 },
  mtu:                { value: 1400 },
  brokerUrl:          { value: "mqtt://localhost:1883" },
  topicPrefix:        { value: "ua" },
  qos:                { value: 1 },
  publisherIdType:    { value: "String" },
  publisherId:        { value: "" },          // UUID set in oneditprepare for new nodes
  certificateFile:    { value: "" },          // Advanced / reserved for v2 mTLS
  privateKeyFile:     { value: "" },
  caCertificateFile:  { value: "" }
}
credentials: { userName: { type: "text" }, password: { type: "password" } }
```

## Public API exposed to Phase 4 Publisher/Subscriber

Resolve the config node via `RED.nodes.getNode(config.connection)`, then:

| Member | Signature | Purpose |
|--------|-----------|---------|
| `acquireTransport()` | `() -> BaseTransport` | Increments refCount, cancels any pending grace timer, returns the shared transport (same pointer across grace windows). |
| `releaseTransport()` | `() -> void` | Decrements refCount; starts a 500ms grace timer when it reaches 0. |
| `registerStatusCallback(cb)` | `cb(status, err?)` | Subscribes to connected / disconnected / reconnecting / error fan-out. |
| `unregisterStatusCallback(cb)` | `(cb) -> void` | Removes a status callback from the Set. |
| `node.publisherId` | `String` | User-set; default `crypto.randomUUID()` (D-10/D-11). |
| `node.publisherIdType` | `"String"\|"UInt16"\|"UInt32"\|"UInt64"` | PublisherId encoding type (D-12). |
| `node.transportType` | `"udp"\|"mqtt"` | Selected transport. |

Note: the `warn` transport event (e.g. `UDP_REASSEMBLY_OVERFLOW`) is surfaced to `node.warn`
and is intentionally NOT part of the worker-facing status fan-out set.

## Deviations from Plan

### Deviations from RESEARCH.md patterns
- **Pattern 7 (close handler):** Used the two-argument `(removed, done)` form per the plan's
  explicit WARNING, NOT the one-argument `(done)` form shown in RESEARCH Pattern 7. Validated by
  test #16.
- **Pattern 8 / Pattern 9:** Implemented as specified (transport-conditional visibility; cert
  dropzone hidden under collapsed Advanced). No deviations.

### [Rule 3 - Blocking] Cross-suite require.cache isolation for the mqtt mock
- **Found during:** Task 2, running the full `mocha test/**/*.test.js` suite.
- **Issue:** `test/transports/mqtt-transport.test.js` poisons `require.cache[mqtt]` in a ROOT
  `before()` hook and re-requires `mqtt-transport` against the stub. The original version of this
  plan's test file `require`d `mqtt-transport` at module top level, which cached it bound to the
  real `mqtt` before the transports suite could poison the cache — silently no-op'ing the stub and
  causing 18 failures in the transports suite whenever both files ran together.
- **Fix:** Removed the top-level `mqtt-transport`/`mqtt` requires from this plan's test file. The
  connection node requires the transport at its own top level inside `beforeEach`'s `loadModule()`
  (which runs AFTER the transports root `before()`), so the stub binds correctly. Test #8 asserts
  on `constructor.name === 'MqttTransport'` + `instanceof BaseTransport` and resolves the
  MqttTransport class lazily from `require.cache` inside the test to stub `connect`.
- **Files modified:** test/opcua-pubsub-connection.test.js
- **Commit:** 412f6f3
- **Result:** Full suite 504 passing / 8 pending, no regressions.

## Authentication gates
None.

## Self-Check: PASSED
- nodes/opcua-pubsub-connection.js — FOUND
- nodes/opcua-pubsub-connection.html — FOUND
- test/opcua-pubsub-connection.test.js — FOUND
- package.json registration — FOUND
- Commit 5f9ccf9 (Task 1) — FOUND
- Commit 412f6f3 (Task 2) — FOUND

## Human Verification Pending

Task 3 is a `checkpoint:human-verify` (gate=blocking). The automated portion (Tasks 1 & 2) is
COMPLETE and all 27 tests pass. The following 9-point visual/functional checklist requires a
human running a Node-RED editor and CANNOT be performed by the executor. Status: **PENDING**
(not failed).

### How to verify (verbatim from plan)

1. From the repo root, run `npm install` then `npm pack` (creates a tarball you can install).
   Alternatively, in a local Node-RED dev workspace, run `npm install /path/to/this/repo` and restart Node-RED.
2. Open the Node-RED editor (typically http://localhost:1880).
3. Drag any worker-needing-config node OR open the Configuration Nodes panel and click "Add new opcua-pubsub-connection".
4. Verify:
   - a. The node opens in an edit dialog with a "Transport Type" dropdown defaulting to "udp".
   - b. UDP section shows: Multicast Group (239.0.0.1), Multicast Interface (0.0.0.0), Port (4840), MTU (1400). MQTT section is hidden.
   - c. Change Transport Type to "mqtt". MQTT section appears (Broker URL mqtt://localhost:1883, Topic Prefix ua, QoS 1, Username, Password). UDP section disappears.
   - d. PublisherId Type dropdown shows: String, UInt16, UInt32, UInt64. Default = String.
   - e. PublisherId Value field is pre-populated with a UUID-shaped string (e.g., 6e8c9bbe-1234-5678-90ab-cdef12345678).
   - f. Change PublisherId Type to UInt16. Value field changes to a number input.
   - g. There is an "Advanced" collapsible section. Expand it. Three cert-dropzone areas appear: Client Certificate, Private Key, CA Certificate.
   - h. Save the node with default values + a name. Reopen — values persisted.
   - i. Click "Done" and Deploy. Node-RED should not log any errors related to opcua-pubsub-connection.
5. Optional smoke: with transportType=udp and a Phase-4 Publisher/Subscriber not yet built, the node alone should appear in the Config sidebar without errors. (If Phase 4 isn't shipped yet, this is the only visual verification possible — that's expected.)

**Resume signal:** Type "approved" if the editor UX matches all 9 checks above, OR describe
specific issues observed (e.g., "PublisherId default is empty, not UUID" or "MQTT section doesn't
hide when switching to UDP").

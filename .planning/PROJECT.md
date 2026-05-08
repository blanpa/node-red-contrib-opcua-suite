# node-red-contrib-opcua-suite

## What This Is

A modern Node-RED contrib package for OPC UA, providing eight nodes for industrial automation flows: a shared `opcua-endpoint` config node with ref-counted TCP connections, a msg-driven all-in-one `opcua-client` (read / write / subscribe / browse / method / history), an embedded `opcua-server`, an `opcua-item` collector for batch operations, and dedicated `opcua-browser`, `opcua-event`, `opcua-method`, and `opcua-browse-client` nodes. Built on `node-opcua@^2.115.0`. Audience: industrial / OT / Industrie 4.0 integrators using Node-RED to bridge SCADA, MES, and edge-IoT systems.

## Core Value

A Node-RED user can wire any OPC UA interaction — Client/Server (today) and Publisher/Subscriber (next milestone) — into a flow without writing function nodes, without losing connections silently, and with structured types preserved end-to-end.

## Requirements

### Validated

<!-- Shipped in v0.0.7. Inferred from .planning/codebase/. -->

- ✓ **Shared endpoint config node** with ref-counted TCP connection — `nodes/opcua-endpoint.js`, `lib/opcua-client-manager.js`
- ✓ **All-in-one msg-driven client** dispatching on `msg.operation` — `nodes/opcua-client.js`
- ✓ **Read / write / subscribe / browse / method / history** operations — `lib/opcua-client-manager.js`
- ✓ **Batch read / write via `msg.items`** with `opcua-item` collector chains — `nodes/opcua-item.js`
- ✓ **Drag-and-drop certificate upload** in editor UI — `nodes/opcua-endpoint.html` + `POST /opcua-endpoint/upload-cert`
- ✓ **Reconnect with infinite retry option** + exponential backoff (2s–30s) — `nodes/opcua-client.js::forceReconnect()`
- ✓ **ExtensionObject construction + JSON serialization** (read & write paths, asymmetric — see CONCERNS.md) — `lib/opcua-utils.js::serializeExtensionObject`, `lib/opcua-client-manager.js::_createExtensionObjectVariant`
- ✓ **Embedded OPC UA server node** (independent of endpoint config, manages own `OPCUAServer`) — `nodes/opcua-server.js`
- ✓ **Address-space browse** (runtime + editor-time tree picker via `RED.httpAdmin`) — `nodes/opcua-browser.js`, `nodes/opcua-browse-client.js`
- ✓ **Event subscription with filter construction** — `nodes/opcua-event.js`
- ✓ **Discovery primitives** (`getEndpoints`, `registerNodes`, `translateBrowsePath`) — `lib/opcua-client-manager.js`
- ✓ **Status fan-out** from endpoint to all worker nodes via `EventEmitter` — `nodes/opcua-endpoint.js`
- ✓ **X509 / username-password / anonymous user identity** auto-selection — `lib/opcua-client-manager.js::_buildUserIdentity`
- ✓ **Mocha + Chai + Sinon test suite** with standalone test-server harness — `test/`, `test-server/`
- ✓ **Docker dev/prod images** with native crypto build chain — `Dockerfile`, `docker-compose.yml`

### Active

<!-- Building toward these in the upcoming milestone. -->

- [ ] **OPC UA PubSub Publisher node** producing `NetworkMessages` over UDP-UADP, MQTT, and AMQP transports
- [ ] **OPC UA PubSub Subscriber node** consuming `NetworkMessages` from UDP-UADP, MQTT, and AMQP transports
- [ ] **UADP binary encoding** for `NetworkMessage` and `DataSetMessage` per OPC UA Part 14
- [ ] **JSON encoding** for `NetworkMessage` and `DataSetMessage` per OPC UA Part 14
- [ ] **PublishedDataSet / DataSetWriter / WriterGroup configuration** on the Publisher side
- [ ] **DataSetReader / ReaderGroup configuration** on the Subscriber side
- [ ] **PubSub config node(s)** for transport profiles (UDP, MQTT broker, AMQP broker) — config-node analog of `opcua-endpoint`
- [ ] **Reuse of existing certificate upload UI** for PubSub message signing/encryption keys
- [ ] **Examples flows** for PubSub Publisher and Subscriber (UDP multicast, MQTT broker, JSON encoded over MQTT)
- [ ] **Test coverage** for UADP encoding/decoding, transport adapters, and round-trip Pub→Sub

### Out of Scope

- **OPC UA PubSub Security Key Service (SKS) server implementation** — clients can use externally-managed keys; building an SKS server is a separate milestone
- **PubSub configuration via OPC UA address space** (Part 14 §6.2.7) — initial release uses Node-RED-driven static config only; runtime reconfiguration via UA model is a future enhancement
- **Reverse PubSub / discovery announcements** — explicitly deferred; static endpoint configuration is sufficient for v1
- **Adopting the commercial node-opcua PubSub package** — would change the suite's licensing posture (currently MIT). All PubSub code is implemented in-tree.
- **Replacing or refactoring existing Client/Server nodes** — PubSub is purely additive; no breaking changes to the eight existing nodes
- **WebSocket / HTTP transports for PubSub** — Part 14 lists them as "future"; not pursuing in this milestone

## Context

**Existing codebase state** (see `.planning/codebase/` for the full map):

- v0.0.7, pre-1.0 — API surface still subject to change without semver guarantees
- ~3000 lines across `nodes/` and `lib/`, no TypeScript, CommonJS only
- Single direct runtime dep (`node-opcua@^2.115.0`); 62 transitive `node-opcua-*` submodules
- **`node-opcua` does not provide PubSub support** in its open-source distribution — Sterfive offers it commercially. UADP encoding and PubSub transports must be implemented in this repo.
- Recent stabilization work in v0.0.5–0.0.7: robust reconnect with infinite retry (commit `6e9b247`), session retry race fix (`29432c5`), `hasBeenClosed()` call fix (`52dc434`), string-port coercion fix (`83d3622`)
- Known fragile areas (per `.planning/codebase/CONCERNS.md`): reconnect logic split between manager and node, subscription handling duplicated across consumers, `clientManager` internals reached into from node code, browse-client double-session — these are PubSub-impacted and should be considered when designing the PubSub manager(s)
- Locales catalog exists but is empty — i18n is not currently used; PubSub UIs should not introduce new strings that block future i18n

**User context:**

- Single primary maintainer (blanpa / Pascal Blansche, octotronic.com)
- Audience: industrial automation engineers and integrators using Node-RED for OT/IT integration
- Common deployment targets: Docker (per `DOCKER.md`), bare-metal Node-RED on Linux
- The PubSub milestone is driven by demand for OPC UA's session-less publish/subscribe model — common in Industrie 4.0 / SparkPlug-adjacent scenarios where MQTT brokers already exist on the OT network

## Constraints

- **License**: MIT — all PubSub code must be MIT-compatible; no GPL/AGPL deps, no commercial node-opcua PubSub bindings
- **Tech stack**: Node.js ≥18, Node-RED ≥3.0, CommonJS, no TypeScript, no transpiler — all PubSub code is plain JS
- **Direct runtime deps**: minimize additions. New deps OK for transports (`mqtt`, `amqplib` or equivalent) but UADP encoding stays in-tree
- **Compatibility**: zero breaking changes to existing eight nodes; PubSub adds new nodes/types only
- **Performance**: UDP-UADP must handle multicast publishing intervals down to ~50 ms without GC stalls
- **Security**: certificate handling must reuse the existing `opcua-certs` directory pattern; no new global cert stores
- **Testing**: every PubSub feature must have Mocha tests; round-trip Pub→Sub tests required for each transport
- **Editor UI**: drag-and-drop cert upload pattern from `opcua-endpoint.html` must be reusable for PubSub key management

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Implement PubSub UADP encoding in-tree (not via commercial node-opcua) | Preserves MIT licensing; avoids vendor lock; full control over Part 14 conformance | — Pending (locked into Active scope) |
| Both Publisher and Subscriber roles in v1 | Node-RED users routinely need both directions; symmetric design avoids second milestone | — Pending |
| All three transports in v1 (UDP-UADP + MQTT + AMQP) | Per-user request; covers full Part 14 spec scope. May be split if SPEC ambiguity surfaces | — Pending — re-evaluate during /gsd-spec-phase |
| New PubSub config node(s) — do not extend `opcua-endpoint` | PubSub is session-less; ref-counted TCP socket model doesn't apply; transports differ | — Pending |
| Reuse `lib/opcua-utils.js` (NodeId, ExtensionObject helpers) | Session-agnostic; directly applicable to `DataSetMessage` field encoding | — Pending |
| Granularity: coarse | Mature project, single maintainer, large milestone — fewer broader phases over many tiny ones | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-08 after initialization (brownfield bootstrap, PubSub milestone planned)*

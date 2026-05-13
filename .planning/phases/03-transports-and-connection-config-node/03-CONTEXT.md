# Phase 3: Transports and Connection Config Node — Context

**Gathered:** 2026-05-13
**Status:** Ready for planning
**Mode:** interactive (4 gray areas surfaced; user accepted all recommended choices)

<domain>
## Phase Boundary

Two transport adapters and one Node-RED config node:

- **TRP-01** — `lib/transports/udp-transport.js`: UDP-UADP multicast adapter, `dgram` socket bound to `0.0.0.0`, explicit `multicastInterface` config, `socket.close(done)` on shutdown.
- **TRP-02** — `lib/transports/mqtt-transport.js`: MQTT 5.0 (3.1.1 fallback) adapter via `mqtt@^5.15.1`, `retain=false` HARDCODED on data topics, QoS per Part 14 §7.3.4, uses library-side reconnect (NOT a `forceReconnect()` clone).
- **CFG-01 / CFG-02** — `nodes/opcua-pubsub-connection.{js,html}`: Config node with `transportType` dropdown (`udp` | `mqtt`), PublisherId field (type + value), reused cert dropzone via `lib/cert-store.js`. Owns the transport-instance, ref-count, and status fan-out to worker nodes.

Plus a shared interface contract:
- `lib/transports/base-transport.js`: ES6 abstract class extending `EventEmitter`, defines the contract that Phase 4 Publisher/Subscriber nodes program against.

**Out of scope for Phase 3:** Publisher / Subscriber worker nodes (Phase 4), MetaData publishing, security mode, transport-side chunk reassembly buffer (REQUIREMENTS says chunk reassembly + 30s expiry lives in UDP transport — keep it here per TRP-01 but only the buffer/expiry logic, the chunk-encoding side already lives in `lib/uadp-encoder.js`), example flows, README updates.

</domain>

<decisions>
## Implementation Decisions

### BaseTransport API Contract

- **D-01:** `BaseTransport` is an **ES6 abstract class extending `EventEmitter`** in `lib/transports/base-transport.js`. Concrete adapters extend it: `class UdpTransport extends BaseTransport`, `class MqttTransport extends BaseTransport`. Abstract methods throw `new Error('not implemented')` so missing overrides fail loud. Consistent with `OpcUaClientManager` (Phase 1) which also extends `EventEmitter`. `instanceof BaseTransport` is a valid runtime check the Connection-Node uses.

- **D-02:** `send(payload, opts?)` accepts **`Buffer | Buffer[]`**. Encoder may return either a single Buffer or an array of chunks (per Phase 2 02-02 chunking impl). Transport does `Array.isArray(payload)` and emits the right number of packets/publishes. Caller does NOT loop. `opts` reserved for future extension (matches Phase 2 D-04 reservation pattern).

- **D-03:** Status events emitted by the transport: **`connected`, `disconnected`, `reconnecting`, `error`** — identical set to `OpcUaClientManager` so the Connection-Node fan-out is a 1:1 mirror of `nodes/opcua-endpoint.js` (lines 93-104). Mapping per transport:
  - UDP: `connected` after `socket.bind()` callback fires; `disconnected` after `socket.close()` callback; `error` on `socket.on('error')`; `reconnecting` is never emitted (UDP is connectionless — the event exists in the set for API symmetry but UDP transport does not fire it).
  - MQTT: native `connect` → `connected`; `close` → `disconnected`; `reconnect` → `reconnecting`; `error` → `error`. Library handles reconnect automatically (TRP-02 mandate).

- **D-04:** Subscriber path uses **`transport.on('message', buffer => ...)`** EventEmitter pattern. Single listener style consistent with status events. Subscriber-Node (Phase 4) attaches once after `connected`, detaches on `node.on('close')`. No separate `receive(callback)` setter, no async iterator.

### Ref-counted Lifecycle + Grace Period

- **D-05:** Grace timer starts **when `refCount` drops from 1 to 0** (last consumer detaches). `setTimeout(() => transport.close(), 500)`. Until the timer fires, the transport remains connected and usable.

- **D-06:** A new `acquire()` during the grace window **cancels the timer with `clearTimeout` and reuses the same transport instance**. The pointer is stable across grace windows — references in worker nodes remain valid. Connection-Node status flips back to `connected` immediately (no fresh `connect()` round-trip). This is the key mitigation against Node-RED redeploy thrash (TRP-01 acceptance criterion: 20 redeploy cycles without EADDRINUSE).

- **D-07:** The **Connection-Node** (`nodes/opcua-pubsub-connection.js`) owns refCount + timer + transport-instance ownership. The `lib/transports/` files stay Node-RED-free and stateless w.r.t. lifecycle — they only know `connect()` / `close()`. Mirrors how `nodes/opcua-endpoint.js` owns `_sharedManager` while `lib/opcua-client-manager.js` is Node-RED-agnostic. Tests for the transport classes do NOT need to simulate Node-RED close-event behavior.

- **D-08:** Grace period is a **fixed 500 ms constant**, defined as `RECONNECT_GRACE_MS = 500` at the top of `opcua-pubsub-connection.js`. NOT exposed in the editor UI. Rationale: REQUIREMENTS.md CFG-01 names 500 ms explicitly, and the value addresses one specific failure mode (redeploy thrash) — no user-tunable need. Can be added as `opts.reconnectGraceMs` later without breaking the editor schema.

### PublisherId UX in the Editor

- **D-09:** PublisherId **type is chosen via dropdown** in the editor: `String | UInt16 | UInt32 | UInt64`. The value-input field type adapts to the selected type (text for String, number for UInts). No silent type coercion from a single text field.

- **D-10:** Default on new connection: **`type=String`, `value=crypto.randomUUID()` auto-generated** at node-create time. The user sees a valid, globally-unique identifier immediately and can overwrite it. Solves "every Publisher gets the same id when user doesn't touch the field" without forcing a validation-error UX on initial drag-and-drop.

- **D-11:** PublisherId **lives only on the Connection-Node**. Publisher-Nodes do NOT support per-publisher overrides. All Publishers attached to one Connection share the same publisherId — they ARE one publisher in spec terms (Part 14 §6.2). This keeps WriterGroupId / DataSetWriterId uniqueness reasoning straightforward.

- **D-12:** **Publisher-Node** (Phase 4) reads `connectionNode.publisherId` (and `connectionNode.publisherIdType`) and writes them into `networkMessage.publisherId` before calling `encodeNetworkMessage`. Encoder is stateless (Phase 2 D-01) — it derives the wire-level type from `typeof` (per Phase 2 02-01 implementation: BigInt → UInt64, Number → UInt16/32 by range, String → String variant). Type-info from the editor goes via Number/BigInt coercion at the Publisher-Node layer, NOT inside the encoder.

### MQTT Broker Config, Auth, QoS, Topics

- **D-13:** **Single `brokerUrl` field**, scheme drives TLS. User enters `mqtt://broker:1883` or `mqtts://broker:8883`. The `mqtt` library parses the scheme and connects with TLS automatically when scheme is `mqtts://`. Default value `mqtt://localhost:1883`. No separate TLS toggle. Mirrors how `opcua-endpoint` uses `opc.tcp://...` as a single URL.

- **D-14:** Authentication uses **`credentials: { userName: text, password: password }`** in the Node-RED config-node `credentials` block — same pattern as `nodes/opcua-endpoint.html` (which has `userName`/`password` in credentials). Anonymous connect when both fields are empty. TLS client-cert support (mTLS) is OUT of scope for Phase 3 — can be added later via the cert-store helper (`registerCertRoutes` with prefix `opcua-pubsub-connection`).

- **D-15:** **QoS is editor-configurable** via dropdown `0 | 1 | 2`, default `1` (safe middle ground per Part 14 §7.3.4). Connection-level default. Publisher-Node in Phase 4 may override per send (e.g., QoS=0 for cyclic data, QoS=2 for configuration). Subscriber-side subscribes with this QoS by default.

- **D-16:** Topic structure: **default pattern + per-Publisher override capability**. Connection-Node has a `topicPrefix` field with default `ua`. The published topic for a single data message is computed as `${topicPrefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}` (Part 14 §7.3.4 recommended pattern). Phase 4 Publisher-Node can override the full topic string per worker. `retain` is HARDCODED to `false` on data topics (TRP-02 mandate, with unit test asserting this can't be overridden via opts).

### Claude's Discretion

- File layout under `lib/transports/` vs flat `lib/`. **Decided: `lib/transports/` subfolder** to group the three transport-related files (base + udp + mqtt) and signal that more transports may join later (AMQP v2). Mirrors how `lib/cert-store.js` and `lib/opcua-client-manager.js` are flat — but those are singletons, transports are a family.
- Specific socket option defaults for UDP (e.g., `reuseAddr=true`, `addMembership` timing) — implementation choices the planner+executor decide based on REQUIREMENTS.md `0.0.0.0` binding mandate and the EADDRINUSE acceptance criterion. NOT a user-facing decision.
- Internal helper names, JSDoc wording, error code naming convention (likely `MQTT_*` and `UDP_*` prefixes mirroring Phase 2 `UADP_*` / `JSON_*` per D-08 Phase 2).

### Folded Todos

None.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project-internal
- `.planning/PROJECT.md` — Vision, core value, "minimize new deps" principle
- `.planning/REQUIREMENTS.md` — TRP-01, TRP-02, CFG-01, CFG-02 full text
- `.planning/ROADMAP.md` (Phase 3 section) — Success criteria 1-5
- `.planning/phases/02-encoders-and-config-objects/02-CONTEXT.md` — Phase 2 locked decisions (D-01..D-21) — encoder API contract, PublisherId variants supported, NetworkMessage model shape
- `.planning/research/PITFALLS.md` §1 (flag cascade — already mitigated in Phase 2), §5 (UDP EADDRINUSE / multicast NIC binding), §6 (MTU 1400 default — config-objects already enforce)

### Codebase patterns to mimic
- `nodes/opcua-endpoint.js` — ref-counted shared instance pattern, statusCallback Set, register/unregister, release with ref-count check, `node.on('close', async)` shutdown handler
- `nodes/opcua-endpoint.html` — Node-RED editor structure: `RED.nodes.registerType`, `defaults`, `credentials`, `category: 'config'`, cert-dropzone integration via `lib/cert-store.js` routes
- `lib/cert-store.js` — exports `registerCertRoutes(RED, prefix, certsDir)`, `getCertsDir(RED)` — to be called from Connection-Node with prefix `'opcua-pubsub-connection'`
- `lib/opcua-client-manager.js` — pattern for `class X extends EventEmitter` lifecycle owner, connect/disconnect state machine
- `lib/uadp-encoder.js` — Phase 2 deliverable, what the Publisher will feed Buffer/Buffer[] to the transport
- `lib/pubsub-config.js` — Phase 2 config-object factories; Connection-Node UI eventually feeds these (Phase 4)

### Spec references
- OPC UA Part 14 v1.05 §7.2.4.4 (UDP NetworkMessage transport, multicast group address)
- OPC UA Part 14 v1.05 §7.3 (MQTT mapping: §7.3.2 connection, §7.3.4 QoS + retained-flag, §7.3.5 topic naming)
- OPC UA Part 14 v1.05 §6.2.5 (KeepAliveTime — already validated in Phase 2 pubsub-config; transport-layer interaction TBD in Phase 4)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `nodes/opcua-endpoint.js` lines 42-150 — the EXACT ref-counted shared-instance + statusCallback fan-out pattern. New `opcua-pubsub-connection.js` should mirror structure: `node._statusCallbacks = new Set()`, `_sharedTransport` instead of `_sharedManager`, `registerStatusCallback` / `unregisterStatusCallback`, `releaseSharedTransport` with grace timer added.
- `nodes/opcua-endpoint.html` — copy-paste skeleton for the new HTML file. Replace endpoint-specific defaults (`endpointUrl`, `securityMode`) with transport-specific ones (`transportType`, `brokerUrl`, `multicastInterface`, `publisherIdType`, `publisherId`, `topicPrefix`, `qos`). Keep `credentials` shape (`userName`, `password`).
- `lib/cert-store.js::registerCertRoutes` — call with `(RED, '/opcua-pubsub-connection', getCertsDir(RED))` to register cert-upload routes for the new config node. Cert dropzone in the HTML is the same drag-drop pattern.
- `lib/opcua-client-manager.js` — reference for `class X extends EventEmitter` skeleton (constructor signature, internal state object, event emission patterns).
- `lib/uadp-encoder.js::encodeNetworkMessage` — produces `Buffer | Buffer[]`. Transport.send must handle both (D-02).

### Established Patterns

- **Status events:** `connected | disconnected | reconnecting | error` — opcua-endpoint emits all 4. Use identical set for transport-side AND for Connection-Node fan-out (D-03).
- **lib/ stays Node-RED-free:** all RED-dependent code lives in `nodes/*.js`. Transport classes are pure-Node, testable with `dgram` and `mqtt` directly without Node-RED's runtime.
- **CommonJS, 2-space indent, double quotes, JSDoc banners** — per Phase 2 D-21.
- **fail-fast factories via `createError`:** when transports throw, use the same `createError` from `lib/opcua-utils.js` (already used in Phase 2 lib/* files) for structured error codes (`UDP_BIND_FAILED`, `MQTT_CONNECT_TIMEOUT`, etc.).

### Integration Points

- Connection-Node ↔ Phase 4 Publisher: `connectionNode.acquireTransport()` → returns `BaseTransport` instance + increments refCount. `connectionNode.releaseTransport()` → decrements, starts grace timer if 0.
- Connection-Node ↔ Phase 4 Publisher: `connectionNode.registerStatusCallback(cb)` so Publisher node-status reflects transport state.
- Connection-Node ↔ Editor: `RED.nodes.registerType('opcua-pubsub-connection', ...)` with `category: 'config'`, `color: '#3a8cba'` (or new color for visual distinction from `opcua-endpoint`).
- Connection-Node ↔ cert-store: routes registered once at module-load, drag-drop dropzone in HTML wired the same way as endpoint's dropzone.
- Phase 4 worker ↔ Transport: worker reads `connectionNode.publisherId` + `connectionNode.publisherIdType`, builds NetworkMessage, calls `encodeNetworkMessage()`, hands result to `transport.send()`.

</code_context>

<specifics>
## Specific Ideas

- The `node._statusCallbacks` Set + forEach fan-out pattern from `opcua-endpoint.js` lines 93-104 is the gold standard for how Connection-Node mirrors transport-events to worker nodes. Copy it.
- `mqtt@^5.15.1` is a new runtime dep — package.json currently has only `node-opcua`. This is an explicit REQUIREMENTS.md call (TRP-02) so adding it is in-scope.
- `crypto.randomUUID()` is Node 14.17+ stable, well within the >=18 engine req from Phase 2.
- 30-second chunk-reassembly expiry (per TRP-01) lives in the UDP transport's receive path. Cleanup timer in the transport itself (not the Connection-Node), keyed by `(publisherId, writerGroupId, dataSetWriterId, sequenceNumber)` or whatever the wire-format chunk header keys per Phase 2 RESEARCH.md §UADP Chunking.

</specifics>

<deferred>
## Deferred Ideas

- **mTLS client-certificate auth for MQTT** — Phase 3 covers TLS via `mqtts://` scheme + user/pass only. Client-cert auth is a Phase 3.1 or v2 follow-up.
- **AMQP transport** (TRP-03) — already deferred to v2 at Init.
- **Per-Publisher PublisherId override** — explicitly out per D-11.
- **Configurable reconnect grace period in UI** — explicitly out per D-08; `opts.reconnectGraceMs` plumbing path exists for future need.
- **Discovery / announcement** — Part 14 §7.4 MetaData / discovery topics not in v1 scope.
- **MQTT 5.0 user properties / response topic** — only basic Publish/Subscribe in v1.

</deferred>

---

*Phase: 03-transports-and-connection-config-node*
*Context gathered: 2026-05-13*

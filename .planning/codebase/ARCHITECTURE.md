# Architecture

**Analysis Date:** 2026-05-08

## Pattern Overview

**Overall:** Node-RED contrib package layered on `node-opcua@^2.115.0`, using a **two-layer node design**:

1. A **shared config node** (`opcua-endpoint`) owns connection state and certificates.
2. **Worker nodes** (`opcua-client`, `opcua-browser`, `opcua-method`, `opcua-event`, `opcua-browse-client`) are stateless front-ends that ref-count the shared connection and dispatch user `msg` operations through a single `OpcUaClientManager` per endpoint.

`opcua-server` is **independent** — it does not use the endpoint config node and manages its own `OPCUAServer` instance directly.

`opcua-item` is a **pure data shaping node** — it has no OPC UA dependency at all and only enriches `msg.items` / `msg.topic` for downstream client nodes.

**Key Characteristics:**
- **Ref-counted shared connection** — N client/browser/event/method nodes pointing at the same `opcua-endpoint` share one `OPCUAClient` + `Session` (one TCP socket).
- **Event-driven status propagation** — `OpcUaClientManager` extends `EventEmitter`; `opcua-endpoint` fans `connected`/`disconnected`/`reconnecting`/`error` events out to every registered worker node.
- **msg-driven runtime API** — Worker nodes dispatch on `msg.operation` (or `msg.command` for the server). No per-operation node types.
- **Promise + timeout wrapping** — Every node-opcua session call goes through `OpcUaClientManager._withTimeout()` (default 10s) so a dead session cannot hang a flow indefinitely.
- **Two reconnect layers** — node-opcua's built-in `connectionStrategy` (transport-level) plus a `forceReconnect()` loop in `opcua-client.js` (operation-level retry on `connection-lost` errors).

## Layers

**Layer 1 — Node-RED Integration (HTML + JS pairs, `nodes/`):**
- Purpose: Register node types with the Node-RED runtime and editor.
- Location: `nodes/*.js` (runtime) + `nodes/*.html` (editor UI, palette metadata, help).
- Contains: `RED.nodes.registerType(...)` calls, `node.on('input'|'close')` lifecycle handlers, status/error reporting via `node.status()` / `node.error()`.
- Depends on: `lib/`, `node-opcua` (only directly imported by `opcua-server.js`, `opcua-event.js`, `opcua-client.js` for `ClientMonitoredItem`/`AttributeIds`/`constructEventFilter`, `opcua-browse-client.js`).
- Used by: Node-RED runtime via `package.json` `node-red.nodes` mapping.

**Layer 2 — OPC UA Connection Management (`lib/opcua-client-manager.js`):**
- Purpose: Wraps a single `OPCUAClient` + `ClientSession` lifecycle, exposes operation methods (`read`, `write`, `callMethod`, `browse`, `createSubscription`, `historyRead`, `getEndpoints`, `registerNodes`, `translateBrowsePath`), handles reconnect, manages subscriptions map.
- Location: `lib/opcua-client-manager.js` (913 lines, `class OpcUaClientManager extends EventEmitter`).
- Contains: connect/disconnect, `_buildUserIdentity()` (X509 → user/pass → anonymous priority), `_toOpcUaNodeId()`, `_createVariant()`, ExtensionObject construction/serialization, `_withTimeout()` wrapper, `_ensureConnected()` health check (handles `session.hasBeenClosed()` and `isReconnecting`), `scheduleReconnect()`.
- Depends on: `node-opcua`, `node-opcua-extension-object` (optional), `lib/opcua-utils.js`.
- Used by: `nodes/opcua-endpoint.js` (one shared instance per endpoint), `nodes/opcua-browse-client.js` (creates an additional ephemeral instance for editor-time browsing).

**Layer 3 — Pure Helpers (`lib/opcua-utils.js`):**
- Purpose: Stateless utilities — NodeId parsing/formatting, ExtensionObject → JSON serialization, error/URL helpers.
- Location: `lib/opcua-utils.js` (263 lines, no class state, pure functions).
- Contains: `parseNodeId()`, `nodeIdToString()`, `parseDataType()`, `createError()`, `isValidEndpointUrl()`, `serializeExtensionObject()`, `WELL_KNOWN_NODES` map.
- Depends on: only Node `Buffer` builtins.
- Used by: All worker nodes (`nodes/opcua-client.js`, `nodes/opcua-browser.js`, `nodes/opcua-method.js`, `nodes/opcua-event.js`, `nodes/opcua-browse-client.js`) and `lib/opcua-client-manager.js`.

## Data Flow

### Client read/write/browse/method/history flow

1. Editor configures an `opcua-client` node and references an `opcua-endpoint` config node (`config.endpoint`).
2. On node create, `nodes/opcua-client.js` calls `RED.nodes.getNode(config.endpoint).getSharedManager({...})` — this **increments the endpoint's `_refCount`** and returns the shared `OpcUaClientManager`. If `_refCount` was 0, the manager is created (no connection yet).
3. Node registers a status callback via `endpointConfig.registerStatusCallback(cb)` so it shows the endpoint's connection state.
4. A `msg` arrives at `node.on('input', ...)`:
   a. `ensureConnected()` is called — if `clientManager.isConnected === false`, `await clientManager.connect()` opens TCP + creates a `ClientSession`.
   b. `executeOperation(msg, msg.operation, send)` dispatches via `switch` on `msg.operation` to a `handleX` function (`handleRead`, `handleWriteMultiple`, `handleSubscribe`, `handleBrowse`, `handleMethod`, `handleHistory`, `handleGetEndpoints`, `handleReadAttribute`, `handleRegisterNodes`, `handleUnregisterNodes`, `handleTranslateBrowsePath`).
   c. Each handler validates `msg.topic`/`msg.nodeId` via `parseNodeId()`, calls a method on `clientManager` (which in turn calls `this._withTimeout(this.session.X(...), ...)`).
   d. Results are merged onto `msg` (e.g. `msg.payload`, `msg.statusCode`, `msg.sourceTimestamp`) and passed to `send(msg)`.
5. If the operation throws and `isConnectionLostError(error)` is true, `forceReconnect()` runs (configurable `retryAttempts`, exponential backoff 2s–30s, infinite when `retryAttempts <= 0`), then the operation is retried once.
6. On `node.on('close')`, monitor items + subscription terminate, status callback unregisters, `endpointConfig.releaseSharedManager()` decrements `_refCount`. When the **last** worker closes, the endpoint disconnects the session and clears `_sharedManager`.

### Subscribe flow (`opcua-client` operation `subscribe`)

1. `handleSubscribe()` lazily creates a `ClientSubscription` via `clientManager.createSubscription({ interval, maxNotificationsPerPublish })`.
2. Per requested NodeId, a `ClientMonitoredItem.create(subscription, ...)` is added with `attributeId: 13` (Value).
3. `monitoredItem.on('changed', dataValue => send({ payload, statusCode, sourceTimestamp, serverTimestamp, nodeId, operation: 'subscribe' }))` — every server notification produces one outbound Node-RED message.
4. `monitorItems` Map keyed by NodeId string lets `unsubscribe` tear down individual items without dropping the subscription.

### Item collector flow (`opcua-item` → `opcua-client`)

1. `nodes/opcua-item.js` reads its `config.items` array (each `{ nodeId, datatype, itemName }`).
2. On input, if `node.collector` is true (default) **or** `msg.items` is already an array, items are **appended** to `msg.items` — so multiple `opcua-item` nodes can be chained in series.
3. For write operations, the current `msg.payload` is copied into each item's `value`.
4. The downstream `opcua-client` sees `msg.items` populated and either: a) routes a `read` to `handleReadMultiple` automatically, b) routes a `write` to `handleWriteMultiple`. This produces a **single batched OPC UA service call**.

### ExtensionObject support pattern

Construction (write path):
- `msg.datatype === "ExtensionObject"` + `msg.dataTypeNodeId` (e.g. `"ns=2;i=3003"`) triggers `clientManager._createExtensionObjectVariant(value, dataTypeNodeId)`.
- Implementation: `OpcUaClientManager.constructExtensionObject()` calls `session.constructExtensionObject(coerceNodeId(dataTypeNodeId), fields)` — node-opcua's session knows the structured type definition from the server's address space.
- Result: a `Variant({ dataType: DataType.ExtensionObject, value: extObj })`.
- Used by: `write()`, `writeMultiple()`, `callMethod()` (per-arg ExtensionObject input).

Serialization (read path):
- `OpcUaClientManager._serializeValue()` runs on every read result. Detection:
  1. Single typed ExtensionObject — `value.schema` truthy.
  2. `OpaqueStructure` (undecoded) — `value instanceof OpaqueStructure` (loaded from `node-opcua-extension-object`) or duck-type on `constructor.name`.
  3. Array of either of the above.
- Delegates to `lib/opcua-utils.js::serializeExtensionObject(extObj)` — recurses, flattens schema fields into plain JSON, encodes `OpaqueStructure` as `{ _opaque: true, _typeName, _raw: <base64> }`, encodes `Date` as ISO string and `Buffer` as base64. Internal keys (`_*`, `schema`, `nodeId`) are stripped.

`opcua-browse-client.js` mirrors this in its monitored-item callback (lines 574–586) for subscribe mode, and in its editor-time HTTP `/browse` endpoint (lines 246–319) it can introspect ExtensionObject fields directly from a value read when the server does not expose them as child nodes.

### Certificate management flow

Storage:
- Directory: `path.join(RED.settings.userDir || '/data', 'opcua-certs')` — created on first load by `nodes/opcua-endpoint.js` lines 14–17.
- Filename sanitization: `replace(/[^a-zA-Z0-9._\-]/g, '_')` — applied on upload and delete (lines 30, 51).

Editor-side upload (`opcua-endpoint.html` drag-and-drop):
- `POST /opcua-endpoint/upload-cert` — body `{ filename, content: <base64> }`. Writes to `<userDir>/opcua-certs/<sanitized-filename>`.
- `GET /opcua-endpoint/certs` — lists files matching `/\.(pem|der|crt|key|pfx|p12)$/i`.
- `DELETE /opcua-endpoint/upload-cert/:filename` — removes a cert.
- Endpoints registered conditionally on `RED.httpAdmin` (skipped in test environment).

Runtime use:
- Five separate cert paths on the endpoint config: `certificateFile`, `privateKeyFile`, `caCertificateFile` (transport TLS) and `userCertificateFile`, `userPrivateKeyFile` (X509 user identity token).
- `OpcUaEndpointNode.getCertificateData()` filters out non-existent files (`fs.existsSync`) before passing to manager.
- `OpcUaClientManager.connect()` (lines 130–150) attaches `certificateFile`, `privateKeyFile`, and reads `caCertificateFile` into `clientOptions.serverCertificate`.
- `OpcUaClientManager._buildUserIdentity()` (lines 263–285) prefers X509 (`type: 2, certificateData, privateKey`) over username/password over anonymous.

## Key Abstractions

**`OpcUaClientManager` (`lib/opcua-client-manager.js`):**
- Purpose: Single-session OPC UA client lifecycle with reconnect, ExtensionObject support, timeout-wrapped operations.
- Pattern: `EventEmitter`, one instance per endpoint shared via the config node; an additional ephemeral instance is created per endpoint for editor-time browsing in `opcua-browse-client.js`.
- Events emitted: `connected`, `disconnected`, `reconnecting`, `error`, `backoff`, `subscription_started`, `subscription_keepalive`, `subscription_terminated`.

**`opcua-endpoint` config node (`nodes/opcua-endpoint.js`):**
- Purpose: Owns endpoint URL + security settings + credentials + cert paths; creates and ref-counts the shared `OpcUaClientManager`.
- Pattern: Node-RED `config` node with `RED.nodes.registerType('opcua-endpoint', ..., { credentials: { userName, password } })`.
- API exposed to worker nodes: `getSharedManager(clientConfig)` (refcount++), `releaseSharedManager()` (refcount--), `registerStatusCallback(cb)` / `unregisterStatusCallback(cb)`, `getCertificateData()`.

**Worker node template (`opcua-client`, `opcua-browser`, `opcua-event`, `opcua-method`, `opcua-browse-client`):**
- Pattern (consistent across all five):
  1. `RED.nodes.getNode(config.endpoint)` — retrieve config node.
  2. Defensive check `if (!endpointConfig.getSharedManager) return;` — refuses to start if endpoint API is missing.
  3. `clientManager = endpointConfig.getSharedManager({...})`.
  4. Define and register `statusCallback`.
  5. `node.on('input', async (msg, send, done) => {...})` — the message handler.
  6. `node.on('close', async (removed, done) => {...})` — terminate subscriptions, `unregisterStatusCallback`, `releaseSharedManager`.

**Variant + NodeId coercion (`OpcUaClientManager._toOpcUaNodeId`, `_createVariant`):**
- All public methods accept either a string NodeId (`"ns=2;s=Var"`), a parsed object from `parseNodeId()`, or a `NodeId` instance — coercion is centralized.
- `_createVariant(value, datatype)` auto-detects DataType from JS type when `datatype` is null.

## Entry Points

**Node-RED runtime registration (`package.json` lines 13–25):**
```json
"node-red": {
  "version": ">=3.0.0",
  "nodes": {
    "opcua-client":         "nodes/opcua-client.js",
    "opcua-server":         "nodes/opcua-server.js",
    "opcua-item":           "nodes/opcua-item.js",
    "opcua-endpoint":       "nodes/opcua-endpoint.js",
    "opcua-event":          "nodes/opcua-event.js",
    "opcua-method":         "nodes/opcua-method.js",
    "opcua-browser":        "nodes/opcua-browser.js",
    "opcua-browse-client":  "nodes/opcua-browse-client.js"
  }
}
```
- Node-RED on startup `require`s each path. Each module exports `function(RED) { ... RED.nodes.registerType('<type>', NodeCtor, [credentials]) }`.
- Editor side (`*.html`) is auto-discovered by Node-RED next to the JS file.

**HTTP admin routes (registered in node `module.exports`, run-once at module load):**
- `nodes/opcua-endpoint.js` lines 23–62: `POST/GET/DELETE /opcua-endpoint/upload-cert(s)` for cert management.
- `nodes/opcua-browse-client.js` lines 174–467: `POST /opcua-browse-client/browse` and `POST /opcua-browse-client/disconnect` for editor-time address-space exploration (uses an ephemeral `OpcUaClientManager` cached per endpoint id with a 60-second idle timer in a `Map`).

**Per-flow lifecycle entry points (per node instance):**
- `RED.nodes.createNode(this, config)` — base init.
- `node.on('input', ...)` — `msg` arrival.
- `node.on('close', ...)` — flow redeploy or Node-RED shutdown.

**Test entry points:**
- `test/*.test.js` — Mocha tests run via `npm test` (`mocha test/**/*.test.js --timeout 30000 --exit`).
- `test-server/server.js` — standalone local OPC UA server (`node test-server/server.js`) used for integration testing.
- `test-server/test-client.js` — exercise the manager directly (`npm run test:integration`).

## Error Handling

**Strategy:** Promise rejection at the manager layer → catch + classify at the node layer → `node.error()` + `msg.error` propagation + status update.

**Patterns:**
- `OpcUaClientManager` rethrows wrapped errors (`throw new Error('Error reading: ' + e.message)`), preserving the operation context.
- Worker nodes catch in their `input` handler, build `msg.error = createError(message, error)` (`{ message, error, stack }` from `lib/opcua-utils.js::createError`), still call `send(msg)` so downstream nodes can react, then `done(error)`.
- Connection-lost classification (`opcua-client.js` lines 155–165): regex against known node-opcua error messages (`"Session is no longer valid"`, `"Not connected"`, `"premature disconnection"`, `"Secure Channel Closed"`, `"connection may have been rejected"`, `"Server end point"`, `"socket has been disconnected"`) → triggers `forceReconnect()`.
- `_withTimeout()` rejects with `Operation timed out after Xms: <label>` and **flips `isConnected = false`** so the next message triggers a fresh connect.
- `_ensureConnected()` (`lib/opcua-client-manager.js` lines 393–406) detects `session.hasBeenClosed()` (called as method) or `session.isReconnecting` → marks `isConnected = false` and throws `"Session is no longer valid"` (caught by the worker's reconnect path).

## Cross-Cutting Concerns

**Logging:**
- Node-RED's `node.log()`, `node.warn()`, `node.error()` exclusively. No external logger.
- `verboseLog` flag (per-client config, default `true`) gates non-critical warnings about reconnect attempts and connection-lost notices in `nodes/opcua-client.js`.

**Validation:**
- NodeId strings are validated with `parseNodeId()` (`lib/opcua-utils.js`). It returns `null` on parse failure; callers throw `Invalid NodeId: <input>`.
- Server port (`nodes/opcua-server.js` lines 16–24): `toPositiveInt(value, fallback)` coerces string-typed numeric inputs from Node-RED's HTML.
- Cert filenames: regex sanitized at the HTTP boundary.
- `isValidEndpointUrl()` regex is exported from `opcua-utils.js` but not currently called by any node (available for future use).

**Authentication:**
- Three modes selected automatically by `_buildUserIdentity()`: X509 user token (when both `userCertificateFile` and `userPrivateKeyFile` resolve) > username/password > anonymous.
- Credentials stored as Node-RED `credentials: { userName: text, password: password }` on the endpoint config node, encrypted at rest by Node-RED.

**Connection sharing / status fan-out:**
- One `Set<callback>` (`node._statusCallbacks`) per endpoint config node — every event from the manager is broadcast to all currently registered worker nodes.
- Ref count is tracked manually (`node._refCount`); disconnect happens only on the **last** release. Forced cleanup occurs in `node.on('close', ...)` at the endpoint level if the endpoint itself is removed.

## PubSub Integration Points (for upcoming UDP-UADP / MQTT / AMQP milestone)

PubSub in OPC UA is **session-less** — Publishers and Subscribers exchange `NetworkMessages` over UDP, MQTT, or AMQP transports without an OPC UA Session/SecureChannel. This has direct architectural consequences for the suite.

**What PubSub will share with the existing client/server architecture:**
- **Endpoint config node (`nodes/opcua-endpoint.js`)** — Reuse the same drag-and-drop certificate UI, the `opcua-certs` upload directory under `RED.settings.userDir`, and the `getCertificateData()` helper. PubSub Security Key Service (SKS) and signed/encrypted UADP messages need certificates from the same pool.
- **`lib/opcua-utils.js`** — `parseNodeId()`, `nodeIdToString()`, `WELL_KNOWN_NODES`, `serializeExtensionObject()` are session-agnostic and directly reusable for PubSub `DataSetMessage` field encoding/decoding.
- **Status fan-out pattern** — `registerStatusCallback`/`unregisterStatusCallback` is a generic transport-state-broadcast mechanism; PubSub Publisher/Subscriber nodes can adopt the same pattern (likely with new event names: `publisher_started`, `subscriber_subscribed`, `connector_connected`).
- **Editor-side HTTP admin route registration pattern** — same conditional `if (RED.httpAdmin) { ... }` block for any PubSub configuration UI.

**What PubSub must NOT share (stand-alone):**
- **`OpcUaClientManager`** — assumes a `ClientSession`, holds a `subscriptions` Map of `ClientSubscription`, and all read/write/method calls go through `this.session`. PubSub has no Session. A new manager (e.g. `lib/opcua-pubsub-publisher.js`, `lib/opcua-pubsub-subscriber.js`) is required.
- **`getSharedManager()` ref-counting** — designed around one TCP socket per endpoint. PubSub transports are different beasts: UDP-UADP is connectionless multicast/unicast; MQTT/AMQP are broker connections that may want their own ref-counted broker config nodes (e.g. an `opcua-pubsub-broker` config node analogous to `opcua-endpoint`).
- **Reconnect classification (`isConnectionLostError`)** — message strings are node-opcua client-specific. PubSub transports will surface different errors (UDP socket errors, MQTT `disconnect`, AMQP `connection.close`) requiring their own classifiers.
- **Session-level operations** — `read`, `write`, `callMethod`, `browse`, `historyRead`, `subscribe`, `createSubscription` have no PubSub equivalent; PubSub only publishes/subscribes to `DataSetMessage`s defined by `PublishedDataSet` + `DataSetWriter` / `DataSetReader` configurations.

**Suggested integration boundaries:**
- New config node `opcua-pubsub-connection` (or one per transport: `opcua-pubsub-udp`, `opcua-pubsub-mqtt`, `opcua-pubsub-amqp`) — owns transport state, mirrors the ref-count pattern of `opcua-endpoint`.
- New worker nodes `opcua-publisher`, `opcua-subscriber` — analogous to `opcua-client` but consuming the pubsub config node.
- A potentially shared **`opcua-security` config node** could be extracted from `opcua-endpoint` if PubSub Security Key Service support is added — but this is an optional refactor and not required for v1 PubSub.
- `nodes/opcua-server.js` may grow a `command: "addPublishedDataSet"` / `command: "addDataSetWriter"` if the server is to act as a Publisher; that is purely additive to the existing server command dispatcher.

---

*Architecture analysis: 2026-05-08*

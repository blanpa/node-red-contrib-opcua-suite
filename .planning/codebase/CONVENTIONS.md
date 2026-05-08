# Coding Conventions

**Analysis Date:** 2026-05-08

## Module System

**CommonJS only** (Node.js >=18, no transpiler).

- Imports: `const { ... } = require("...")`
- Exports: `module.exports = function(RED) { ... }` for Node-RED nodes; named exports object for libraries (`lib/opcua-utils.js`, `lib/opcua-client-manager.js`).
- No ESM (`import`/`export`), no TypeScript, no `package.json#type` field — pure CJS.
- New PubSub code MUST stay in CommonJS to remain consistent with the rest of the codebase and Node-RED loader expectations.

**Reference patterns:**
- Node entry: `nodes/opcua-method.js:6` — `module.exports = function(RED) { ... }`
- Library entry: `lib/opcua-utils.js:255-263` — single `module.exports = { fn1, fn2, ... }`
- Class export: `lib/opcua-client-manager.js:913` — `module.exports = OpcUaClientManager`

## File / Directory Layout

**Top-level layout:**
- `nodes/` — One file per Node-RED node type (paired `.js` runtime + `.html` editor UI). Filenames are kebab-case prefixed with `opcua-` and match the registered Node-RED type name.
- `lib/` — Reusable helper modules (no Node-RED coupling).
- `test/` — Mocha test files; pattern `*.test.js` for tests run by `npm test`, and `live-integration.js` / `run-examples.js` for runnable integration scripts (NOT picked up by `npm test`).
- `test-server/` — Standalone runnable scripts: `server.js` (full reference OPC UA server), `test-client.js` (manual integration suite), `test-flows.js` (Node-RED admin-API driven flow tester).
- `examples/` — Bundled `.json` flow examples loaded via Node-RED **Import → Examples**.
- `locales/` — Help text translations for Node-RED editor.

**For new PubSub work:**
- Place runtime in `nodes/opcua-pubsub-*.js` (one node type per file).
- Editor HTML is `nodes/opcua-pubsub-*.html` (paired with same base name).
- Connection / publisher / dataset-reader logic that does NOT depend on `RED` belongs in a new `lib/opcua-pubsub-manager.js` (mirroring `lib/opcua-client-manager.js`).
- Register new types in `package.json#node-red.nodes`.

## Naming

**Files (kebab-case, lowercase):**
- `nodes/opcua-client.js`, `nodes/opcua-browse-client.js`, `lib/opcua-client-manager.js`.
- Future: `nodes/opcua-pubsub-publisher.js`, `lib/opcua-pubsub-manager.js`.

**Node-RED registered type names:** kebab-case, exactly matching the filename.
- `RED.nodes.registerType("opcua-client", OpcUaClientNode)` — `nodes/opcua-client.js:701`.

**Constructors / Classes:** PascalCase.
- `OpcUaClientNode`, `OpcUaEndpointNode`, `OpcUaServerNode`, `OpcUaClientManager`.

**Functions / methods:** camelCase.
- Public on classes/handlers: `connect`, `disconnect`, `read`, `readMultiple`, `callMethod`, `historyRead`, `getSharedManager`, `releaseSharedManager`.
- Internal helpers prefixed `_`: `_withTimeout`, `_buildUserIdentity`, `_toOpcUaNodeId`, `_createVariant`, `_serializeValue`, `_ensureConnected` (`lib/opcua-client-manager.js`).
- Node-private state on `node` prefixed `_`: `node._sharedManager`, `node._refCount`, `node._statusCallbacks` (`nodes/opcua-endpoint.js:87-89`).

**Variables:** camelCase. Local mutables typically use `let`, never `var`. Constants for module-scope values use `const` + UPPER_SNAKE_CASE (only seen at module scope).
- Examples: `RECONNECT_BASE_DELAY_MS = 2000`, `RECONNECT_MAX_DELAY_MS = 30000` (`nodes/opcua-client.js:174-175`).
- `WELL_KNOWN_NODES`, `TEST_USERS`, `PORT`, `PKI_DIR`, `CERTS_DIR` (`lib/opcua-utils.js:5`, `test-server/server.js:28-40`).

**msg properties (Node-RED message API):** camelCase, exact names below — these are the public API surface and MUST be reused identically by PubSub nodes when applicable.
- Common inputs: `msg.topic`, `msg.nodeId`, `msg.payload`, `msg.operation`, `msg.items`, `msg.datatype`, `msg.dataTypeNodeId`, `msg.action`, `msg.command`.
- Common outputs: `msg.payload`, `msg.statusCode`, `msg.sourceTimestamp`, `msg.serverTimestamp`, `msg.nodeId`, `msg.error`, `msg.count`.

**NodeId conventions:**
- Strings follow OPC UA syntax exactly: `ns=2;s=Var`, `ns=2;i=1234`, `ns=2;g=GUID`, `ns=2;b=BYTES`, plus shortcuts `i=84`, `s=MyVar` (ns=0 implicit).
- Well-known names resolved via `WELL_KNOWN_NODES` map in `lib/opcua-utils.js:5-16`: `RootFolder`, `ObjectsFolder`, `Server`, `ServerStatus`, etc.
- Always parse external NodeIds with `parseNodeId(...)` from `lib/opcua-utils.js`. Convert back with `nodeIdToString(...)`.
- Internally, the manager calls `_toOpcUaNodeId(...)` which delegates to node-opcua's `resolveNodeId()` — never construct `NodeId` objects directly in node files.

## Code Style

**No `.eslintrc*` and no `.prettierrc*` files exist** (verified in repo root). Linting/formatting use defaults of ESLint 8 + Prettier 3.

**Indentation is inconsistent** — established convention varies by file:
- 2-space (newer files, refactor target): `lib/opcua-client-manager.js`, `lib/opcua-utils.js`, `nodes/opcua-client.js`, `nodes/opcua-browse-client.js`, all newer test files (`integration-session-retry.test.js`, `opcua-client-manager.test.js`, `opcua-client-retry.test.js`).
- 4-space (older files): `nodes/opcua-endpoint.js`, `nodes/opcua-event.js`, `nodes/opcua-item.js`, `nodes/opcua-method.js`, `nodes/opcua-browser.js`, `nodes/opcua-server.js`, `test/opcua-item.test.js`, `test/opcua-nodes.test.js`, `test/opcua-utils.test.js`, `test/connection-sharing.test.js`, `test/nodes-registration.test.js`.
- **Recommendation for new code (incl. PubSub):** use **2-space indentation + double-quoted strings** (matches the active refactor direction visible in `lib/` and `nodes/opcua-client.js`).

**Quotes:**
- 2-space files use double quotes (e.g., `lib/opcua-client-manager.js`: 0 single, 66 double).
- 4-space files use single quotes (e.g., `nodes/opcua-event.js`: 62 single, 0 double).
- Template literals (backticks) used everywhere for interpolation.

**Semicolons:** Always required, used consistently. No ASI-reliant code anywhere.

**`'use strict'` directive:**
- Only present in test files (`test/*.test.js`, `test/live-integration.js`, `test/run-examples.js`).
- NOT used in `nodes/*.js` or `lib/*.js`. CommonJS modules in Node.js are strict-by-class anyway; new code may follow either pattern but match the surrounding file.

**`var`/`let`/`const`:** No `var` anywhere. Default to `const`; use `let` only when reassignment is needed.

**Async style:**
- `async`/`await` everywhere; no raw `.then()` chains except inside `_withTimeout` (`lib/opcua-client-manager.js:73-76`).
- Wrap awaitable I/O with `_withTimeout(promise, ms, label)` (`lib/opcua-client-manager.js:64-78`) — every `session.read/write/call/browse/...` MUST go through this helper.

**Comment headers / sections:** Files are structured with section dividers using box-drawing dashes:
```js
// ─── Single Read ───
// ─── ExtensionObject Helpers ───
```
Used in `lib/opcua-client-manager.js` and most test files. New files SHOULD follow this convention.

**File-level JSDoc banner:** Every node and lib file starts with a `/** ... */` comment summarising purpose, e.g. `lib/opcua-client-manager.js:1-4`, `nodes/opcua-client.js:1-12`. New PubSub files MUST include the same.

**Trailing commas:** Used in 2-space files (`lib/opcua-client-manager.js`), absent in 4-space files. Match local file style.

## Node-RED Patterns

### Node registration (one type per file)

```js
// nodes/opcua-method.js
module.exports = function (RED) {
  function OpcUaMethodNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    // ... read config.* into node.* ...
    // ... wire endpointConfig.getSharedManager / registerStatusCallback ...
    node.on("input", async function (msg, send, done) { /* ... */ });
    node.on("close", async function (removed, done) { /* cleanup */ done(); });
  }
  RED.nodes.registerType("opcua-method", OpcUaMethodNode);
};
```

For config nodes that need credentials (`opcua-endpoint`):
```js
RED.nodes.registerType("opcua-endpoint", OpcUaEndpointNode, {
  credentials: { userName: { type: "text" }, password: { type: "password" } }
});
```
See `nodes/opcua-endpoint.js:199-204`.

### Status badges

Standard 4-state pattern, identical across `opcua-client`, `opcua-browser`, `opcua-method`, `opcua-event`, `opcua-browse-client`:

```js
const statusCallback = (event, error) => {
  switch (event) {
    case "connected":
      node.status({ fill: "green",  shape: "dot",  text: "connected" });    break;
    case "disconnected":
      node.status({ fill: "red",    shape: "ring", text: "disconnected" }); break;
    case "reconnecting":
      node.status({ fill: "yellow", shape: "ring", text: "connecting..." }); break;
    case "error":
      node.status({ fill: "red",    shape: "ring", text: "error" });        break;
  }
};
endpointConfig.registerStatusCallback(statusCallback);
```
Reference: `nodes/opcua-event.js:29-45`, `nodes/opcua-method.js:26-42`, `nodes/opcua-browser.js:26-42`, `nodes/opcua-client.js:51-69`.

Additional transient states used by individual nodes:
- `{ fill: "yellow", shape: "ring", text: "ready" }` — endpoint configured but not yet connected.
- `{ fill: "blue", shape: "dot", text: "..." }` — informational (e.g. `opcua-method.js:69` "calling...", `opcua-item.js:30` item label).
- `{ fill: "red", shape: "ring", text: "no endpoint" }` — endpoint config missing.
- `{ fill: "red", shape: "ring", text: "stopped" }` / `{ text: \`Port ${port}\` }` — server lifecycle (`nodes/opcua-server.js:31,60,154`).

**PubSub nodes MUST register the same 4 events via `endpointConfig.registerStatusCallback`** so the status badge stays consistent with all sibling nodes. If a PubSub node owns its own UDP/multicast connection (no shared endpoint), expose an equivalent status callback API on its config node.

### Error propagation

Two-channel pattern, used uniformly:

```js
node.on("input", async function (msg, send, done) {
  try {
    // ... do work ...
    send(msg);
    done();
  } catch (error) {
    node.error(`<Operation> error: ${error.message}`);  // 1. flow editor + catch node
    node.status({ fill: "red", shape: "ring", text: "error" });
    msg.error = createError(error.message, error);       // 2. downstream nodes can branch
    send(msg);
    done(error);                                          // 3. signal completion w/ error
  }
});
```

References: `nodes/opcua-event.js:134-140`, `nodes/opcua-method.js:81-87`, `nodes/opcua-client.js:248-254`, `nodes/opcua-browser.js:95-100`, `nodes/opcua-server.js:135-141`.

Rules:
- ALWAYS call `node.error(message)` so Catch nodes work and the error appears in the editor sidebar.
- ALWAYS attach `msg.error = createError(error.message, error)` (from `lib/opcua-utils.js:155-161`) before `send(msg)` so a downstream debug node sees structured `{ message, error, stack }`.
- ALWAYS call `done(error)` (with the Error object) when failing — and `done()` (no args) on success. Required for Node-RED 3+ async-handler completion.
- `node.warn(...)` is reserved for transient retry/reconnect notices, gated on a `verboseLog` flag (see `nodes/opcua-client.js:199,204,230`).
- `node.log(...)` is reserved for lifecycle events (server start/stop, connection ref count, "Last client closed").

### Lifecycle / cleanup

```js
node.on("close", async function (removed, done) {
  // Terminate any owned subscriptions / monitored items first
  if (monitoredItem) { try { await monitoredItem.terminate(); } catch (e) { /* ignore */ } }
  if (subscription)  { try { await subscription.terminate();  } catch (e) { /* ignore */ } }

  // Drop status callback registration
  if (endpointConfig.unregisterStatusCallback) {
    endpointConfig.unregisterStatusCallback(statusCallback);
  }

  // Release the shared connection (refcount; disconnects only on last release)
  if (endpointConfig.releaseSharedManager) {
    try { await endpointConfig.releaseSharedManager(); } catch (e) { /* ignore */ }
  }
  done();
});
```
References: `nodes/opcua-event.js:143-153`, `nodes/opcua-method.js:91-99`, `nodes/opcua-client.js:259-290`, `nodes/opcua-browser.js:104-112`.

The `done` callback MUST be called even if an error occurred during cleanup — Node-RED waits up to 15s for it. Wrap each cleanup step in its own try/catch with comment `/* ignore */`.

## Shared Connection Pattern

Implemented in the `opcua-endpoint` config node — every client-side node (`opcua-client`, `opcua-browser`, `opcua-method`, `opcua-event`) reuses one TCP connection per endpoint via ref-counting.

**Endpoint config (`nodes/opcua-endpoint.js:86-185`):**
- `node._sharedManager: OpcUaClientManager | null` — the shared instance, lazily created on first `getSharedManager()`.
- `node._refCount: number` — number of consumer nodes currently holding the manager.
- `node._statusCallbacks: Set<fn>` — fan-out for `connected | disconnected | reconnecting | error` events from the manager.
- `getSharedManager(clientConfig)` — increment refcount, lazily create the `OpcUaClientManager`, wire its events to all registered callbacks, return it.
- `releaseSharedManager()` — decrement refcount (clamped at 0); when it reaches 0, call `_sharedManager.disconnect()` and null it out.
- `registerStatusCallback(cb)` / `unregisterStatusCallback(cb)` — managed Set; each consumer registers exactly one and unregisters in `node.on("close")`.

**Consumer nodes:**
```js
const endpointConfig = RED.nodes.getNode(config.endpoint);
if (!endpointConfig || !endpointConfig.getSharedManager) {
  node.status({ fill: "red", shape: "ring", text: "no endpoint" });
  return;
}
const clientManager = endpointConfig.getSharedManager({
  applicationName: "Node-RED OPC UA <Role>",
});
```

PubSub nodes that share an endpoint MUST follow the same pattern. If PubSub uses a fundamentally different transport (UDP datagrams), introduce a parallel `opcua-pubsub-connection` config node with the **same public surface** (`getSharedManager`/`releaseSharedManager`/`registerStatusCallback`/`unregisterStatusCallback`) so consumers stay symmetrical.

## Reconnect / Retry Strategy

Two layers cooperate.

### Layer 1 — `OpcUaClientManager` (`lib/opcua-client-manager.js`)

- node-opcua's `OPCUAClient.create({ connectionStrategy: { initialDelay, maxRetry, maxDelay } })` handles low-level transport reconnect (`lib/opcua-client-manager.js:115-128`).
- `keepSessionAlive: true` keeps the OPC UA session warm.
- After-reconnection hook recreates the session if needed (`lib/opcua-client-manager.js:167-182`).
- `scheduleReconnect()` (`:243-259`) schedules a single-shot reconnect timer when `maxReconnectAttempts` is not exceeded.
- Events emitted: `connected`, `disconnected`, `reconnecting`, `error`, `backoff`, plus subscription lifecycle events.
- Every async OPC UA call MUST go through `_withTimeout(promise, ms, label)` which sets `isConnected = false` on timeout so the next message triggers reconnect (`lib/opcua-client-manager.js:64-78`).
- `_ensureConnected()` (`:393-406`) checks both `isConnected` and `session.hasBeenClosed()` (called as a function — see CHANGELOG 0.0.5 fix) plus `session.isReconnecting`.

### Layer 2 — `opcua-client` infinite retry with backoff (`nodes/opcua-client.js:174-210`)

Constants:
```js
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS  = 30000;
const retryAttempts = Number(config.retryAttempts) || 0;  // 0 == infinite
```

Single-flight reconnect lock (avoids parallel reconnects when several messages arrive during an outage):
```js
let reconnectPromise = null;
async function forceReconnect() {
  if (reconnectPromise) return reconnectPromise;
  reconnectPromise = _doForceReconnect();
  try { await reconnectPromise; } finally { reconnectPromise = null; }
}
```

Backoff loop (`_doForceReconnect`):
- Attempts up to `retryAttempts` (or forever when `0`).
- Delay grows linearly per attempt, capped at `RECONNECT_MAX_DELAY_MS`: `Math.min(BASE * attempt, MAX)`.
- Calls `node.warn(...)` only when `verboseLog !== false` (`config.verboseLog`).

**Connection-lost classifier (`nodes/opcua-client.js:155-165`):**
```js
function isConnectionLostError(error) {
  const m = error && error.message;
  return m === "Session is no longer valid" ||
         m === "Not connected" ||
         m.includes("premature disconnection") ||
         m.includes("Secure Channel Closed") ||
         m.includes("connection may have been rejected") ||
         m.includes("Server end point") ||
         m.includes("socket has been disconnected");
}
```
PubSub error classification (UDP timeouts, multicast bind failures, etc.) MUST be added here — or a sibling helper introduced — if PubSub reuses this client-style retry envelope.

**Per-message retry envelope (`nodes/opcua-client.js:212-255`):**
```js
async function tryOnce() {
  await ensureConnected();
  return await executeOperation(msg, operation, send);
}
try {
  let result;
  try { result = await tryOnce(); }
  catch (error) {
    if (isConnectionLostError(error)) {
      node.status({ fill: "yellow", shape: "ring", text: "reconnecting..." });
      await forceReconnect();
      result = await executeOperation(msg, operation, send);  // retry once
    } else { throw error; }
  }
  // ... success path ...
} catch (error) { /* error path (see Error propagation) */ }
```

**Verbose logging toggle:**
- Per-node `config.verboseLog` (default `true` — `verboseLog = config.verboseLog !== false`).
- Gates `node.warn` for `Connection lost (...) – reconnecting...`, `Reconnect attempt N/∞ failed – retrying in Xms...`, `Reconnected to OPC UA server (attempt N/∞)`.
- `node.error(...)` (operation failures) is ALWAYS logged regardless of `verboseLog`.

PubSub nodes that maintain their own listening sockets SHOULD adopt the same `verboseLog` config flag and the same warning verbiage so log output stays uniform.

## Imports / Module Conventions

**Order observed in newer files (`lib/opcua-client-manager.js`):**
1. Third-party / runtime: destructured `require("node-opcua")` block at top.
2. Optional sub-package imports inside try/catch (`require("node-opcua-extension-object")`).
3. Node built-ins: `events`, `fs`, `path`.
4. Internal `./` or `../lib/...` modules.

No path aliases; only relative paths (`../lib/opcua-utils`) and bare module names.

## Validation / Defensive Coding

- Validate user-supplied NodeIds via `parseNodeId()` and throw `Invalid NodeId: ${input}` on failure (template literal with original input). See repeated pattern across `nodes/opcua-client.js:307,395,500,568`.
- Coerce numeric config that arrives as string from Node-RED HTML inputs:
```js
const toPositiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
```
(`nodes/opcua-server.js:16-19` — fix for issue #11). PubSub configs with port / publishing-interval inputs MUST do the same.
- Check filesystem references with `fs.existsSync` before passing to node-opcua (`lib/opcua-client-manager.js:131-150`, `nodes/opcua-endpoint.js:93-108`).

## Function / Module Design

- Node files keep the constructor function compact and delegate per-operation work to top-level helper functions named `handle<Op>(msg, mgr)` (`nodes/opcua-client.js:295-699`). Helpers throw plain `Error`s; the caller's try/catch handles propagation.
- Library classes (`OpcUaClientManager`) expose narrow public methods (`read`, `write`, `callMethod`, ...) that all share the same skeleton: `_ensureConnected()` → `_withTimeout(session.<op>, ms, label)` → wrap result → `catch` rethrow as `new Error("<Op> error: ${error.message}")`.
- No barrel files (`index.js`); each module is required by its full path.

## What to Reuse for PubSub

- `OpcUaClientManager`-shaped class in `lib/opcua-pubsub-manager.js` extending `EventEmitter` with `connect`, `disconnect`, status events, `_withTimeout` and `_ensureConnected` equivalents.
- `nodeIdToString` / `parseNodeId` / `WELL_KNOWN_NODES` from `lib/opcua-utils.js` for any DataSet field NodeIds.
- `serializeExtensionObject` from `lib/opcua-utils.js` for DataSetMessage payload serialisation.
- `createError(message, error)` from `lib/opcua-utils.js` for `msg.error` shaping.
- The 4-state status callback contract: `connected | disconnected | reconnecting | error`.
- `verboseLog` flag and `RECONNECT_BASE_DELAY_MS` / `RECONNECT_MAX_DELAY_MS` constants if implementing a custom backoff for UDP/multicast failures.

---

*Convention analysis: 2026-05-08*

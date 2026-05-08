# Testing Patterns

**Analysis Date:** 2026-05-08

## Test Framework

**Runner:**
- Mocha 10.2.0 (`mocha` in `package.json` devDependencies).
- No mocharc file — all options passed on the CLI from the `npm test` script.
- Config: none (no `.mocharc*`, no `mocha.opts`).

**Assertion Library:**
- Chai 4.3.10 (BDD `expect` style only — `chai/expect`). No `should`, no `assert`.

**Mocking / Stubs / Spies:**
- Sinon 17.0.1 — used for `sinon.stub()`, `sinon.spy()`, `sinon.match(...)` in newer test files.
- Custom hand-rolled mocks for the Node-RED runtime (`createRED()` factory, see below). Sinon is layered on top for stub behaviours.
- No `proxyquire`. Where module-load interception is needed, `require.cache` and `Module._resolveFilename` are patched directly (see `test/connection-sharing.test.js:43-62`).
- No HTTP mocking lib — `test-server/server.js` is started as a real OPC UA server in integration suites.

**Linter / Formatter (companion tooling):**
- ESLint 8.57.0, Prettier 3.2.5 — devDependencies only.
- **No `.eslintrc*` and no `.prettierrc*` configs exist.** Both tools run with their built-in defaults.
- Scripts (from `package.json:29-30`):
  - `npm run lint` → `eslint nodes/*.js lib/*.js` (intentionally excludes `test/`, `test-server/`).
  - `npm run format` → `prettier --write nodes/**/*.js lib/**/*.js` (also excludes `test/`).
- No CI step currently runs lint/format gating (only `.github/workflows/publish-npm.yml` exists, for npm trusted publishing).

**Run Commands (from `package.json:26-30`):**
```bash
npm test                                # mocha test/**/*.test.js --timeout 30000 --exit
npm run test:integration                # node test-server/test-client.js (single integration script)
npm run lint                            # eslint nodes/*.js lib/*.js
npm run format                          # prettier --write nodes/**/*.js lib/**/*.js

# Not in package.json — invoked manually:
node test/live-integration.js           # WebSocket-driven Node-RED end-to-end (needs Docker stack)
node test/run-examples.js               # Auto-deploy + drive every examples/*.json (needs Docker)
node test-server/server.js              # Long-running reference OPC UA server (port 4840)
node test-server/test-client.js [url]   # Same as `npm run test:integration`
node test-server/test-flows.js [url]    # Drives a Node-RED Admin API at the given URL
```

### `npm test` vs `npm run test:integration`

| Aspect | `npm test` | `npm run test:integration` |
|---|---|---|
| Runner | Mocha 10 | Plain `node` script |
| Discovers | `test/**/*.test.js` (glob in script) | Single file `test-server/test-client.js` |
| Real OPC UA server? | Spins up an in-process `OPCUAServer` for `test/integration-session-retry.test.js` only on a random port `48400+rand%1000`. All other suites use mocks. | Connects to an externally running server (default `opc.tcp://localhost:4840/UA/TestServer`, override via `process.argv[2]`). The user must start `node test-server/server.js` first (or run via `docker compose up`). |
| Network? | Loopback only, ephemeral. | Loopback or remote depending on the URL passed. |
| Asserts via | chai `expect`. | Custom `ok()`/`fail()` counters with ANSI-coloured output (`test-server/test-client.js:23-33`). Exits non-zero on failure. |
| Timeout | Mocha global `--timeout 30000`; integration suite raises to `60000` per `this.timeout(60000)`. | Hardcoded `setTimeout(...,5000)` for subscription wait (`test-server/test-client.js:294`). |
| Coverage tool? | None configured. | None. |
| CI use | Suitable. | Requires the test-server harness + Docker network → typically run manually or in `docker-compose.dev.yml`. |

**Files NOT picked up by `npm test`** (because the glob matches `*.test.js` only):
- `test/live-integration.js` — manual WebSocket-driven Node-RED end-to-end script.
- `test/run-examples.js` — manual examples-deployer + driver.

## Test File Organization

**Location:**
- All Mocha tests live in `test/` at the repo root, separate from sources (NOT co-located with `nodes/` or `lib/`).
- Runnable harness servers and bespoke integration scripts live in `test-server/`.

**Naming:**
- Mocha-discovered tests: `<subject>.test.js` (e.g. `opcua-utils.test.js`, `opcua-client-manager.test.js`).
- Manual scripts: bare `<purpose>.js` with a shebang or `'use strict'` (e.g. `live-integration.js`, `run-examples.js`).
- Integration / multi-component tests are still named `<thing>.test.js` (e.g. `integration-session-retry.test.js`) so they run under `npm test`.

**Existing suites and what they cover:**

| File | Lines | Purpose |
|---|---:|---|
| `test/opcua-utils.test.js` | 303 | Pure unit tests of `parseNodeId`, `nodeIdToString`, `parseDataType`, `createError`, `isValidEndpointUrl`, `WELL_KNOWN_NODES`. No mocks needed. |
| `test/opcua-client-manager.test.js` | 811 | `OpcUaClientManager` constructor defaults, `_createVariant`, `_toOpcUaNodeId`, `_ensureConnected`, plus inline tests of `serializeExtensionObject` from `lib/opcua-utils.js`. Stays away from real I/O. |
| `test/nodes-registration.test.js` | 54 | Smoke test that every `nodes/*.js` exports a function and registers exactly one type via `RED.nodes.registerType(...)`. Iterates over a fixed `NODE_FILES` array. |
| `test/opcua-item.test.js` | 342 | `opcua-item` collector / legacy modes, chaining behaviour, status badge content. |
| `test/opcua-nodes.test.js` | 501 | Node-level unit tests for `opcua-browser`, `opcua-method`, `opcua-event`, `opcua-server` (incl. issue #11 port-coercion regression). Uses `createRED({ ep1: createMockEndpoint(mockMgr) })`. |
| `test/connection-sharing.test.js` | 234 | Verifies refcount, status fan-out and close-cleanup of `opcua-endpoint`. Patches `Module._resolveFilename` to swap `OpcUaClientManager` for an in-memory mock. |
| `test/opcua-client-retry.test.js` | 538 | Retry envelope of `opcua-client` (session loss patterns, single-flight reconnect, non-session passthrough, status transitions, retry-on-readmultiple/write). Stub-only, no live server. |
| `test/integration-session-retry.test.js` | 370 | Boots a real in-process `OPCUAServer` on a random port and exercises real `OpcUaClientManager` + `opcua-client` retry: read → kill session → re-read; readMultiple; write. The only suite with real network I/O under `npm test`. |
| `test/live-integration.js` | 115 | Manual: connects to a running Node-RED + opcua-server stack via WebSocket `/comms`, triggers each example inject, asserts debug output. |
| `test/run-examples.js` | 223 | Manual: deploys every `examples/*.json` to a running Node-RED, runs each inject, reports pass/fail. |

## Test Structure

**Suite skeleton (newer 2-space style):**

```js
"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

describe("<subject>", function () {
  let mgr;

  beforeEach(function () {
    mgr = { /* sinon stub object */ };
  });

  it("should <do thing>", async function () {
    // Arrange
    mgr.read.resolves({ value: 42, statusCode: { toString: () => "Good" } });
    // Act
    const result = await mgr.read();
    // Assert
    expect(result.value).to.equal(42);
  });
});
```

**Section dividers** mirror the production code style:
```js
// ─── Constructor ───
// ─── _createVariant ───
// ─── _ensureConnected ───
```

**Test message style:** `it("should <verb phrase>", ...)`. Verb-first, present tense, descriptive of behaviour rather than implementation.

**Helpers are inline at the top of each test file.** No shared `test/helpers/` directory yet — `createRED()` and `createMockEndpoint()` are duplicated across `test/opcua-nodes.test.js`, `test/opcua-client-retry.test.js`, `test/integration-session-retry.test.js`, `test/connection-sharing.test.js`, `test/nodes-registration.test.js`, `test/opcua-item.test.js`. **Adding PubSub tests is a good time to extract a `test/helpers/red-mock.js` instead of copying these again.**

## Mocking Approach

The codebase uses **three distinct strategies**, picked per test goal:

### 1. Hand-rolled Node-RED mock (`createRED`)

Replaces `RED` for unit tests. Standard shape:

```js
function createRED(nodeOverrides) {
  const types = {};
  return {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = function (event, cb) {
          (node._events[event] = node._events[event] || []).push(cb);
        };
        node.status = sinon.stub();
        node.log    = sinon.stub();
        node.warn   = sinon.stub();
        node.error  = sinon.stub();
      },
      registerType(name, ctor, opts) { types[name] = { constructor: ctor, opts }; },
      getNode(id) { return nodeOverrides?.[id] || null; },
      _types: types,
    },
  };
}
```
References: `test/opcua-client-retry.test.js:9-33`, `test/opcua-nodes.test.js:9-35`, `test/integration-session-retry.test.js:22-46`.

This mock captures registered types and intercepted `node.on(...)` handlers as `node._events[event]` arrays so tests can `await node._events["input"][0](msg, send, done)` to drive the input handler synchronously.

### 2. `createMockEndpoint(mockMgr)`

Stand-in for the `opcua-endpoint` config node — what every consumer node calls into:

```js
function createMockEndpoint(mockMgr) {
  return {
    getSharedManager:        sinon.stub().returns(mockMgr),
    releaseSharedManager:    sinon.stub().resolves(),
    registerStatusCallback:  sinon.stub(),
    unregisterStatusCallback: sinon.stub(),
  };
}
```
The PubSub equivalent (if a separate config node is introduced) MUST have the same four methods so this helper can be reused.

### 3. `Module._resolveFilename` interception

For tests that need to swap a `require()` target without proxyquire — see `test/connection-sharing.test.js:43-62`. Pattern: replace the module path resolution to a sentinel, then stuff the mock into `require.cache[sentinel]`. Restored in `after()`.

Used to test `opcua-endpoint` against a `MockClientManager` class without real OPC UA dependencies.

### What is fully integration-tested (real OPC UA server)

- `test/integration-session-retry.test.js` boots a real `node-opcua` `OPCUAServer` on a random port (48400-49400 range), creates a few variables, then drives `OpcUaClientManager` and `opcua-client` against it. Closes the session manually with `await mgr.session.close()` to simulate network loss / server restart.
- `test-server/server.js` — full reference OPC UA server (1009 lines) with anonymous, username/password, and X509 user-token auth, all security modes/policies, methods, events. Designed to run alongside `docker compose up` and be pointed at by `test-server/test-client.js` and the live-integration / run-examples scripts.

### What is NOT mocked

- `node-opcua` itself is generally NOT stubbed in `test/opcua-client-manager.test.js`; instead the tests pick methods that don't need a live session (`_createVariant`, `_toOpcUaNodeId`, `_ensureConnected`).
- For `nodes/opcua-server.js` regression tests in `test/opcua-nodes.test.js:271-340`, `node-opcua` IS replaced via `require.cache` overwrite to capture the constructor options — useful pattern, currently single-use. PubSub tests for `OPCUAServer`/`Publisher` config coercion can reuse this technique.

## Fixtures and Factories

**No central fixtures directory.** Fixtures are created inline:
- Mock client manager objects: literal objects with sinon-stubbed methods (`mgr = { isConnected: true, connect: sinon.stub()...., read: sinon.stub() }`).
- DataValue-like return shapes: literal objects matching the node-opcua surface (`{ value: { value: 42, dataType: 6 }, statusCode: { value: 0, name: "Good", toString: () => "Good (0x00000000)" }, sourceTimestamp: new Date(), serverTimestamp: new Date() }` — see `test/opcua-client-retry.test.js:86-95`).
- ExtensionObject samples: built inline as plain objects with a `schema.fields` array (`test/opcua-client-manager.test.js:272-296`).
- Real `OPCUAServer` variables for the session-retry integration test are set up in `before()` with `addressSpace.getOwnNamespace().addVariable(...)` (`test/integration-session-retry.test.js:53-85`).

**For PubSub tests:** create per-suite fixture builders that return `dataset` / `dataSetMessage` / `networkMessage` shapes inline. Keep them adjacent to the `describe(...)` blocks until duplication justifies extraction.

## Coverage

**No coverage tooling is configured.** No `nyc`, `c8`, or `jest --coverage` setup; `.nyc_output` and `coverage/` are listed in `.gitignore` but not produced by any script.

**Current state (qualitative, 2026-05-08):**
- `lib/opcua-utils.js` — comprehensively covered by `test/opcua-utils.test.js` and `test/opcua-client-manager.test.js`.
- `lib/opcua-client-manager.js` — pure helpers covered (`_createVariant`, `_toOpcUaNodeId`, `_ensureConnected`); read/write/method/history/browse paths covered indirectly via the integration-session-retry suite. Subscription, registerNodes/unregisterNodes, translateBrowsePath, getEndpoints, `_createExtensionObjectVariant` lack direct unit tests.
- `nodes/opcua-client.js` — retry/reconnect logic well covered by `opcua-client-retry.test.js` (538 lines). Subscription `handleSubscribe`/`handleUnsubscribe` and `handleHistory` paths have minimal coverage.
- `nodes/opcua-endpoint.js` — refcount, status fan-out, close cleanup covered.
- `nodes/opcua-item.js` — collector vs legacy modes covered.
- `nodes/opcua-server.js` — registration smoke test + issue #11 port-coercion regression. Address-space command handlers (`addFolder`/`addVariable`/`addMethod`/`raiseEvent`) are NOT unit-tested (only via `test-server/test-client.js` against a live server).
- `nodes/opcua-event.js`, `nodes/opcua-method.js`, `nodes/opcua-browser.js` — register-and-status smoke tests; happy path covered for browse and method-call. Event subscription path is exercised only manually.
- `nodes/opcua-browse-client.js` — NOT covered by any unit test. The 60-second editor-side browse-connection cache (`browseConnections` Map at `nodes/opcua-browse-client.js:22-80`) is the largest untested block in the suite.

## Common Patterns

### Driving a node's input handler synchronously

```js
const node = {};
ctor.call(node, { id: "n1", endpoint: "ep1" /* + node config */ });
const inputHandler = node._events["input"][0];
const send = sinon.stub();
const done = sinon.stub();
await inputHandler(msg, send, done);

expect(send.calledOnce).to.be.true;
expect(send.firstCall.args[0].payload).to.equal(...);
expect(done.calledOnce).to.be.true;
```
Reference: `test/opcua-client-retry.test.js:113-131`, `test/opcua-nodes.test.js:74-91`.

### Re-loading a node module per test

Required because each `module.exports = function(RED) { ... }` mutates the shared `RED` mock; clearing the cache forces a fresh registration:

```js
const p = path.resolve(__dirname, "..", "nodes", "opcua-client.js");
delete require.cache[require.resolve(p)];
require(p)(RED);
```
Reference: `test/integration-session-retry.test.js:189-193`, `test/nodes-registration.test.js:46-48`.

### Async error testing

```js
let threw = false;
try { await mgr.readMultiple(["ns=1;s=TestInt"]); }
catch (e) {
  threw = true;
  expect(e.message).to.match(/Session is no longer valid|Not connected/);
}
expect(threw).to.be.true;
```
Reference: `test/integration-session-retry.test.js:151-158`.

For sync-throwing functions:
```js
expect(() => mgr._ensureConnected()).to.throw("Not connected");
```
Reference: `test/opcua-client-manager.test.js:186`.

### Status-transition assertions

```js
const statusCalls = node.status.args.map((a) => a[0]);
const yellowIdx = statusCalls.findIndex(
  (s) => s.fill === "yellow" && s.text === "reconnecting...",
);
const greenIdx = statusCalls.findLastIndex(
  (s) => s.fill === "green" && s.text === "connected",
);
expect(yellowIdx).to.be.at.least(0);
expect(greenIdx).to.be.greaterThan(yellowIdx);
```
Reference: `test/integration-session-retry.test.js:237-245`.

### `before` / `after` server lifecycle

```js
before(async function () {
  server = new OPCUAServer({ port: PORT, ... });
  await server.initialize();
  // ... addressSpace setup ...
  await server.start();
});
after(async function () { if (server) await server.shutdown(); });
```
Reference: `test/integration-session-retry.test.js:53-91`. The PubSub equivalent will need its own port / multicast group setup in `before` — keep them on randomised numbers (e.g. `48400 + Math.floor(Math.random() * 1000)`) to avoid collisions with locally running servers.

## Known Gaps That PubSub Work Will Need to Fill

The PubSub milestone introduces UDP / UDP-multicast (and possibly MQTT/AMQP) transports. Several pieces of the current testing setup do not extend trivially:

1. **No UDP / multicast test harness.** `test-server/server.js` and `test/integration-session-retry.test.js` both start `OPCUAServer` over TCP only; there is no equivalent helper for binding a UDP socket on a randomised port, joining a multicast group, or capturing emitted datagrams. PubSub work should add `test-server/pubsub-server.js` (or an in-process helper similar to the `before()` block in `integration-session-retry.test.js`) for both publisher and subscriber roles. Use Node's built-in `dgram` module for UDP.
2. **No multicast-friendly CI environment.** GitHub Actions runners do not always allow IP multicast. PubSub integration tests SHOULD prefer unicast UDP loopback (`127.0.0.1`) where possible, and fall back to multicast only behind an env-flag (e.g. `process.env.PUBSUB_MULTICAST === "1"`) so default `npm test` stays portable.
3. **No way to test message encoding/decoding round-trips today.** Plan to add a unit suite `test/opcua-pubsub-encoder.test.js` covering DataSetMessage / NetworkMessage UADP encoding (round-trip Buffer → struct → Buffer) — pure-function tests, no I/O.
4. **No `dgram` mocking pattern in use.** Sinon-stubbed `dgram.Socket` will be needed; consider extracting a thin transport adapter so unit tests can inject a fake socket without `Module._resolveFilename` patching.
5. **No throughput/latency benchmarks.** Optional: add a `test-server/pubsub-bench.js` runnable for measuring publish→receive latency, mirroring `test-server/test-client.js`'s approach.
6. **`createRED()` mock duplication.** Already discussed under Test Structure — extract before the suite grows by 2-3 new files.
7. **Coverage gate.** Recommend wiring `c8` into the `test` script (no behaviour change; just emits coverage) so PubSub additions can be reviewed against measured coverage rather than visual inspection.
8. **`run-examples.js` and `live-integration.js`** assume a single OPC UA TCP endpoint per Node-RED instance. When PubSub examples are added to `examples/`, both runners will need extension to drive the publisher first, give the subscriber time to bind, and then assert received DataSetMessages.
9. **No per-file `.eslintrc.json` or `.prettierrc.json`.** PubSub modules will inherit ESLint and Prettier defaults — add a project-root config (2-space, double quotes, semi, trailing commas) before introducing PubSub if uniform formatting matters.

---

*Testing analysis: 2026-05-08*

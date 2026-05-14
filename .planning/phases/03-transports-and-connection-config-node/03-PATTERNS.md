# Phase 3: Transports and Connection Config Node — Pattern Map

**Mapped:** 2026-05-13
**Files analyzed:** 10 (8 new files + 1 modified + 1 directory boundary)
**Analogs found:** 9 / 10

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `lib/transports/base-transport.js` | utility/abstract-class | event-driven | `lib/opcua-client-manager.js` | role-match (EventEmitter skeleton) |
| `lib/transports/udp-transport.js` | service | event-driven + streaming | `lib/opcua-client-manager.js` | role-match (lifecycle state machine) |
| `lib/transports/mqtt-transport.js` | service | event-driven + request-response | `lib/opcua-client-manager.js` | role-match (lifecycle + event mapping) |
| `nodes/opcua-pubsub-connection.js` | config-node | request-response | `nodes/opcua-endpoint.js` | exact (ref-count + fan-out pattern) |
| `nodes/opcua-pubsub-connection.html` | component/UI | request-response | `nodes/opcua-endpoint.html` | exact (config-node editor structure) |
| `test/transports/base-transport.test.js` | test | — | `test/uadp-encoder.test.js` | role-match (throw-assertion pattern) |
| `test/transports/udp-transport.test.js` | test | event-driven | `test/opcua-client-manager.test.js` | role-match (sinon fake timers) |
| `test/transports/mqtt-transport.test.js` | test | event-driven | `test/connection-sharing.test.js` | role-match (mock-inject + spy) |
| `test/opcua-pubsub-connection.test.js` | test | request-response | `test/connection-sharing.test.js` | exact (createRED mock + ref-count assertions) |
| `package.json` | config | — | `package.json` itself | exact (caret range style) |

---

## Pattern Assignments

### `lib/transports/base-transport.js` (abstract class, event-driven)

**Analog:** `lib/opcua-client-manager.js`

**Imports pattern** (lines 40-42):
```javascript
const EventEmitter = require("events");
```

**Module banner pattern** (`lib/cert-store.js` lines 1-21):
```javascript
/**
 * Base Transport
 *
 * Abstract base class for OPC UA PubSub transport adapters.
 * ...
 *
 * Exports:
 *   BaseTransport   — ES6 abstract class extending EventEmitter
 */

"use strict";
```

**Core class skeleton** (`lib/opcua-client-manager.js` lines 40-63, adapted):
```javascript
const EventEmitter = require("events");

class BaseTransport extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
  }

  /** @abstract */
  async connect() {
    throw new Error("BaseTransport.connect() not implemented");
  }

  /** @abstract */
  async close() {
    throw new Error("BaseTransport.close() not implemented");
  }

  /**
   * @abstract
   * @param {Buffer|Buffer[]} payload
   * @param {Object} [opts]
   */
  send(payload, opts) {
    throw new Error("BaseTransport.send() not implemented");
  }
}

module.exports = { BaseTransport };
```

**Rationale:** `OpcUaClientManager` extends `EventEmitter` with the same constructor pattern (`super()`, `this.config = config`). The abstract guard pattern (`throw new Error("... not implemented")`) is novel — no existing analog — but aligns with the fail-fast principle from `lib/uadp-encoder.js` createError usage.

---

### `lib/transports/udp-transport.js` (service, event-driven + streaming)

**Analog:** `lib/opcua-client-manager.js`

**Imports pattern** (lines 40-42 + Phase 2 style from `lib/uadp-encoder.js` lines 28-30):
```javascript
"use strict";

const { BaseTransport } = require("./base-transport");
const { createError } = require("../opcua-utils");
const dgram = require("dgram");
```

**Constructor pattern** (`lib/opcua-client-manager.js` lines 48-63):
```javascript
class UdpTransport extends BaseTransport {
  constructor(config) {
    super(config);
    // config: { port, multicastGroup, multicastInterface, mtu }
    this._socket = null;
    this._chunks = new Map();   // chunk reassembly buffer — keyed by publisherId|writerGroupId|seqNum
  }
}
```

**Internal state initialization pattern** (mirrors `lib/opcua-client-manager.js` lines 53-63 — named private fields, null sentinels):
```javascript
// OpcUaClientManager pattern to mirror:
this.client = null;
this.session = null;
this.isConnected = false;
this.reconnectTimer = null;
// → UdpTransport equivalent:
this._socket = null;
this._chunks = new Map();
```

**connect() lifecycle promise pattern** (`lib/opcua-client-manager.js` lines 198-322, condensed async flow):
```javascript
async connect() {
  if (this._socket) return;    // idempotent — mirrors isConnected guard line 199
  return new Promise((resolve, reject) => {
    this._socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this._socket.on("error", (err) => {
      this.emit("error", createError(`UDP_SOCKET_ERROR: ${err.message}`));
    });
    this._socket.on("message", (buf, rinfo) => {
      const complete = this._reassemble(buf);
      if (complete) this.emit("message", complete);
    });
    this._socket.bind({ port: this.config.port, address: "0.0.0.0" }, () => {
      // addMembership MUST be inside bind callback — VERIFIED in RESEARCH.md
      this._socket.addMembership(
        this.config.multicastGroup,
        this.config.multicastInterface || "0.0.0.0"
      );
      this._socket.setMulticastLoopback(true);
      this._socket.setMulticastTTL(128);
      this.emit("connected");
      resolve();
    });
  });
}
```

**disconnect() pattern** (`lib/opcua-client-manager.js` lines 324-359 — null-out + emit):
```javascript
async close() {
  return new Promise((resolve) => {
    if (!this._socket) return resolve();
    this._socket.close(() => {
      this._socket = null;
      this.emit("disconnected");
      resolve();
    });
  });
}
```

**Error code naming** (`lib/uadp-encoder.js` line 30 — `createError("UADP_...")`):
```javascript
// Pattern: PREFIX_ISSUE
createError(`UDP_BIND_FAILED: ${err.message}`)
createError(`UDP_SEND_ERROR: ${err.message}`)
createError(`UDP_SOCKET_ERROR: ${err.message}`)
```

**Novel: Chunk reassembly (`_reassemble`)** — No existing analog in codebase. Design from RESEARCH.md Pattern 4. Key: `${publisherId}|${writerGroupId}|${sequenceNumber}`, 30 s expiry swept on every receive via `Date.now()` comparison on the `_chunks` Map. See RESEARCH.md §Pattern 4 for full implementation.

**Novel: `send(Buffer|Buffer[])` with Array.isArray dispatch** — No existing analog. Design from RESEARCH.md Pattern 3 (D-02 decision).

---

### `lib/transports/mqtt-transport.js` (service, event-driven + request-response)

**Analog:** `lib/opcua-client-manager.js`

**Imports pattern** (lines 40-42 + uadp-encoder.js style):
```javascript
"use strict";

const { BaseTransport } = require("./base-transport");
const { createError } = require("../opcua-utils");
const mqtt = require("mqtt");
```

**Constructor pattern** (`lib/opcua-client-manager.js` lines 48-63):
```javascript
class MqttTransport extends BaseTransport {
  constructor(config) {
    super(config);
    // config: { brokerUrl, qos, topicPrefix, username, password, reconnectPeriod }
    this._client = null;
    this._protocolFallbackDone = false;
  }
}
```

**Event mapping pattern** (`lib/opcua-client-manager.js` lines 272-301 — native events → emitted events):
```javascript
// OpcUaClientManager maps client events to its own emits:
this.client.on("start_reconnection", () => { this.emit("reconnecting"); });
this.client.on("connection_lost",    () => { this.isConnected = false; this.emit("disconnected"); });
this.client.on("after_reconnection", async () => { ... this.emit("connected"); });

// MqttTransport mirrors this 1:1:
this._client.on("connect",    () => { this.emit("connected"); resolve(); });
this._client.on("close",      () => { this.emit("disconnected"); });
this._client.on("reconnect",  () => { this.emit("reconnecting"); });
this._client.on("error",      (err) => { this.emit("error", err); });
this._client.on("message",    (topic, payload, packet) => {
  this.emit("message", payload, { topic, packet });
});
```

**Graceful close pattern** (`lib/opcua-client-manager.js` lines 324-359 — null-out after async teardown):
```javascript
async close() {
  return new Promise((resolve) => {
    if (!this._client) return resolve();
    this._client.end(false, {}, () => {
      this._client = null;
      resolve();
      // Note: 'disconnected' is emitted via the 'close' event listener above
    });
  });
}
```

**Error code naming** (`lib/uadp-encoder.js` line 30 pattern):
```javascript
createError(`MQTT_CONNECT_TIMEOUT: ${err.message}`)
createError(`MQTT_PUBLISH_ERROR: ${err.message}`)
```

**Novel: MQTT 5.0 → 3.1.1 fallback** — No existing analog. Design from RESEARCH.md Pattern 5. `_protocolFallbackDone` flag prevents infinite loop; first connect attempt uses `protocolVersion: 5`; on error with protocol-related message, call `client.end(true, {}, cb)` then retry with `protocolVersion: 4`.

**Novel: `retain: false` hard-coded in `send()`** — Design from RESEARCH.md Pattern 6. `retain` is NEVER caller-overridable per D-16.

---

### `nodes/opcua-pubsub-connection.js` (config-node, request-response)

**Analog:** `nodes/opcua-endpoint.js` — THE primary template. Mirror the entire structure.

**Imports pattern** (`nodes/opcua-endpoint.js` lines 1-10):
```javascript
const { registerCertRoutes, getCertsDir } = require("../lib/cert-store");
// + transport-specific:
const { UdpTransport }  = require("../lib/transports/udp-transport");
const { MqttTransport } = require("../lib/transports/mqtt-transport");
const { BaseTransport } = require("../lib/transports/base-transport");
const crypto = require("crypto");
```

**Module wrapper + cert route registration** (`nodes/opcua-endpoint.js` lines 11-18):
```javascript
module.exports = function(RED) {
  registerCertRoutes(RED, "/opcua-pubsub-connection", getCertsDir(RED));

  function OpcUaPubSubConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    // ...
  }

  RED.nodes.registerType("opcua-pubsub-connection", OpcUaPubSubConnectionNode, {
    credentials: {
      userName: { type: "text" },
      password: { type: "password" }
    }
  });
};
```

**Grace timer constant** — Defined at top of file, outside all functions (mirrors `RECONNECT_BASE_DELAY_MS` constant at `lib/opcua-client-manager.js` line 45):
```javascript
const RECONNECT_GRACE_MS = 500;
```

**Shared instance initialization** (`nodes/opcua-endpoint.js` lines 39-42):
```javascript
// opcua-endpoint.js pattern (lines 39-42):
node._sharedManager = null;
node._refCount = 0;
node._statusCallbacks = new Set();

// Phase 3 equivalent — add _graceTimer:
node._sharedTransport = null;
node._refCount = 0;
node._graceTimer = null;
node._statusCallbacks = new Set();
```

**acquireTransport() — ref-count + status fan-out** (`nodes/opcua-endpoint.js` lines 64-110, with grace-timer addition per D-06):
```javascript
// Core fan-out pattern from opcua-endpoint.js lines 92-104:
node._sharedManager.on("connected",    () => { node._statusCallbacks.forEach(cb => cb("connected")); });
node._sharedManager.on("disconnected", () => { node._statusCallbacks.forEach(cb => cb("disconnected")); });
node._sharedManager.on("reconnecting", () => { node._statusCallbacks.forEach(cb => cb("reconnecting")); });
node._sharedManager.on("error",  (e)  => { node._statusCallbacks.forEach(cb => cb("error", e)); });

// Phase 3 acquireTransport ADDS grace timer cancel at the top (D-06):
node.acquireTransport = function() {
  if (node._graceTimer) {                     // D-06: cancel if reacquire within grace window
    clearTimeout(node._graceTimer);
    node._graceTimer = null;
  }
  node._refCount++;
  node.log(`Transport ref +1 (now ${node._refCount})`);
  if (!node._sharedTransport) {
    node._sharedTransport = _createTransport(node);
    node._sharedTransport.on("connected",    () => node._statusCallbacks.forEach(cb => cb("connected")));
    node._sharedTransport.on("disconnected", () => node._statusCallbacks.forEach(cb => cb("disconnected")));
    node._sharedTransport.on("reconnecting", () => node._statusCallbacks.forEach(cb => cb("reconnecting")));
    node._sharedTransport.on("error",   (e) => node._statusCallbacks.forEach(cb => cb("error", e)));
    node._sharedTransport.connect().catch(err => node._statusCallbacks.forEach(cb => cb("error", err)));
  }
  return node._sharedTransport;
};
```

**releaseTransport() — grace timer on last release** (`nodes/opcua-endpoint.js` lines 126-138, with grace timer replacing immediate disconnect per D-05):
```javascript
// opcua-endpoint.js releaseSharedManager (lines 126-138) — immediate disconnect:
node.releaseSharedManager = async function() {
  node._refCount = Math.max(0, node._refCount - 1);
  if (node._refCount === 0 && node._sharedManager) {
    try { await node._sharedManager.disconnect(); } catch (e) { /* ignore */ }
    node._sharedManager = null;
    node._statusCallbacks.clear();
  }
};

// Phase 3 REPLACES immediate disconnect with grace timer (D-05):
node.releaseTransport = function() {
  node._refCount = Math.max(0, node._refCount - 1);
  node.log(`Transport ref -1 (now ${node._refCount})`);
  if (node._refCount === 0 && node._sharedTransport) {
    node._graceTimer = setTimeout(() => {
      node._graceTimer = null;
      if (node._sharedTransport) {
        node._sharedTransport.close().catch(() => {});
        node._sharedTransport = null;
        node._statusCallbacks.clear();
      }
    }, RECONNECT_GRACE_MS);
  }
};
```

**registerStatusCallback / unregisterStatusCallback** (`nodes/opcua-endpoint.js` lines 112-121 — exact copy, rename only):
```javascript
// opcua-endpoint.js lines 112-121:
node.registerStatusCallback = function(callback) {
  node._statusCallbacks.add(callback);
};
node.unregisterStatusCallback = function(callback) {
  node._statusCallbacks.delete(callback);
};
```

**node.on('close') shutdown handler** (`nodes/opcua-endpoint.js` lines 140-149, with grace timer cancel added):
```javascript
// opcua-endpoint.js lines 140-149:
node.on("close", async function(done) {
  if (node._sharedManager) {
    try { await node._sharedManager.disconnect(); } catch (e) { /* ignore */ }
    node._sharedManager = null;
  }
  node._refCount = 0;
  node._statusCallbacks.clear();
  done();
});

// Phase 3 version ADDS grace timer cancel before transport close:
node.on("close", async function(done) {
  if (node._graceTimer) { clearTimeout(node._graceTimer); node._graceTimer = null; }
  if (node._sharedTransport) {
    try { await node._sharedTransport.close(); } catch (e) { /* ignore */ }
    node._sharedTransport = null;
  }
  node._refCount = 0;
  node._statusCallbacks.clear();
  done();
});
```

**RED.nodes.registerType with credentials** (`nodes/opcua-endpoint.js` lines 152-157):
```javascript
RED.nodes.registerType("opcua-pubsub-connection", OpcUaPubSubConnectionNode, {
  credentials: {
    userName: { type: "text" },
    password: { type: "password" }
  }
});
```

---

### `nodes/opcua-pubsub-connection.html` (component/UI, request-response)

**Analog:** `nodes/opcua-endpoint.html`

**CERT_ROUTE_PREFIX constant** (`nodes/opcua-endpoint.html` line 4 — WITHOUT leading slash, browser relative URL):
```javascript
var CERT_ROUTE_PREFIX = "opcua-pubsub-connection";  // no leading slash
```

**RED.nodes.registerType config skeleton** (`nodes/opcua-endpoint.html` lines 6-30):
```javascript
RED.nodes.registerType("opcua-pubsub-connection", {
  category: "config",
  color: "#2e7d9a",            // distinct from opcua-endpoint #3a8cba
  defaults: {
    name:               { value: "" },
    transportType:      { value: "udp" },
    // UDP fields:
    multicastGroup:     { value: "239.0.0.1" },
    multicastInterface: { value: "0.0.0.0" },
    port:               { value: 4840 },
    // MQTT fields:
    brokerUrl:          { value: "mqtt://localhost:1883" },
    topicPrefix:        { value: "ua" },
    qos:                { value: 1 },
    // PublisherId:
    publisherIdType:    { value: "String" },
    publisherId:        { value: "" },          // set to randomUUID in oneditprepare
    // Cert placeholders (hidden — for Phase 3.1 mTLS, schema stability per RESEARCH.md A1):
    certificateFile:    { value: "" },
    privateKeyFile:     { value: "" },
    caCertificateFile:  { value: "" }
  },
  credentials: {
    userName: { type: "text" },
    password: { type: "password" }
  },
  icon: "opcua.svg",
  label: function() { return this.name || "OPC UA PubSub Connection"; },
  // ...
```

**oneditprepare — transport-conditional field visibility** (`nodes/opcua-endpoint.html` lines 31-53 — updateSecurityUI pattern):
```javascript
// opcua-endpoint.html oneditprepare shows/hides cert section based on security mode:
function updateSecurityUI() {
  var mode = $("#node-config-input-securityMode").val();
  var $section = $("#cert-transport-section");
  if (mode === "None") { $section.slideUp(200); } else { $section.slideDown(200); }
}
$("#node-config-input-securityMode").on("change", updateSecurityUI);
updateSecurityUI();

// Phase 3 equivalent for transport type:
function updateTransportUI() {
  var type = $("#node-config-input-transportType").val();
  if (type === "mqtt") {
    $("#mqtt-section").show();
    $("#udp-section").hide();
  } else {
    $("#udp-section").show();
    $("#mqtt-section").hide();
  }
}
$("#node-config-input-transportType").on("change", updateTransportUI);
updateTransportUI();
```

**Collapsible sections** (`nodes/opcua-endpoint.html` lines 47-53):
```javascript
$(".opcua-section-header").on("click", function() {
  var $body = $(this).next(".opcua-section-body");
  var $icon = $(this).find(".opcua-collapse-icon");
  $body.slideToggle(200);
  $icon.toggleClass("fa-chevron-down fa-chevron-right");
});
```

**setupCertUpload drag-drop function** (`nodes/opcua-endpoint.html` lines 56-141 — copy verbatim, change only `CERT_ROUTE_PREFIX`):
The entire `setupCertUpload(dropzoneId, inputId)` function is reusable as-is. The only change is `CERT_ROUTE_PREFIX = "opcua-pubsub-connection"` at line 4 of the script block.

**Dropzone HTML structure** (`nodes/opcua-endpoint.html` lines 384-416 — one dropzone element):
```html
<input type="hidden" id="node-config-input-certificateFile">
<div class="cert-dropzone" id="dropzone-cert">
  <i class="fa fa-cloud-upload cert-icon"></i>
  <div class="cert-info">
    <span class="cert-label">Client Certificate</span>
    <span class="cert-status">Drop file here or click to select</span>
  </div>
  <span class="cert-clear"><i class="fa fa-times"></i></span>
  <input type="file" class="cert-file-input" accept=".pem,.der,.crt,.cer">
</div>
```

**CSS — all dropzone styles** (`nodes/opcua-endpoint.html` lines 159-317) — copy verbatim. These are not prefixed and will apply to any `.cert-dropzone` in the page. No changes needed.

---

### `test/transports/base-transport.test.js` (test, throw-assertions)

**Analog:** `test/uadp-encoder.test.js` (Mocha describe/it skeleton with chai expect)

**File header pattern** (`test/uadp-encoder.test.js` lines 1-4):
```javascript
"use strict";

const { expect } = require("chai");
const { BaseTransport } = require("../../lib/transports/base-transport");
```

**Throw-test pattern** (`test/uadp-encoder.test.js` lines 21-34 — expect throw for invalid input):
```javascript
describe("base-transport — abstract method guards", function () {
  it("connect() throws 'not implemented'", function () {
    const t = new BaseTransport({});
    return t.connect().then(
      () => { throw new Error("should have thrown"); },
      (err) => { expect(err.message).to.match(/not implemented/i); }
    );
  });

  it("close() throws 'not implemented'", function () {
    // Same pattern as connect()
  });

  it("send() throws 'not implemented' synchronously", function () {
    const t = new BaseTransport({});
    expect(() => t.send(Buffer.alloc(0))).to.throw(/not implemented/i);
  });
});
```

---

### `test/transports/udp-transport.test.js` (test, event-driven)

**Analog:** `test/opcua-client-manager.test.js` (sinon fake timers for timer-dependent behavior)

**Fake timer pattern** (`test/opcua-client-manager.test.js` lines 759-773):
```javascript
let clock;

beforeEach(function () {
  clock = sinon.useFakeTimers();
});

afterEach(function () {
  clock.restore();
  // clear any lingering timers
});
```

**File header + import pattern** (`test/uadp-encoder.test.js` lines 1-4, `test/cert-store.test.js` lines 1-17):
```javascript
"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const { UdpTransport } = require("../../lib/transports/udp-transport");
```

**20-cycle EADDRINUSE test pattern** (novel — design from RESEARCH.md Code Examples §Rapid Bind/Close Cycle):
```javascript
// No existing analog — use RESEARCH.md verified pattern:
function cycle(n, port, done) {
  if (n === 0) return done(null);
  const transport = new UdpTransport({
    port, multicastGroup: "239.0.0.1", multicastInterface: "0.0.0.0"
  });
  transport.connect()
    .then(() => transport.close())
    .then(() => cycle(n - 1, port, done))
    .catch(done);
}

it("should complete 20 rapid bind/close cycles without EADDRINUSE", function(done) {
  this.timeout(10000);
  cycle(20, 45678 + Math.floor(Math.random() * 1000), done);
});
```

---

### `test/transports/mqtt-transport.test.js` (test, event-driven)

**Analog:** `test/connection-sharing.test.js` (Module._resolveFilename mock injection pattern)

**require mock injection** (`test/connection-sharing.test.js` lines 20-57):
```javascript
// connection-sharing.test.js lines 20-57 — patch require to inject mock:
const Module = require("module");
const originalResolve = Module._resolveFilename;

before(function() {
  Module._resolveFilename = function(request, parent) {
    if (request === "mqtt") {
      return "mock-mqtt";
    }
    return originalResolve.apply(this, arguments);
  };
  require.cache["mock-mqtt"] = {
    id: "mock-mqtt", filename: "mock-mqtt", loaded: true,
    exports: MockMqttClient
  };
});

after(function() {
  Module._resolveFilename = originalResolve;
  delete require.cache["mock-mqtt"];
});
```

**retain=false assertion pattern** (novel — spy on mock publish; assert options object):
```javascript
it("should NEVER publish with retain: true regardless of opts", function() {
  const publishSpy = sinon.spy(mockClient, "publish");
  transport.send(Buffer.from("test"), { retain: true });  // caller tries to override
  const publishOpts = publishSpy.firstCall.args[2];
  expect(publishOpts.retain).to.equal(false);  // hard-coded wins
});
```

---

### `test/opcua-pubsub-connection.test.js` (test, request-response)

**Analog:** `test/connection-sharing.test.js` — THE primary template. Mirror the entire test structure.

**createRED() mock** (`test/connection-sharing.test.js` lines 25-37):
```javascript
// connection-sharing.test.js lines 25-37 — hand-rolled RED mock:
function createRED() {
  const nodes = {};
  const types = {};
  return {
    nodes: {
      createNode: function(node, config) { Object.assign(node, config); node._events = {}; },
      registerType: function(name, ctor, opts) { types[name] = { constructor: ctor, opts }; },
      getNode: function(id) { return nodes[id] || null; },
      _types: types,
      _nodes: nodes
    }
  };
}
```

**createNode simulation** (`test/connection-sharing.test.js` lines 74-94 — createEndpoint function):
```javascript
// connection-sharing.test.js lines 74-94 — simulate RED.nodes.createNode:
function createConnectionNode(overrides) {
  const config = {
    id: "conn1",
    type: "opcua-pubsub-connection",
    transportType: "udp",
    multicastGroup: "239.0.0.1",
    port: 4840,
    publisherIdType: "String",
    publisherId: "test-id",
    ...overrides
  };
  const node = {};
  Object.assign(node, config);
  node._events = {};
  node.on = function(event, cb) {
    (node._events[event] = node._events[event] || []).push(cb);
  };
  node.log = sinon.stub();
  node.warn = sinon.stub();
  node.error = sinon.stub();
  node.credentials = {};
  connectionCtor.call(node, config);
  return node;
}
```

**ref-count assertions** (`test/connection-sharing.test.js` lines 96-128 — getSharedManager describe block):
```javascript
// Mirror these assertion patterns from connection-sharing.test.js:
it("should increment refCount on acquire", function () { ... });
it("should return same transport on re-acquire within grace window", function () { ... });
it("should cancel grace timer on re-acquire", function (done) { ... });
```

**sinon fake timers for grace timer test** (`test/opcua-client-manager.test.js` lines 759-773 pattern):
```javascript
let clock;
beforeEach(function() { clock = sinon.useFakeTimers(); });
afterEach(function()  { clock.restore(); });

it("should close transport after 500ms grace period", function(done) {
  const node = createConnectionNode();
  const transport = node.acquireTransport();
  node.releaseTransport();
  expect(node._sharedTransport).to.exist;  // still alive within grace window
  clock.tick(501);
  expect(node._sharedTransport).to.be.null; // closed after grace period
  done();
});
```

**close handler test** (`test/connection-sharing.test.js` lines 215-233 — simulate close event):
```javascript
// connection-sharing.test.js lines 215-233:
const closeFn = ep._events["close"] && ep._events["close"][0];
expect(closeFn).to.be.a("function");
await new Promise(resolve => closeFn(resolve));
```

---

### `package.json` (config, modification)

**Analog:** `package.json` itself (lines 35-37 — caret range style for `node-opcua`):
```json
"dependencies": {
  "node-opcua": "^2.115.0"
}
```

**Pattern to apply:** Add `mqtt` with the same caret range style:
```json
"dependencies": {
  "node-opcua": "^2.115.0",
  "mqtt": "^5.15.1"
}
```

Alphabetical ordering within the object is not enforced (only `node-opcua` exists currently). Adding `mqtt` after `node-opcua` is acceptable.

---

## Shared Patterns

### "use strict" + double quotes + 2-space indent
**Source:** `lib/uadp-encoder.js` (line 28), `lib/cert-store.js` (line 23), `nodes/opcua-endpoint.js` (line 7)
**Apply to:** ALL new `.js` files
```javascript
"use strict";
// ...all strings use double quotes, 2-space indentation
```

### JSDoc banner on every exported entity
**Source:** `lib/cert-store.js` (lines 1-21 file banner; lines 31-37, 42-58 per-function JSDoc)
**Apply to:** `lib/transports/base-transport.js`, `lib/transports/udp-transport.js`, `lib/transports/mqtt-transport.js`
```javascript
/**
 * Method name
 *
 * @param {Type} paramName  description
 * @returns {ReturnType}    description
 */
```

### `createError` for structured error objects
**Source:** `lib/opcua-utils.js` lines 155-161; used in `lib/uadp-encoder.js` line 30
**Apply to:** `lib/transports/udp-transport.js`, `lib/transports/mqtt-transport.js`
```javascript
const { createError } = require("../opcua-utils");
// Usage:
throw createError("UDP_BIND_FAILED: port already in use");
this.emit("error", createError(`MQTT_PUBLISH_ERROR: ${err.message}`));
```
Note: `createError` returns an object `{ message, error, stack }`, NOT a real `Error` instance. It is used as an argument to `this.emit("error", ...)`, not as a thrown Error. Confirm whether throwing vs emitting is correct per the calling context.

### `registerCertRoutes` call pattern
**Source:** `nodes/opcua-endpoint.js` lines 16-17
**Apply to:** `nodes/opcua-pubsub-connection.js`
```javascript
registerCertRoutes(RED, "/opcua-pubsub-connection", getCertsDir(RED));
// Called OUTSIDE the constructor, at module load time (top of module.exports function)
```

### Status callback fan-out (Set + forEach)
**Source:** `nodes/opcua-endpoint.js` lines 92-104
**Apply to:** `nodes/opcua-pubsub-connection.js` (acquireTransport transport event listeners)
```javascript
node._statusCallbacks.forEach(cb => cb("connected"));
node._statusCallbacks.forEach(cb => cb("error", e));
```

### Mocha test file structure
**Source:** `test/cert-store.test.js` lines 1-53, `test/connection-sharing.test.js` lines 1-37
**Apply to:** All new `test/**/*.test.js` files
```javascript
"use strict";

const { expect } = require("chai");
const sinon = require("sinon");

describe("module-name — feature", function () {
  beforeEach(function () { /* setup */ });
  afterEach(function ()  { /* teardown */ });

  describe("method()", function () {
    it("should ...", function () {
      expect(...).to.equal(...);
    });
  });
});
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `lib/transports/udp-transport.js` — `_reassemble()` method | utility | streaming | No chunk-reassembly logic exists in the codebase. Design from RESEARCH.md Pattern 4. |
| `lib/transports/mqtt-transport.js` — `_connectWithFallback()` / MQTT 5.0→3.1.1 retry | service | request-response | No protocol-version fallback pattern exists. Design from RESEARCH.md Pattern 5 + Open Question 1. |
| `lib/transports/udp-transport.js` / `mqtt-transport.js` — `send(Buffer|Buffer[])` with Array dispatch | utility | streaming | No Array.isArray dispatch exists on send paths. Design from RESEARCH.md Pattern 3 (D-02 decision). |
| `test/transports/` directory | — | — | No `test/transports/` subdirectory exists. `npm test` glob `test/**/*.test.js` auto-discovers it. |

---

## Metadata

**Analog search scope:** `lib/`, `nodes/`, `test/`
**Files scanned:** 9 source files read in full; 4 additional grep passes for pattern confirmation
**Pattern extraction date:** 2026-05-13

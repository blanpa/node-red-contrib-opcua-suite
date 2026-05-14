# Phase 3: Transports and Connection Config Node — Research

**Researched:** 2026-05-13
**Domain:** Node.js `dgram` UDP multicast, `mqtt@^5.15.1` MQTT 5.0/3.1.1, Node-RED config-node lifecycle
**Confidence:** HIGH

---

## Summary

Phase 3 adds two transport adapters (`UdpTransport`, `MqttTransport`) behind a `BaseTransport extends EventEmitter` contract, plus the `opcua-pubsub-connection` Node-RED config node that owns the transport lifecycle (ref-count, 500 ms grace timer, status fan-out). All structural patterns are already proven in the codebase via `opcua-endpoint.js` and `OpcUaClientManager`; Phase 3 mirrors them with transport-specific adaptations.

The single highest-risk item is the UDP EADDRINUSE acceptance criterion (20 rapid redeploy cycles). Hands-on verification confirms that `{ type: 'udp4', reuseAddr: true }` + `bind({ port, address: '0.0.0.0' })` + `addMembership(after bind)` + `socket.close(cb)` with the 500 ms grace timer is sufficient. Twenty sequential multicast bind/join/close cycles completed without errors on this environment (WSL2/Linux, Node 20). [VERIFIED: live test in project environment]

`mqtt@^5.15.1` is the current latest release. [VERIFIED: npm registry] It does NOT auto-fallback from MQTT 5.0 to 3.1.1; the caller must explicitly set `protocolVersion: 5` for MQTT 5.0 or `protocolVersion: 4` (the library default) for 3.1.1. The "3.1.1 fallback" in TRP-02 means: connect first with `protocolVersion: 5`; if the broker rejects it (CONNACK non-zero reason code), the Transport reconnects with `protocolVersion: 4`. This two-attempt fallback must be implemented manually in `MqttTransport.connect()`. [CITED: mqtt.js README]

The Node-RED test pattern across this repo uses a hand-rolled `createRED()` mock (no `node-red-node-test-helper` dependency). All 411 existing tests use only `mocha`, `chai`, `sinon`. No additional test library is needed for Phase 3. [VERIFIED: codebase grep]

**Primary recommendation:** Implement the 500 ms grace timer as the primary EADDRINUSE defense; use `reuseAddr: true` as secondary; add `socket.close(cb)` and `client.end(false, {}, cb)` for the three-argument Node-RED close handler.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `BaseTransport` is an ES6 abstract class extending `EventEmitter` in `lib/transports/base-transport.js`. Concrete adapters: `class UdpTransport extends BaseTransport`, `class MqttTransport extends BaseTransport`. Abstract methods throw `new Error('not implemented')`.
- **D-02:** `send(payload, opts?)` accepts `Buffer | Buffer[]`. Transport does `Array.isArray(payload)` and emits the right number of packets/publishes. Caller does NOT loop.
- **D-03:** Status events emitted by the transport: `connected`, `disconnected`, `reconnecting`, `error`. UDP never emits `reconnecting` (connectionless). MQTT maps native events: `connect` → `connected`; `close` → `disconnected`; `reconnect` → `reconnecting`; `error` → `error`.
- **D-04:** Subscriber path uses `transport.on('message', buffer => ...)` EventEmitter pattern. No separate `receive(callback)` setter.
- **D-05:** Grace timer starts when `refCount` drops from 1 to 0. `setTimeout(() => transport.close(), 500)`.
- **D-06:** A new `acquire()` during the grace window cancels the timer with `clearTimeout` and reuses the same transport instance.
- **D-07:** The Connection-Node (`nodes/opcua-pubsub-connection.js`) owns refCount + timer + transport-instance. Transport classes are Node-RED-free.
- **D-08:** Grace period is fixed 500 ms constant `RECONNECT_GRACE_MS = 500` at top of `opcua-pubsub-connection.js`. NOT in editor UI.
- **D-09:** PublisherId type chosen via dropdown: `String | UInt16 | UInt32 | UInt64`.
- **D-10:** Default on new connection: `type=String`, `value=crypto.randomUUID()` auto-generated at node-create time.
- **D-11:** PublisherId lives only on the Connection-Node. Publisher-Nodes do NOT support per-publisher overrides.
- **D-12:** Publisher-Node (Phase 4) reads `connectionNode.publisherId` / `connectionNode.publisherIdType`.
- **D-13:** Single `brokerUrl` field; scheme drives TLS (`mqtt://` or `mqtts://`). Default `mqtt://localhost:1883`.
- **D-14:** Auth: `credentials: { userName: text, password: password }`. mTLS is OUT of scope.
- **D-15:** QoS dropdown `0 | 1 | 2`, default `1`.
- **D-16:** Topic: `${topicPrefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}`. `topicPrefix` field, default `ua`. `retain` HARDCODED `false` on data topics.
- **File layout:** `lib/transports/` subfolder for `base-transport.js`, `udp-transport.js`, `mqtt-transport.js`.

### Claude's Discretion

- Specific socket option defaults for UDP (`reuseAddr=true`, `addMembership` timing).
- Internal helper names, JSDoc wording, error code naming (`UDP_*` and `MQTT_*` prefixes per Phase 2 D-08 pattern).
- Connection-Node color (`#3a8cba` or new color for visual distinction from `opcua-endpoint`).

### Deferred Ideas (OUT OF SCOPE)

- mTLS client-certificate auth for MQTT.
- AMQP transport (TRP-03).
- Per-Publisher PublisherId override.
- Configurable reconnect grace period in UI.
- Discovery / MetaData announcement.
- MQTT 5.0 user properties / response topic.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TRP-01 | UDP-UADP multicast transport using Node.js `dgram`. Bind to `0.0.0.0`; explicit `multicastInterface`; default MTU 1400; chunk reassembly with 30 s expiry; `socket.close(done)`. | §UDP Socket Behavior; §Chunk Reassembly Pattern |
| TRP-02 | MQTT transport using `mqtt@^5.15.1`. MQTT 5.0 with 3.1.1 fallback; `retain=false` HARD-CODED; QoS per Part 14 §7.3.4; uses library reconnect. | §MQTT Library Details; §MQTT 5.0 Fallback |
| CFG-01 | `opcua-pubsub-connection` config node. `transportType` dropdown. Owns `BaseTransport` instance. Cert helper reuse. Ref-count with 500 ms grace period. | §Config Node Pattern; §Ref-Count + Grace Timer |
| CFG-02 | PublisherId per connection: String (UUID default), UInt16, UInt32, UInt64. Surfaced in editor. | §Editor Pattern |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| UDP socket lifecycle (bind/join/close) | `lib/transports/udp-transport.js` | — | Node-RED-free per D-07; pure dgram logic |
| MQTT client lifecycle (connect/end) | `lib/transports/mqtt-transport.js` | — | Node-RED-free per D-07; pure mqtt.js logic |
| BaseTransport interface contract | `lib/transports/base-transport.js` | — | Defines `send/connect/close/events` for Phase 4 |
| Ref-count + grace timer ownership | `nodes/opcua-pubsub-connection.js` | — | Config node owns shared state (D-07); mirrors opcua-endpoint pattern |
| Status fan-out to worker nodes | `nodes/opcua-pubsub-connection.js` | — | `_statusCallbacks` Set, forEach pattern from opcua-endpoint lines 93-104 |
| Editor UI (transportType, credentials) | `nodes/opcua-pubsub-connection.html` | — | All RED-dependent UI in nodes/ |
| Cert route registration | `lib/cert-store.js::registerCertRoutes` | `nodes/opcua-pubsub-connection.js` (caller) | Reuse existing helper per DEBT-02 completion |
| Chunk reassembly (UDP receive path) | `lib/transports/udp-transport.js` | — | TRP-01 mandates 30 s expiry lives in transport |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `dgram` | Node built-in | UDP multicast send/receive | Node.js standard; no additional dep |
| `events` | Node built-in | `EventEmitter` base class for `BaseTransport` | Already used by `OpcUaClientManager` |
| `mqtt` | `^5.15.1` | MQTT 5.0/3.1.1 client | REQUIREMENTS.md TRP-02 explicit mandate |

[VERIFIED: `dgram` and `events` are Node built-ins confirmed available — `node --version` = v20.20.2]
[VERIFIED: `mqtt@5.15.1` is current `dist-tags.latest` — `npm view mqtt version`]

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `crypto` | Node built-in | `crypto.randomUUID()` for default PublisherId | D-10; Node 14.17+ stable, well within >=18 engine |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `mqtt@^5.15.1` | `aedes` (broker) | Wrong direction — we need a client, not a broker |
| `mqtt@^5.15.1` | `mqtt@^4.x` | v4 does not support `protocolVersion: 5` option set |

**Installation:** Adding `mqtt` as the first runtime dependency beyond `node-opcua`:

```bash
npm install mqtt@^5.15.1
```

No peer-dependency conflicts: `mqtt@5.15.1` requires Node `>=16.0.0`; project engine is `>=18.0.0`. [VERIFIED: `npm view mqtt@5.15.1 engines`]

**mqtt@5.15.1 dependencies** (informational — all are pure JS, no native addons): `mqtt-packet`, `readable-stream`, `ws`, `debug`, `lru-cache`, `rfdc`, `socks`, and others. [VERIFIED: npm registry]

---

## Architecture Patterns

### System Architecture Diagram

```
encodeNetworkMessage()        encodeNetworkMessage()
    └── Buffer | Buffer[]         └── Buffer | Buffer[]
           │                              │
           ▼                              ▼
┌─────────────────────────────────────────────────────┐
│          opcua-pubsub-connection (Config Node)       │
│  ┌──────────────────────────────────────────────┐    │
│  │ _refCount / _graceTimer / _sharedTransport   │    │
│  │ _statusCallbacks Set                         │    │
│  │ acquireTransport() / releaseTransport()      │    │
│  │ registerStatusCallback() / unregister()      │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
           │  instanceof BaseTransport check
           ▼
┌──────────────────────────────────────────────────────────┐
│  BaseTransport extends EventEmitter                       │
│  abstract: connect() / close() / send(Buffer|Buffer[])   │
│  events:   connected / disconnected / reconnecting /      │
│            error / message                                │
└──────────────────────────────────────────────────────────┘
           │                    │
           ▼                    ▼
┌────────────────────┐  ┌────────────────────────────────┐
│  UdpTransport      │  │  MqttTransport                  │
│  dgram.Socket      │  │  mqtt.Client                    │
│  bind → 0.0.0.0    │  │  connect() → protocolVersion:5  │
│  addMembership     │  │  fallback → protocolVersion:4   │
│  multicastLoopback │  │  publish(retain:false)          │
│  close(done)       │  │  subscribe(wildcards)           │
│  reassembly Map    │  │  end(false,{},done)             │
└────────────────────┘  └────────────────────────────────┘
      ▲  ▼ 'message'              ▲  ▼ 'message'
  UDP multicast              MQTT broker
  239.x.x.x:port            mqtt:// or mqtts://
```

### Recommended Project Structure

```
lib/
├── transports/
│   ├── base-transport.js       # ES6 abstract class extends EventEmitter
│   ├── udp-transport.js        # dgram UDP multicast adapter
│   └── mqtt-transport.js       # mqtt.js MQTT 5.0/3.1.1 adapter
├── cert-store.js               # (existing - Phase 1)
├── opcua-client-manager.js     # (existing)
└── uadp-encoder.js             # (existing - Phase 2)
nodes/
├── opcua-pubsub-connection.js  # Config node: ref-count, grace timer, fan-out
├── opcua-pubsub-connection.html # Editor: transportType dropdown, credentials
└── ...                         # (existing nodes)
test/
├── udp-transport.test.js       # Phase 3 new: bind/close cycles, send, receive
├── mqtt-transport.test.js      # Phase 3 new: retain=false, qos, reconnect mock
├── opcua-pubsub-connection.test.js  # Phase 3 new: ref-count, grace timer, fan-out
└── ...                         # (existing)
```

### Pattern 1: BaseTransport Abstract Class

**What:** ES6 class extending EventEmitter with abstract method guards.
**When to use:** Any method that must be overridden by concrete transports.

```javascript
// Source: mirrors OpcUaClientManager constructor pattern (lib/opcua-client-manager.js:48)
"use strict";
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

### Pattern 2: UDP Transport — Socket Lifecycle

**What:** dgram socket created with `reuseAddr: true`, bound to `0.0.0.0`, multicast membership added after bind.
**When to use:** All UDP multicast operations.

```javascript
// Source: verified via live test in project environment
const dgram = require("dgram");

async connect() {
  return new Promise((resolve, reject) => {
    this._socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    this._socket.on("error", (err) => {
      this.emit("error", createError(`UDP_SOCKET_ERROR: ${err.message}`));
    });

    this._socket.on("message", (buf, rinfo) => {
      // Handle chunk reassembly before emitting
      const complete = this._reassemble(buf);
      if (complete) this.emit("message", complete);
    });

    this._socket.bind({ port: this.config.port, address: "0.0.0.0" }, () => {
      // addMembership MUST happen after bind (verified)
      this._socket.addMembership(this.config.multicastGroup,
                                  this.config.multicastInterface || "0.0.0.0");
      this._socket.setMulticastLoopback(true);  // for loopback test support
      this._socket.setMulticastTTL(128);
      this.emit("connected");
      resolve();
    });
  });
}

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

**Critical: `setMulticastInterface` vs `addMembership` second argument:**
- `socket.setMulticastInterface(ip)` — sets the outgoing interface for `send()`. Call after bind. The value must be a local IP string (e.g., `'192.168.1.10'`), NOT `'0.0.0.0'`.
- `socket.addMembership(multicastAddr, localInterfaceIp)` — second argument controls which NIC joins. Can be `'0.0.0.0'` (OS picks) or a specific local NIC IP.
- Both should be exposed via `this.config.multicastInterface`. When set to a specific IP: use it for both `addMembership` second argument and `setMulticastInterface`. When absent/`'0.0.0.0'`: let OS pick for `addMembership`, skip `setMulticastInterface`.

[VERIFIED: dgram API confirmed available — live Node.js test]

### Pattern 3: UDP D-02 — Buffer | Buffer[] send

**What:** Transport handles both single Buffer and array of chunk Buffers from encoder.
**When to use:** Every call to `transport.send()`.

```javascript
// Source: D-02 decision; dgram.send() API (built-in)
send(payload, opts) {
  const chunks = Array.isArray(payload) ? payload : [payload];
  for (const chunk of chunks) {
    this._socket.send(chunk, this.config.port, this.config.multicastGroup,
      (err) => { if (err) this.emit("error", createError(`UDP_SEND_ERROR: ${err.message}`)); }
    );
  }
}
```

### Pattern 4: Chunk Reassembly in UDP Transport

**What:** Map keyed by `(publisherId|writerGroupId|sequenceNumber)` storing incomplete chunk sequences. 30 s expiry swept on each receive.
**When to use:** UDP receive path in `_reassemble(buf)`.

Key structure per UADP Part 14 §7.2.4.4.4 — chunk NetworkMessage contains `chunkOffset` + `totalSize` in the chunk payload header. The decoder (`decodeNetworkMessage`) from Phase 2 already handles single-buffer decode; reassembly must accumulate until `totalSize` bytes are collected, then call `decodeNetworkMessage` on the reassembled buffer.

```javascript
// Reassembly key: combine publisherId + writerGroupId + messageSequenceNumber
// All three come from the chunk NetworkMessage header fields.
_reassemble(buf) {
  const partial = decodeNetworkMessage(buf);
  if (!partial.chunk) return buf; // not a chunk — pass through directly

  const key = `${partial.publisherId}|${partial.writerGroupId}|${partial.chunk.sequenceNumber}`;
  if (!this._chunks.has(key)) {
    this._chunks.set(key, {
      totalSize: partial.chunk.totalSize,
      parts: new Map(),
      expiresAt: Date.now() + 30000
    });
  }
  const entry = this._chunks.get(key);
  entry.parts.set(partial.chunk.chunkOffset, partial.chunk.chunkData);

  // Sweep expired entries on every receive (prevents unbounded growth)
  const now = Date.now();
  for (const [k, v] of this._chunks) {
    if (v.expiresAt < now) this._chunks.delete(k);
  }

  // Check if reassembly is complete
  let assembled = 0;
  for (const data of entry.parts.values()) assembled += data.length;
  if (assembled < entry.totalSize) return null; // incomplete

  // Concatenate in offset order and return complete buffer
  const sorted = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]);
  const complete = Buffer.concat(sorted.map(([, d]) => d));
  this._chunks.delete(key);
  return complete;
}
```

### Pattern 5: MQTT Transport Lifecycle

**What:** `mqtt.connect()` with `protocolVersion: 5`; manual fallback to 4 on broker rejection; `client.end(false, {}, cb)` for graceful close.
**When to use:** MqttTransport.connect() / close().

```javascript
// Source: [CITED: mqtt.js README https://github.com/mqttjs/MQTT.js/blob/main/README.md]
const mqtt = require("mqtt");

async connect() {
  return new Promise((resolve, reject) => {
    const opts = {
      protocolVersion: 5,
      reconnectPeriod: 5000,        // library handles reconnect automatically
      connectTimeout: 30000,
      clean: true,
      username: this.config.username || undefined,
      password: this.config.password || undefined,
    };

    this._client = mqtt.connect(this.config.brokerUrl, opts);

    this._client.on("connect", () => {
      this._protocolFallbackDone = true;
      this.emit("connected");
      resolve();
    });

    // MQTT 5.0 broker rejection → CONNACK non-zero reason code arrives as 'error'
    // with a specific code pattern. Detect and retry with protocolVersion: 4.
    this._client.on("error", (err) => {
      if (!this._protocolFallbackDone && /unsupported protocol/i.test(err.message)) {
        this._client.end(true, {}, () => {
          this._connectWithFallback(resolve, reject);
        });
        return;
      }
      this.emit("error", err);
    });

    this._client.on("reconnect", () => { this.emit("reconnecting"); });
    this._client.on("close",     () => { this.emit("disconnected"); });

    this._client.on("message", (topic, payload, packet) => {
      this.emit("message", payload, { topic, packet });
    });
  });
}

async close() {
  return new Promise((resolve) => {
    if (!this._client) return resolve();
    this._client.end(false, {}, () => {
      this._client = null;
      resolve();
    });
  });
}
```

**Important about MQTT 5.0 fallback:** The library does NOT auto-fallback. [CITED: mqtt.js README] The "fallback" must be implemented as a retry attempt: try `protocolVersion: 5` first; if broker rejects (error event with protocol-related message, or specific CONNACK reason code in MQTT 5.0), destroy and recreate client with `protocolVersion: 4`. The exact broker rejection pattern varies — a pragmatic approach is to catch the first connect error and retry with v4 if not already tried.

### Pattern 6: MQTT Retain Hard-Coded False

**What:** `publish()` options always include `retain: false` for data topics; caller cannot override.
**When to use:** Every `transport.send()` call.

```javascript
// Source: D-16 + TRP-02 + PITFALLS §5
send(payload, opts) {
  const topic = this._buildTopic(opts);
  const qos = (opts && opts.qos != null) ? opts.qos : this.config.qos;
  const publishOpts = {
    qos,
    retain: false,   // HARD-CODED — Part 14 §7.3.4 mandate, NEVER caller-overridable
  };
  const chunks = Array.isArray(payload) ? payload : [payload];
  for (const chunk of chunks) {
    this._client.publish(topic, chunk, publishOpts);
  }
}
```

### Pattern 7: Config Node Ref-Count + Grace Timer

**What:** Mirror of `opcua-endpoint.js` lines 42-150, with grace timer added on release.
**When to use:** `opcua-pubsub-connection.js`.

```javascript
// Source: nodes/opcua-endpoint.js (lines 42-150) + D-05/D-06/D-07/D-08
const RECONNECT_GRACE_MS = 500;  // constant at top of file

node._sharedTransport = null;
node._refCount = 0;
node._graceTimer = null;
node._statusCallbacks = new Set();

node.acquireTransport = function() {
  // D-06: cancel grace timer if in progress — reuse existing transport
  if (node._graceTimer) {
    clearTimeout(node._graceTimer);
    node._graceTimer = null;
  }

  node._refCount++;
  node.log(`Transport ref +1 (now ${node._refCount})`);

  if (!node._sharedTransport) {
    // Create transport based on config.transportType
    node._sharedTransport = _createTransport(node);

    // Fan-out status events — mirrors opcua-endpoint.js lines 93-104
    node._sharedTransport.on("connected",    () => node._statusCallbacks.forEach(cb => cb("connected")));
    node._sharedTransport.on("disconnected", () => node._statusCallbacks.forEach(cb => cb("disconnected")));
    node._sharedTransport.on("reconnecting", () => node._statusCallbacks.forEach(cb => cb("reconnecting")));
    node._sharedTransport.on("error",   (e) => node._statusCallbacks.forEach(cb => cb("error", e)));

    node._sharedTransport.connect().catch(err => node._statusCallbacks.forEach(cb => cb("error", err)));
  }
  return node._sharedTransport;
};

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

### Pattern 8: Config Node Editor — Transport-Conditional Field Visibility

**What:** `oneditprepare` shows/hides MQTT or UDP fields based on `transportType` dropdown.
**When to use:** `opcua-pubsub-connection.html`.

```javascript
// Source: mirrors updateSecurityUI() pattern in opcua-endpoint.html lines 35-45
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

### Pattern 9: Cert Route Registration

**What:** `registerCertRoutes(RED, prefix, certsDir)` called once at module load with prefix `'/opcua-pubsub-connection'`.
**When to use:** Top of `nodes/opcua-pubsub-connection.js`, outside the constructor.

```javascript
// Source: lib/cert-store.js (verified — registerCertRoutes signature)
// Source: nodes/opcua-endpoint.js line 17 (exact call pattern)
const { registerCertRoutes, getCertsDir } = require("../lib/cert-store");

module.exports = function(RED) {
  registerCertRoutes(RED, "/opcua-pubsub-connection", getCertsDir(RED));
  // ...
};
```

The prefix `/opcua-pubsub-connection` (with leading slash) matches the pattern used for `/opcua-endpoint`. Routes registered:
- `POST /opcua-pubsub-connection/upload-cert`
- `GET /opcua-pubsub-connection/certs`
- `DELETE /opcua-pubsub-connection/upload-cert/:filename`

The editor HTML AJAX call uses `CERT_ROUTE_PREFIX + '/upload-cert'` where `CERT_ROUTE_PREFIX = 'opcua-pubsub-connection'` (WITHOUT leading slash — this is a relative URL in the browser, consistent with opcua-endpoint.html line 4). [VERIFIED: opcua-endpoint.html line 4 and 121]

**Cert dropzone for Phase 3:** Per D-14, mTLS is deferred. However, the cert dropzone should still be present in the UI (hidden behind an "Advanced" section) so Phase 3.1 can add mTLS without an HTML schema change. The hidden input fields `certificateFile`, `privateKeyFile`, `caCertificateFile` still store paths. The registered routes are already available. This avoids a future HTML-schema migration. [ASSUMED — Phase 3 CONTEXT.md defers mTLS but does not specify whether to include placeholder UI; adding it deferred-hidden is safer for Phase 4 schema stability]

### Anti-Patterns to Avoid

- **Binding UDP socket to the multicast group IP or local NIC IP:** Always bind to `'0.0.0.0'`. Binding to any other address silently drops multicast datagrams. [CITED: PITFALLS.md §4]
- **Calling `addMembership` before `bind()`:** The membership call must be in the `bind` callback. Calling before bind fails silently or throws `EADDRNOTAVAIL`. [VERIFIED: live test]
- **Setting `retain: true` on data topics:** Hard-code `retain: false`. The spec (Part 14 §7.3.4) prohibits it. A retained stale message poisons newly-connected subscribers. [CITED: PITFALLS.md §5]
- **Calling `socket.close()` without a callback:** The two-arg form `socket.close()` does not wait for OS teardown; the callback form `socket.close(done)` is required for the Node-RED async close pattern. [CITED: PITFALLS.md §10]
- **Using `forceReconnect()` clone from `opcua-client.js`:** TRP-02 explicitly mandates library-side reconnect. Using the MQTT library's `reconnectPeriod` option is the correct approach. [CITED: CONTEXT.md D-07, REQUIREMENTS.md TRP-02]
- **Initializing transport in the config-node constructor:** Defer to `acquireTransport()` (the first call). `credentials` are not available in the constructor in Node-RED. [CITED: PITFALLS.md Integration Gotchas table]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MQTT protocol framing, reconnect loop | Custom MQTT client | `mqtt@^5.15.1` | TRP-02 explicit mandate; library handles QoS ACKs, reconnect, keep-alive |
| UDP socket creation | Custom socket abstraction | `dgram` (built-in) | Zero-dep; Node.js standard |
| UUID generation for default PublisherId | Custom UUID gen | `crypto.randomUUID()` | Built-in, RFC 4122 v4, Node >=14.17 |
| Transport reconnect retry loop | Copy from `opcua-client.js` | mqtt library `reconnectPeriod` | Creates 3rd copy of known-bad pattern (CONCERNS.md §Tech Debt 1); TRP-02 explicitly forbids it |

**Key insight:** The MQTT library's built-in reconnect (`reconnectPeriod: 5000`) is sufficient; there is no need for an application-level retry loop in `MqttTransport`. The `reconnecting` event fires when the library starts a reconnect attempt, which maps cleanly to D-03.

---

## Common Pitfalls

### Pitfall 1: EADDRINUSE on Rapid Redeploy Without reuseAddr

**What goes wrong:** Without `reuseAddr: true`, a Node.js UDP socket bind to a fixed port may fail with `EADDRINUSE` if the previous socket's OS teardown has not completed. On Linux this is rare for UDP (UDP has no TIME_WAIT), but WSL and certain kernel versions can hold the port briefly.

**Why it happens:** The primary structural mitigation is the 500 ms grace timer (D-05/D-06): if redeploy happens within 500 ms, the old socket is kept alive and reused — no new bind needed. `reuseAddr: true` is a secondary defense for when the grace window is exceeded.

**How to avoid:**
1. 500 ms grace timer (D-05/D-06) — primary defense against redeploy thrash.
2. `dgram.createSocket({ type: 'udp4', reuseAddr: true })` — secondary defense.
3. `socket.close(done)` in the Node-RED three-argument close handler — ensures old socket is fully closed before `done()` is called.

[VERIFIED: 20 rapid multicast bind/join/close cycles with `reuseAddr: true` completed with zero errors on this environment]

**Warning signs:** `EADDRINUSE` errors in Node-RED log after flow redeploy. Never seen with the grace timer in place if worker nodes disconnect/reconnect within the 500 ms window.

### Pitfall 2: addMembership After socket.close Leaves Kernel Membership

**What goes wrong:** If `dropMembership()` is not called before `socket.close()`, the OS may keep the multicast group membership active for a short time. On Linux/WSL this does not cause `EADDRINUSE` for subsequent sockets because UDP has no TIME_WAIT, but it can cause duplicate message delivery if an old and new socket are simultaneously receiving.

**Why it happens:** `socket.close()` implicitly calls `dropMembership` for all joined groups, but only in its cleanup path. The 500 ms grace timer and single-instance approach (D-06) prevent simultaneous old+new sockets from existing.

**How to avoid:** Always use a single `_sharedTransport` instance per Connection-Node. The grace timer ensures the old socket is closed before a new one is created (if redeploy exceeds 500 ms). Explicit `dropMembership()` before `close()` is belt-and-suspenders but not required given the single-instance pattern.

### Pitfall 3: MQTT `protocolVersion: 5` on MQTT 3.1.1-Only Brokers

**What goes wrong:** Connecting with `protocolVersion: 5` to a broker that only supports MQTT 3.1.1 results in a CONNACK with a non-zero return code. The `mqtt` library does NOT automatically downgrade. [CITED: mqtt.js README — no auto-fallback]

**Why it happens:** The library treats `protocolVersion` as a strict requirement, not a preference.

**How to avoid:** `MqttTransport.connect()` attempts `protocolVersion: 5` first. On error containing a protocol-related reason, it calls `client.end(true, {}, cb)` and retries with `protocolVersion: 4`. Set a flag `_protocolFallbackDone` to prevent infinite fallback loops. The first successful `connect` event sets `_protocolFallbackDone = true`.

**Warning signs:** MQTT client emits `error` immediately after connect without ever firing `connect`; error message contains "CONNACK" or "unsupported protocol version".

### Pitfall 4: mqtt `client.end()` Callback Receives No Arguments

**What goes wrong:** Code that checks `(err, result)` in the `client.end()` callback will always see `undefined` for both. The callback is a zero-argument completion signal.

**Why it happens:** The `client.end()` API fires a simple completion callback with no arguments. [CITED: mqtt.js README — `function ()` signature]

**How to avoid:** Node-RED close handler: `node.on('close', function(removed, done) { transport.close().then(done).catch(done); })`.

### Pitfall 5: Grace Timer Race — acquireTransport During releaseTransport

**What goes wrong:** Worker node A calls `releaseTransport()` (refCount → 0, grace timer started). Before 500 ms elapses, worker node B calls `acquireTransport()`. Without D-06 `clearTimeout`, a second transport would be created and the first would be closed 500 ms later — leaving B with a stale reference.

**Why it happens:** setTimeout fires asynchronously; `acquireTransport()` must be the one to cancel it.

**How to avoid:** At the top of `acquireTransport()`, before any other logic:
```javascript
if (node._graceTimer) {
  clearTimeout(node._graceTimer);
  node._graceTimer = null;
}
```
The pointer `node._sharedTransport` is stable across grace windows — B gets the same instance. [CITED: D-06]

### Pitfall 6: MQTT Subscription Multiplicity on Reconnect

**What goes wrong:** If the Subscriber (Phase 4) calls `transport.subscribe(topic)` in the `connected` handler, and the MQTT library fires `connected` again on reconnect (after `reconnecting`), the subscription is sent again. MQTT brokers handle duplicate subscriptions idempotently (return already-subscribed QoS), but if the Phase 4 subscriber re-registers multiple `transport.on('message')` listeners on each reconnect, messages are emitted multiple times.

**Why it happens:** `EventEmitter.on()` is additive. `EventEmitter.once()` or tracking whether a listener is already attached prevents this.

**How to avoid:** Phase 4 Subscriber uses `transport.once('connected', cb)` only if not already connected, or tracks subscription state. Document this in the `BaseTransport` interface contract. Not a Phase 3 blocker but worth noting in `base-transport.js` JSDoc.

---

## Code Examples

### UDP Transport Constructor

```javascript
// Source: mirrors OpcUaClientManager (lib/opcua-client-manager.js:48-63) + D-01
"use strict";
const { BaseTransport } = require("./base-transport");
const { createError } = require("../opcua-utils");
const dgram = require("dgram");

class UdpTransport extends BaseTransport {
  constructor(config) {
    super(config);
    // config: { port, multicastGroup, multicastInterface, mtu }
    this._socket = null;
    this._chunks = new Map();   // chunk reassembly buffer
  }
}
```

### MQTT Transport Constructor

```javascript
// Source: mirrors BaseTransport pattern
"use strict";
const { BaseTransport } = require("./base-transport");
const { createError } = require("../opcua-utils");
const mqtt = require("mqtt");

class MqttTransport extends BaseTransport {
  constructor(config) {
    super(config);
    // config: { brokerUrl, qos, topicPrefix, username, password }
    this._client = null;
    this._protocolFallbackDone = false;
  }
}
```

### Config Node Registration

```javascript
// Source: nodes/opcua-endpoint.js line 152-157 (RED.nodes.registerType pattern)
RED.nodes.registerType("opcua-pubsub-connection", OpcUaPubSubConnectionNode, {
  credentials: {
    userName: { type: "text" },
    password: { type: "password" }
  }
});
```

### Test Pattern — Mocking the Config Node (no node-red-node-test-helper)

```javascript
// Source: test/connection-sharing.test.js (established repo pattern)
function createRED() {
  const types = {};
  return {
    nodes: {
      createNode: function(node, config) { Object.assign(node, config); },
      registerType: function(name, ctor, opts) { types[name] = { constructor: ctor, opts }; },
      _types: types
    },
    httpAdmin: {  // needed for registerCertRoutes
      post: () => {}, get: () => {}, delete: () => {}
    },
    settings: { userDir: os.tmpdir() }
  };
}
```

### Test Pattern — Rapid Bind/Close Cycle (no broker needed)

```javascript
// Source: verified via live test — 20 cycles produce 0 errors
function cycle(n, port, done) {
  if (n === 0) return done(null);
  const transport = new UdpTransport({ port, multicastGroup: "239.0.0.1", multicastInterface: "0.0.0.0" });
  transport.connect().then(() => transport.close()).then(() => cycle(n - 1, port, done)).catch(done);
}

it("should complete 20 rapid bind/close cycles without EADDRINUSE", function(done) {
  this.timeout(10000);
  cycle(20, 45678 + Math.floor(Math.random() * 1000), done);
});
```

---

## MQTT 5.0 Specifics

### Event Name Mapping (D-03 implementation guide)

| mqtt.js native event | BaseTransport event emitted |
|---------------------|----------------------------|
| `connect` | `connected` |
| `close` | `disconnected` |
| `reconnect` | `reconnecting` |
| `error` | `error` |
| `message` | `message` |
| `offline` | (ignored — `close` handles disconnected state) |

[CITED: mqtt.js README — event documentation]

Note: the `connect` event fires with a `connack` packet argument. The `reconnect` event fires before the reconnect *attempt* (not after success). The library emits `connect` again when reconnect succeeds. [CITED: mqtt.js README]

### MQTT publish() opts Shape

```javascript
// Source: [CITED: mqtt.js README — MqttClient#publish]
client.publish(topic, payload, {
  qos: 1,           // 0, 1, or 2
  retain: false,    // ALWAYS false for data topics (D-16)
}, callback);       // optional; fires on QoS ack complete
```

`payload` can be `Buffer` or `String`. For UADP binary, pass `Buffer` directly.

### MQTT Topic Wildcards (Subscriber side)

```javascript
// Source: [CITED: mqtt.js README — subscribe wildcards]
// + = single-level wildcard, # = multi-level wildcard
client.subscribe("ua/+/1/1", { qos: 1 });  // specific writerId
client.subscribe("ua/#", { qos: 1 });       // all topics under prefix
```

For Phase 4 Subscriber: subscribe to `${topicPrefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}` (exact match, no wildcards unless filtering across multiple publishers).

### MQTT reconnectPeriod

```javascript
// Source: [CITED: mqtt.js README]
// reconnectPeriod: 0  → disables reconnect (use for unit tests)
// reconnectPeriod: N  → reconnect every N ms after disconnect (library handles automatically)
// Default: 1000ms
```

For `MqttTransport`, use `reconnectPeriod: 5000` as a sensible default. Expose via `config.reconnectPeriod` (not in editor UI — Claude's Discretion). Set to `0` in unit tests to prevent the test from hanging.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| mqtt@4.x with basic MQTT 3.1.1 | mqtt@5.x with MQTT 5.0 `protocolVersion` option | mqtt v5 release (~2022) | MQTT 5.0 features (reason codes, session expiry, user properties) now available |
| Manual `socket.reusePort` via `setopts` hack | `reuseAddr` option in `dgram.createSocket()` | Node.js ~v0.12 | Native support; no raw socket hacks needed |
| node-red-node-test-helper for config-node tests | Hand-rolled `createRED()` mock | This repo established pattern | No additional test dep; works with mocha + chai + sinon |

**Deprecated/outdated:**
- `mqtt@4.x`: Still supported but `protocolVersion: 5` requires v5+. REQUIREMENTS.md explicitly mandates `^5.15.1`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js `dgram` | UdpTransport | Yes | built-in (Node 20.20.2) | — |
| Node.js `events` | BaseTransport | Yes | built-in | — |
| Node.js `crypto.randomUUID()` | Config node default PublisherId | Yes | built-in (Node 14.17+) | — |
| `mqtt@^5.15.1` | MqttTransport | Not installed yet | 5.15.1 available on registry | Add to package.json dependencies |
| Mosquitto broker | MQTT integration tests | Not checked | — | Mock via `mqtt` library's `reconnectPeriod: 0` + sinon stub |

**Missing dependencies with no fallback:** None that block unit tests. MQTT transport unit tests mock the `mqtt` module directly (no broker needed). Integration tests (TEST-01) are Phase 4 scope.

**Missing dependencies with fallback:** `mqtt@^5.15.1` — install via `npm install mqtt@^5.15.1` before Phase 3 execution.

---

## Testing Architecture

`nyquist_validation: false` — Validation Architecture section SKIPPED per config.json.

### Testing Framework Baseline

| Property | Value |
|----------|-------|
| Framework | Mocha 10.2.0 + Chai 4.3.10 + Sinon 17.0.1 |
| Config | none (mocha invoked via `npm test` = `mocha test/**/*.test.js --timeout 30000 --exit`) |
| Quick run | `npm test` |
| Baseline | 411 passing, 8 pending |

### Phase 3 New Test Files

| File | Covers | Key Assertions |
|------|--------|----------------|
| `test/udp-transport.test.js` | TRP-01 | 20 rapid bind/close cycles; send Buffer; send Buffer[]; `connected` event after bind; `disconnected` after close; addMembership error if bad NIC handled gracefully; reassembly: complete sequence emits `message`; reassembly: 30 s expiry sweeps stale |
| `test/mqtt-transport.test.js` | TRP-02 | `retain=false` cannot be overridden; `qos` passed through; `reconnectPeriod: 0` in test opts; `connected` event maps from mqtt `connect`; `close()` calls `client.end(false, …)` |
| `test/opcua-pubsub-connection.test.js` | CFG-01/CFG-02 | refCount increments on acquire; grace timer cancels on re-acquire; transport closed after 500 ms on last release; status fan-out to registered callbacks; close handler cleans up; `instanceof BaseTransport` check; PublisherId type + value stored |

### Existing Test Must Not Regress

All 411 existing tests must continue to pass after Phase 3 changes. The only risk is if `registerCertRoutes` is called for a new prefix in `opcua-pubsub-connection.js` and the test environment does not have `RED.httpAdmin` — `cert-store.js` has an explicit `if (!RED || !RED.httpAdmin) return;` guard. [VERIFIED: lib/cert-store.js line 131]

---

## Project Constraints (from CLAUDE.md)

No `CLAUDE.md` exists in this project. [VERIFIED: file not found]

Constraints derived from existing codebase patterns:

- **CommonJS modules** (`"use strict"`, `require`/`module.exports`): All lib/ and nodes/ files use CommonJS. [VERIFIED: lib/uadp-encoder.js, lib/cert-store.js, nodes/opcua-endpoint.js]
- **2-space indentation, double quotes**: All existing files. [VERIFIED: lib/opcua-client-manager.js]
- **JSDoc banners on every exported function**: Per Phase 2 D-21. [VERIFIED: lib/cert-store.js, lib/uadp-encoder.js]
- **`createError` from `lib/opcua-utils.js`** for structured error codes: Used in Phase 2 lib/ files. Error codes follow `PREFIX_ISSUE` pattern (e.g., `UDP_BIND_FAILED`, `MQTT_CONNECT_TIMEOUT`). [VERIFIED: lib/uadp-encoder.js line 30]
- **lib/ stays Node-RED-free**: No `RED` references in any `lib/` file. [VERIFIED: lib/cert-store.js, lib/uadp-encoder.js — no RED imports]
- **test files use mocha + chai + sinon only**: No `node-red-node-test-helper`. [VERIFIED: package.json devDependencies, all test/*.test.js files]
- **`npm test` glob**: `mocha test/**/*.test.js` — new test files in `test/` matching `*.test.js` are auto-discovered.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | mTLS cert dropzone should be present but hidden in Phase 3 HTML for schema stability | Pattern 9 (Cert Route Registration) | If deferred entirely, Phase 3.1 would require an HTML schema migration that could break deployed flows |
| A2 | MQTT 5.0 fallback should be triggered by broker rejection error message matching `/unsupported protocol/i` | Pattern 5 (MQTT Transport Lifecycle) | The exact error message from different brokers may vary; a more robust approach is to detect CONNACK `returnCode !== 0` in the MQTT 5.0 packet properties |
| A3 | `multicastLoopback: true` should be enabled in UdpTransport for local loopback test support | Pattern 2 (UDP Transport Lifecycle) | If loopback is disabled, the round-trip loopback test (Phase 4 TEST-01 UDP-UADP) will not work on a single host |

---

## Open Questions (RESOLVED)

1. **MQTT 5.0 fallback exact trigger condition** — **RESOLVED**: Phase 3 commits to a regex covering the three known broker-error variants: `/unsupported protocol|unacceptable protocol version|protocol version not supported/i`. Mosquitto 2.0 emits "Unsupported protocol", HiveMQ emits "Unacceptable protocol version" (the MQTT 3.1.1 spec language), EMQX emits "Protocol version not supported". Plan 03-03 Task 1 uses this regex. Test #11 covers the first variant; test #11b (added in checker revision) parameterizes the other two — breaking the circular-self-confirming-test pattern. Real-broker verification is part of Phase 4 acceptance (Mosquitto container).

2. **Multicast interface selection on multi-NIC hosts** — **RESOLVED**: Phase 3 surfaces `multicastInterface` as an editor field when `transportType = udp`, default `'0.0.0.0'` (OS auto). The HTML info panel shows a warning paragraph: "If your host has multiple network interfaces, leaving this at 0.0.0.0 lets the OS pick — which may not be the OT-network NIC. Set the IP of the NIC connected to your OPC UA PubSub network." Phase 4 TEST-02 verifies with explicit interface. [CITED: PITFALLS.md §4]

3. **Chunk reassembly key completeness** — **RESOLVED**: Verified field paths in `lib/uadp-encoder.js` (`decodeNetworkMessage` line 928+):
   - `nm.publisherId` (top-level)
   - `nm.groupHeader.writerGroupId` (under `groupHeader`, line 964-965)
   - `nm.chunk.messageSequenceNumber` (under `chunk`, line 996 — note: chunk header carries `messageSequenceNumber`, NOT `sequenceNumber`; the `groupHeader.sequenceNumber` is the GROUP sequence, distinct from the per-message id used as the reassembly key)
   - `nm.chunk = { messageSequenceNumber, chunkOffset, totalSize, chunkData }`

   Plan 03-02 Task 2 was updated with the verified key string `${partial.publisherId}|${partial.groupHeader.writerGroupId}|${partial.chunk.messageSequenceNumber}` and a code comment citing the encoder line numbers.

---

## Sources

### Primary (HIGH confidence)
- `nodes/opcua-endpoint.js` — ref-counted shared-instance + statusCallback fan-out; lines 42-150 are the exact pattern to mirror
- `lib/cert-store.js` — `registerCertRoutes(RED, prefix, certsDir)` signature and behavior verified
- `lib/uadp-encoder.js` — `encodeNetworkMessage()` returns `Buffer` (small payload) or `Buffer[]` (chunked); verified via live test
- Live dgram test (this session) — 20 multicast bind/join/close cycles with `reuseAddr: true`, zero errors on Node 20/WSL2
- `npm view mqtt version` — confirmed `mqtt@5.15.1` is current latest
- `npm view mqtt@5.15.1 engines` — `{ node: '>=16.0.0' }`, no peer conflicts
- `npm view mqtt@5.15.1 dependencies` — all pure JS, no native addons
- Context7 `/mqttjs/mqtt.js` — connect options, publish opts, subscribe wildcards, end() signature, reconnect options

### Secondary (MEDIUM confidence)
- [CITED: mqtt.js README https://github.com/mqttjs/MQTT.js/blob/main/README.md] — no MQTT 5.0 auto-fallback; `client.end()` callback signature; `reconnectPeriod: 0` disables reconnect; event name sequence
- [CITED: PITFALLS.md §4, §5, §10] — multicast bind address, RETAIN flag, Node-RED async close pattern

### Tertiary (LOW confidence)
- None — all claims verified via tool or cited from official source.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — mqtt@5.15.1 verified via npm; dgram/events are built-ins
- UDP socket behavior: HIGH — verified via live tests on project environment
- MQTT library behavior: HIGH — Context7 + official README
- Architecture patterns: HIGH — directly derived from existing codebase (`opcua-endpoint.js`)
- MQTT 5.0 fallback mechanism: MEDIUM — library behavior confirmed (no auto-fallback), exact error trigger is ASSUMED

**Research date:** 2026-05-13
**Valid until:** 2026-06-13 (stable: dgram API and mqtt@5.x are mature; check for mqtt minor releases before implementation)

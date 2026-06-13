/**
 * OPC UA PubSub Connection Configuration Node
 *
 * Node-RED config node that owns the lifecycle of a single PubSub transport
 * (UDP-UADP multicast or MQTT). It mirrors the proven connection-sharing
 * pattern of nodes/opcua-endpoint.js (ref-count + status fan-out) and adds a
 * 500ms grace timer (D-05/D-06/D-08) so a rapid release→acquire during a
 * Node-RED redeploy reuses the SAME transport instance instead of tearing the
 * socket down and re-binding (which would risk EADDRINUSE on UDP).
 *
 * Public API consumed by Phase 4 Publisher/Subscriber via
 * RED.nodes.getNode(connectionId):
 *   node.acquireTransport()           -> BaseTransport (instanceof valid, D-01)
 *   node.releaseTransport()           -> void; 500ms grace if refCount → 0
 *   node.registerStatusCallback(cb)   -> cb(status, err?)
 *   node.unregisterStatusCallback(cb) -> void
 *   node.publisherId      : String    (default crypto.randomUUID(), D-10)
 *   node.publisherIdType  : "String"|"UInt16"|"UInt32"|"UInt64"
 *   node.transportType    : "udp"|"mqtt"
 *
 * Security:
 *   T-03-03 — credentials (password) are never logged. _redactConfig() strips
 *             password (and userName) before any diagnostic log call.
 *   T-03-07 — node.on('close', removed, done) cancels the grace timer and awaits
 *             transport.close() (socket.close(done) / client.end(false,{},done))
 *             BEFORE calling done() — synchronous Node-RED close.
 */

"use strict";

const crypto = require("crypto");
const { registerCertRoutes, getCertsDir } = require("../lib/cert-store");
const { BaseTransport } = require("../lib/transports/base-transport");
const { UdpTransport } = require("../lib/transports/udp-transport");
const { MqttTransport } = require("../lib/transports/mqtt-transport");

// D-08: grace window before a refCount=0 transport is actually closed. Lets a
// redeploy's release→re-acquire reuse the same instance (D-06 / Pitfall 5).
const RECONNECT_GRACE_MS = 500;

/**
 * Returns a shallow copy of a config-like object with credential fields
 * removed, so it is safe to include in a diagnostic log call (T-03-03).
 * @param {object} cfg
 * @returns {object}
 */
function _redactConfig(cfg) {
  const safe = Object.assign({}, cfg || {});
  delete safe.password;
  delete safe.userName;
  if (safe.credentials) {
    safe.credentials = Object.assign({}, safe.credentials);
    delete safe.credentials.password;
    delete safe.credentials.userName;
  }
  return safe;
}

module.exports = function (RED) {

  // ─── Certificate Upload HTTP Endpoint (reuse Phase 1 cert-store, DEBT-02) ───
  // Registered once at module load under this node's own prefix. Mirrors
  // nodes/opcua-endpoint.js line 17. registerCertRoutes is a no-op when
  // RED.httpAdmin is missing (test environments without it).
  registerCertRoutes(RED, "/opcua-pubsub-connection", getCertsDir(RED));

  function OpcUaPubSubConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // ─── Transport selection + per-transport config ───
    node.transportType = config.transportType || "udp";

    // UDP fields
    node.multicastGroup = config.multicastGroup || "239.0.0.1";
    node.multicastInterface = config.multicastInterface || "0.0.0.0";
    node.port = config.port != null ? Number(config.port) : 4840;
    node.mtu = config.mtu != null ? Number(config.mtu) : 1400;

    // MQTT fields
    node.brokerUrl = config.brokerUrl || "mqtt://localhost:1883";
    node.topicPrefix = config.topicPrefix || "ua";
    node.qos = config.qos != null ? Number(config.qos) : 1;

    // ─── PublisherId (D-09 / D-10 / D-11 / D-12) ───
    node.publisherIdType = config.publisherIdType || "String";
    // D-10: the editor sets a UUID at node-create time; this is a defensive
    // server-side guard for the case the field arrives empty for a String id.
    if (
      (config.publisherId === undefined ||
        config.publisherId === null ||
        config.publisherId === "") &&
      node.publisherIdType === "String"
    ) {
      node.publisherId = crypto.randomUUID();
    } else {
      node.publisherId = config.publisherId;
    }

    // ─── Shared transport lifecycle state ───
    node._sharedTransport = null;
    node._refCount = 0;
    node._graceTimer = null;
    node._statusCallbacks = new Set();

    /**
     * Wraps a status callback so one misbehaving subscriber cannot break
     * fan-out for its siblings.
     */
    function safeCb(cb, status, err) {
      try {
        cb(status, err);
      } catch (e) {
        node.warn("status callback threw: " + (e && e.message ? e.message : e));
      }
    }

    /**
     * Builds the concrete transport for the configured transportType.
     * @returns {BaseTransport}
     * @throws {Error} OPCUA_PUBSUB_UNKNOWN_TRANSPORT on an unsupported type.
     */
    node._createTransport = function () {
      if (node.transportType === "udp") {
        return new UdpTransport({
          port: node.port,
          multicastGroup: node.multicastGroup,
          multicastInterface: node.multicastInterface,
          mtu: node.mtu,
        });
      }
      if (node.transportType === "mqtt") {
        return new MqttTransport({
          brokerUrl: node.brokerUrl,
          qos: node.qos,
          topicPrefix: node.topicPrefix,
          username:
            (node.credentials && node.credentials.userName) || undefined,
          password:
            (node.credentials && node.credentials.password) || undefined,
          reconnectPeriod: 5000,
          publisherId: node.publisherId,
        });
      }
      // Redacted config in the error message — never leak credentials (T-03-03).
      node.error(
        "OPCUA_PUBSUB_UNKNOWN_TRANSPORT: " +
          node.transportType +
          " (config: " +
          JSON.stringify(_redactConfig(config)) +
          ")"
      );
      throw new Error(
        "OPCUA_PUBSUB_UNKNOWN_TRANSPORT: " + node.transportType
      );
    };

    /**
     * Acquires the shared transport (creates + connects it on first use).
     * Cancels a pending grace timer so a release→acquire within the grace
     * window reuses the SAME instance (D-06 / Pitfall 5). Returns the same
     * BaseTransport pointer across grace windows.
     * @returns {BaseTransport}
     */
    node.acquireTransport = function () {
      // Pitfall 5: cancel a pending close before we (re)use the transport.
      if (node._graceTimer) {
        clearTimeout(node._graceTimer);
        node._graceTimer = null;
      }

      node._refCount++;
      node.log("Transport ref +1 (now " + node._refCount + ")");

      if (node._sharedTransport === null) {
        const transport = node._createTransport();
        node._sharedTransport = transport;

        // Status fan-out — mirrors opcua-endpoint.js lines 92-104.
        transport.on("connected", () =>
          node._statusCallbacks.forEach((cb) => safeCb(cb, "connected"))
        );
        transport.on("disconnected", () =>
          node._statusCallbacks.forEach((cb) => safeCb(cb, "disconnected"))
        );
        transport.on("reconnecting", () =>
          node._statusCallbacks.forEach((cb) => safeCb(cb, "reconnecting"))
        );
        transport.on("error", (e) =>
          node._statusCallbacks.forEach((cb) => safeCb(cb, "error", e))
        );
        // W-4: surface UDP_REASSEMBLY_OVERFLOW (and any future 'warn') to the
        // Node-RED log so operators see it. NOT part of the worker fan-out set.
        transport.on("warn", (e) =>
          node.warn(e && e.message ? e.message : String(e))
        );

        // Kick off connect; surface a connect failure via the error fan-out.
        Promise.resolve()
          .then(() => transport.connect())
          .catch((err) =>
            node._statusCallbacks.forEach((cb) => safeCb(cb, "error", err))
          );
      }

      return node._sharedTransport;
    };

    /**
     * Releases the shared transport. When the last consumer releases, starts a
     * 500ms grace timer; the timer fire closes the transport and clears the
     * status callbacks.
     */
    node.releaseTransport = function () {
      node._refCount = Math.max(0, node._refCount - 1);
      node.log("Transport ref -1 (now " + node._refCount + ")");

      if (node._refCount === 0 && node._sharedTransport) {
        node._graceTimer = setTimeout(() => {
          node._graceTimer = null;
          // ME-05: re-check refCount. A consumer can have re-acquired AFTER the
          // grace window started — acquireTransport() only cancels a PENDING
          // timer, not one whose callback has already begun running here. If a
          // re-acquire happened, refCount is back > 0 and we must NOT close the
          // transport it is now using.
          if (node._refCount === 0 && node._sharedTransport) {
            // ME-05: detach the instance from the node BEFORE awaiting close().
            // close() is async; if we left _sharedTransport pointing at it, a
            // concurrent acquireTransport() racing this close could hand a
            // CLOSING transport to a publisher/subscriber (its next send would
            // hit *_SEND_NOT_CONNECTED and inbound messages would be lost on a
            // closing socket). Nulling first guarantees a concurrent acquire
            // builds a FRESH instance instead of reusing the closing one.
            const closing = node._sharedTransport;
            node._sharedTransport = null;
            node._statusCallbacks.clear();
            closing.close().catch(() => {});
          }
        }, RECONNECT_GRACE_MS);
      }
    };

    node.registerStatusCallback = function (callback) {
      node._statusCallbacks.add(callback);
    };

    node.unregisterStatusCallback = function (callback) {
      node._statusCallbacks.delete(callback);
    };

    // ─── Synchronous Node-RED close (T-03-07, ROADMAP success criterion #5) ───
    // NOTE: two-argument (removed, done) signature is mandatory for config
    // nodes; the one-arg form breaks the close handshake (see plan WARNING).
    node.on("close", async function (removed, done) {
      if (node._graceTimer) {
        clearTimeout(node._graceTimer);
        node._graceTimer = null;
      }
      if (node._sharedTransport) {
        try {
          await node._sharedTransport.close();
        } catch (e) {
          /* ignore — close is best-effort idempotent */
        }
        node._sharedTransport = null;
      }
      node._refCount = 0;
      node._statusCallbacks.clear();
      done();
    });
  }

  RED.nodes.registerType("opcua-pubsub-connection", OpcUaPubSubConnectionNode, {
    credentials: {
      userName: { type: "text" },
      password: { type: "password" },
    },
  });

  // Exposed for potential reuse/testing; intentionally references BaseTransport
  // so the D-01 runtime contract is visible in this module.
  OpcUaPubSubConnectionNode._BaseTransport = BaseTransport;
};

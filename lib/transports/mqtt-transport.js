/**
 * MqttTransport — MQTT 5.0 / 3.1.1 PubSub Transport Adapter
 *
 * Concrete BaseTransport subclass (Plan 03-03, TRP-02) that carries OPC UA
 * PubSub NetworkMessages over MQTT using the `mqtt` npm client. Designed for the
 * Phase 4 Publisher (MQTT-UADP / MQTT-JSON) and the Plan 03-04 Connection-Node.
 *
 * Lifecycle (03-RESEARCH.md Pattern 5 + Pitfalls 3 & 4):
 *   - connect(): invokes `mqtt.connect(brokerUrl, { protocolVersion: 5, ... })`
 *     first. On a protocol-rejection error BEFORE the first successful 'connect',
 *     it tears the client down and retries ONCE with `protocolVersion: 4`
 *     (MQTT 5.0 → 3.1.1 fallback, Pitfall 3). `_protocolFallbackDone` caps the
 *     fallback at a single v5 + single v4 attempt. Resolves once 'connected' is
 *     emitted. Library-handled reconnect via `reconnectPeriod` — there is NO
 *     forceReconnect() clone (TRP-02 explicit prohibition).
 *   - close(): `client.end(false, {}, done)` — three-arg graceful form, zero-arg
 *     callback (Pitfall 4). `_client` is nulled BEFORE end() so a second close()
 *     is a no-op (idempotent, T-03-07). Resets `_protocolFallbackDone` so a later
 *     connect() can fall back again.
 *   - send(payload, opts): builds `${topicPrefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}`
 *     (D-16), validates every user-controlled component against forbidden MQTT
 *     characters BEFORE concat (T-03-04), and publishes with `retain: false`
 *     HARDCODED (T-03-06, Part 14 §7.3.4) — a caller's opts.retain is never read.
 *
 * Security posture:
 *   - T-03-02: `rejectUnauthorized` is NEVER passed to mqtt.connect opts, even via
 *     config — Node's default TLS validation applies for `mqtts://`.
 *   - T-03-04: topic-injection guard (`TOPIC_FORBIDDEN`) on publisherId,
 *     writerGroupId, dataSetWriterId, topicPrefix.
 *   - T-03-06: retain:false is a fresh-object literal, not caller-overridable.
 *
 * Config (shape consumed by the Connection-Node in Plan 03-04):
 *   { brokerUrl, qos, topicPrefix, username?, password?, reconnectPeriod?, publisherId }
 *
 * Node-RED-free (D-07): depends only on `mqtt`, BaseTransport, and opcua-utils.
 *
 * Exports:
 *   MqttTransport   -> class extends BaseTransport (named export)
 */

"use strict";

const { BaseTransport } = require("./base-transport");
const { createError } = require("../opcua-utils");
const mqtt = require("mqtt");

// MQTT topic injection guard (T-03-04). Forbidden in any user-controlled topic
// component: the level separator `/`, the single- and multi-level wildcards
// `+` and `#`, and control characters (\x00-\x1F plus DEL \x7F).
const TOPIC_FORBIDDEN = /[/+#\x00-\x1F\x7F]/;

// Broker error texts that indicate the server rejected MQTT 5.0 and the client
// should fall back to 3.1.1. Covers the three known variants (Mosquitto /
// HiveMQ / EMQX) so the fallback is not a circular self-confirming test.
const PROTOCOL_REJECTION =
  /unsupported protocol|unacceptable protocol version|protocol version not supported/i;

/**
 * Validates one user-controlled topic component. Throws a real Error (so callers'
 * try/catch and chai `.to.throw` observe a thrown Error) when the value is empty,
 * undefined, or contains a forbidden MQTT character.
 * @param {string} name
 * @param {*} value
 */
function _validateTopicComponent(name, value) {
  if (value === undefined || value === null || String(value).length === 0) {
    throw new Error(`TOPIC_INVALID_CHARACTER: ${name} is empty or undefined`);
  }
  if (TOPIC_FORBIDDEN.test(String(value))) {
    throw new Error(
      `TOPIC_INVALID_CHARACTER: ${name} contains forbidden character (one of / + # or a control char)`
    );
  }
}

class MqttTransport extends BaseTransport {
  /**
   * @param {object} config
   * @param {string} config.brokerUrl - e.g. "mqtt://host:1883" or "mqtts://host:8883" (D-13).
   * @param {number} [config.qos] - 0 | 1 | 2, default 1 (D-15).
   * @param {string} [config.topicPrefix] - default "ua" (D-16).
   * @param {string} [config.username] - optional (D-14).
   * @param {string} [config.password] - optional (D-14).
   * @param {number} [config.reconnectPeriod] - default 5000; tests pass 0 to disable.
   * @param {string} [config.publisherId] - for topic building.
   */
  constructor(config) {
    super(config);
    this._client = null;
    this._protocolFallbackDone = false;
  }

  /**
   * Opens the MQTT client (MQTT 5.0 first, 3.1.1 fallback on protocol rejection).
   * @returns {Promise<void>} Resolves once 'connected' has been emitted.
   */
  async connect() {
    if (this._client) return;
    return this._tryConnect(5);
  }

  /**
   * @param {number} protocolVersion - 5 (initial) or 4 (3.1.1 fallback).
   * @returns {Promise<void>}
   */
  _tryConnect(protocolVersion) {
    return new Promise((resolve, reject) => {
      const opts = {
        protocolVersion,
        reconnectPeriod:
          this.config.reconnectPeriod != null ? this.config.reconnectPeriod : 5000,
        connectTimeout: 30000,
        clean: true,
        // T-03-02: rejectUnauthorized is INTENTIONALLY absent. Even if
        // config.rejectUnauthorized is set we never copy it — Node's default TLS
        // validation applies for mqtts://. A user-controlled bypass is forbidden.
      };
      if (this.config.username) opts.username = this.config.username;
      if (this.config.password) opts.password = this.config.password;

      const client = mqtt.connect(this.config.brokerUrl, opts);
      this._client = client;

      client.on("connect", () => {
        this._protocolFallbackDone = true;
        this.emit("connected");
        resolve();
      });

      client.on("error", (err) => {
        const msg = err && err.message;
        if (
          !this._protocolFallbackDone &&
          protocolVersion === 5 &&
          PROTOCOL_REJECTION.test(msg)
        ) {
          // MQTT 5.0 → 3.1.1 fallback (Pitfall 3). Cap at one v5 + one v4 attempt.
          this._protocolFallbackDone = true;
          try {
            client.end(true, {}, () => {});
          } catch (e) {
            /* ignore teardown errors during fallback */
          }
          this._client = null;
          this._tryConnect(4).then(resolve).catch(reject);
          return;
        }
        // Post-connect (or non-protocol) errors are non-fatal: relay to listeners
        // and let the library reconnect via reconnectPeriod. Do NOT reject here.
        this.emit("error", err);
      });

      client.on("close", () => this.emit("disconnected"));
      client.on("reconnect", () => this.emit("reconnecting"));
      client.on("message", (topic, payload, packet) => {
        this.emit("message", payload, { topic, packet });
      });
    });
  }

  /**
   * Closes the MQTT client gracefully. Idempotent. Resets the fallback flag so a
   * subsequent connect() may fall back again.
   * @returns {Promise<void>} Resolves on the end() callback.
   */
  async close() {
    return new Promise((resolve) => {
      const client = this._client;
      this._client = null; // null first so a concurrent/second close() is a no-op
      this._protocolFallbackDone = false; // W-3: allow fallback on a later connect()
      if (!client) return resolve();
      // Pitfall 4: client.end(force=false graceful, opts={}, cb) — cb is zero-args.
      client.end(false, {}, () => resolve());
    });
  }

  /**
   * Sends one or more UADP/JSON buffers. Implemented in Task 2.
   * @param {Buffer|Buffer[]} payload
   * @param {object} [opts]
   * @returns {void}
   */
  send(payload, opts) {
    throw new Error("Task 2 implements send()");
  }
}

module.exports = { MqttTransport };

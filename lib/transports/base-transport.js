/**
 * BaseTransport — Abstract PubSub Transport Adapter
 *
 * Shared abstract base class for every OPC UA PubSub transport adapter
 * (UdpTransport in Plan 03-02, MqttTransport in Plan 03-03). Designed for
 * reuse: depends only on the Node built-in `events` module and on zero
 * project-internal modules so it can be required by any transport or
 * config node. Node-RED-free (D-07).
 *
 * Concrete subclasses MUST override connect(), close(), and send(); the
 * abstract methods here fail loud with "not implemented" so a misconfigured
 * subclass surfaces the gap at first use rather than silently no-op'ing
 * (T-03-09 mitigation).
 *
 * Exports:
 *   BaseTransport   -> class extends EventEmitter (named export)
 *
 * API contract (locked — do NOT change in 03-02/03-03/03-04):
 *   connect()           -> Promise; resolves AFTER 'connected' has been emitted.
 *   close()             -> Promise; idempotent; emits 'disconnected' on completion.
 *   send(payload, opts) -> void; payload is Buffer | Buffer[] (D-02); transport
 *                          dispatches Array.isArray internally (caller never loops).
 *                          `opts` is reserved (03-03 per-publish QoS override).
 *
 * Events a subclass MAY emit (D-03 + D-04):
 *   "connected"     — transport ready to send/receive
 *   "disconnected"  — transport closed (clean or unexpected)
 *   "reconnecting"  — connection-oriented transports only (MQTT); UDP never emits
 *   "error"         — Error or createError() shape; non-fatal, non-blocking
 *   "message"       — (Buffer payload, optional metadata) — receive path
 *
 * Subscriber path uses transport.on('message', (buffer, metadata?) => ...) (D-04);
 * there is no receive(callback) setter and no async iterator.
 */

"use strict";

const EventEmitter = require("events");

class BaseTransport extends EventEmitter {
  /**
   * @param {object} config - Transport configuration (scheme, host, port,
   *   brokerUrl, credentials, etc. — shape is subclass-specific).
   */
  constructor(config) {
    super();
    this.config = config;
  }

  /**
   * Opens the underlying socket/client.
   * @returns {Promise<void>} Resolves once the 'connected' event has been emitted.
   *   Subclasses MUST override; the base implementation rejects.
   */
  async connect() {
    throw new Error("BaseTransport.connect() not implemented");
  }

  /**
   * Tears down the underlying socket/client. MUST be idempotent in subclasses
   * (calling twice is a no-op the second time) and emit 'disconnected' on
   * completion.
   * @returns {Promise<void>} Resolves once teardown is complete.
   *   Subclasses MUST override; the base implementation rejects.
   */
  async close() {
    throw new Error("BaseTransport.close() not implemented");
  }

  /**
   * Sends one or more UADP payloads. Throws synchronously (NOT async) so a
   * caller cannot accidentally swallow the abstract guard in an
   * unhandled-rejection.
   * @param {Buffer|Buffer[]} payload - Single buffer or array of buffers (D-02).
   *   Transport dispatches Array.isArray internally — caller never loops.
   * @param {object} [opts] - Reserved for future per-publish options
   *   (03-03 QoS override; 03-02 ignores it).
   * @returns {void} Subclasses MUST override; the base implementation throws.
   */
  send(payload, opts) {
    throw new Error("BaseTransport.send() not implemented");
  }
}

module.exports = { BaseTransport };

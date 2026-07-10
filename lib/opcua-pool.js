/**
 * PooledClientManager — optional session pool (opt-in via endpoint poolSize).
 *
 * Wraps N OpcUaClientManager instances that share one endpoint config.
 * Stateless operations (read/write/browse/...) round-robin across connected
 * members to raise the per-endpoint concurrency ceiling. Session-bound
 * operations (subscriptions, registered nodes, ExtensionObject construction,
 * getSession) always use the primary member (members[0]) so their session
 * affinity holds.
 *
 * The endpoint only routes here when poolSize > 1; poolSize === 1 keeps using
 * a plain OpcUaClientManager, so default behaviour is byte-for-byte unchanged.
 *
 * Limitation: numeric handles from registerNodes() are bound to the primary's
 * session. Reads using those handles are NOT guaranteed to hit the primary
 * (round-robin), so registered-handle reads + pooling should not be combined.
 * Reads by string NodeId (the common case) are unaffected.
 */

"use strict";

const { EventEmitter } = require("events");
const OpcUaClientManager = require("./opcua-client-manager");

class PooledClientManager extends EventEmitter {
  // ManagerClass is injectable for testing; production always uses the real
  // OpcUaClientManager.
  constructor(config, poolSize, ManagerClass = OpcUaClientManager) {
    super();
    this.config = config;
    this.size = Math.max(2, Number(poolSize) || 2);
    this.members = Array.from(
      { length: this.size },
      () => new ManagerClass(config),
    );
    this.primary = this.members[0];
    this._rr = 0;

    // Surface the primary's lifecycle as the pool's lifecycle so endpoint
    // status callbacks behave exactly as with a single manager. Errors from
    // any member are forwarded (a dead secondary is still worth logging).
    for (const evt of [
      "connected",
      "disconnected",
      "reconnecting",
      "reconnected",
      "session_recreated",
      "backoff",
    ]) {
      this.primary.on(evt, (payload) => this.emit(evt, payload));
    }
    for (const m of this.members) {
      m.on("error", (err) => this.emit("error", err));
    }
  }

  // ── Pool state ──
  get isConnected() {
    return this.primary.isConnected;
  }

  get subscriptions() {
    return this.primary.subscriptions;
  }

  /**
   * Round-robin over members, preferring connected ones. Falls back to the
   * primary when nothing is connected so the operation throws and the
   * caller's retry loop triggers reconnect().
   */
  _pickMember() {
    for (let i = 0; i < this.members.length; i++) {
      const idx = (this._rr + i) % this.members.length;
      const m = this.members[idx];
      if (m.isConnected) {
        this._rr = (idx + 1) % this.members.length;
        return m;
      }
    }
    return this.primary;
  }

  // ── Stateless helpers (pure — safe on any member) ──
  _isConnectionLostError(err) {
    return this.primary._isConnectionLostError(err);
  }

  _toOpcUaNodeId(nodeId) {
    return this.primary._toOpcUaNodeId(nodeId);
  }

  // ── Lifecycle ──
  async connect() {
    // Primary first so isConnected / subscriptions are usable ASAP; the rest
    // connect best-effort in parallel (a slow member must not block reads).
    await this.primary.connect();
    await Promise.all(
      this.members.slice(1).map((m) => m.connect().catch(() => {})),
    );
  }

  async disconnect() {
    await Promise.all(this.members.map((m) => m.disconnect().catch(() => {})));
  }

  async reconnect(opts = {}) {
    // Reconnect every member that is not currently connected. A failed
    // secondary degrades throughput but the pool stays usable, so only a
    // primary failure propagates.
    await Promise.all(
      this.members.map((m) =>
        m.isConnected
          ? Promise.resolve()
          : m.reconnect(opts).catch((e) => {
              if (m === this.primary) throw e;
            }),
      ),
    );
  }

  // ── Session-bound → primary ──
  createSubscription(opts) {
    return this.primary.createSubscription(opts);
  }
  registerNodes(nodeIds) {
    return this.primary.registerNodes(nodeIds);
  }
  unregisterNodes(nodeIds) {
    return this.primary.unregisterNodes(nodeIds);
  }
  constructExtensionObject(dataTypeNodeId, fields) {
    return this.primary.constructExtensionObject(dataTypeNodeId, fields);
  }
  getSession() {
    return this.primary.getSession();
  }

  // ── Stateless → round-robin ──
  read(nodeId) {
    return this._pickMember().read(nodeId);
  }
  readMultiple(nodeIds) {
    return this._pickMember().readMultiple(nodeIds);
  }
  readAttribute(nodeId, attributeId) {
    return this._pickMember().readAttribute(nodeId, attributeId);
  }
  write(nodeId, value, datatype, dataTypeNodeId) {
    return this._pickMember().write(nodeId, value, datatype, dataTypeNodeId);
  }
  writeMultiple(items) {
    return this._pickMember().writeMultiple(items);
  }
  callMethod(objectId, methodId, inputArguments) {
    return this._pickMember().callMethod(objectId, methodId, inputArguments);
  }
  historyRead(nodeId, startTime, endTime, options) {
    return this._pickMember().historyRead(nodeId, startTime, endTime, options);
  }
  browse(nodeId) {
    return this._pickMember().browse(nodeId);
  }
  translateBrowsePath(startNodeId, relativePath) {
    return this._pickMember().translateBrowsePath(startNodeId, relativePath);
  }
  getEndpoints(endpointUrl) {
    return this._pickMember().getEndpoints(endpointUrl);
  }
}

module.exports = PooledClientManager;

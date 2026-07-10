/**
 * OPC UA Client Manager
 * Manages OPC UA client connections with automatic reconnect
 */

const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  ClientSubscription,
  TimestampsToReturn,
  NodeId,
  resolveNodeId,
  Variant,
  VariantArrayType,
  DataType,
  AttributeIds,
  ClientMonitoredItem,
  ReadValueIdOptions,
  HistoryReadRequest,
  ReadRawModifiedDetails,
  AggregateFunction,
  ReadProcessedDetails,
  MonitoringParametersOptions,
  makeBrowsePath,
  StatusCodes,
  OPCUADiscoveryServer,
  performFindServersRequest,
  coerceNodeId,
} = require("node-opcua");

// OpaqueStructure is not re-exported by the top-level node-opcua package,
// so we import it from the sub-package directly.
let OpaqueStructure;
try {
  OpaqueStructure = require("node-opcua-extension-object").OpaqueStructure;
} catch (_e) {
  // Fallback: if the sub-package is not available, we use a duck-type check instead.
  OpaqueStructure = null;
}
const EventEmitter = require("events");
const fs = require("fs");
const { nodeIdToString, serializeExtensionObject } = require("./opcua-utils");

// Reconnect retry-loop tuning (DEBT-01: owned by the manager, not by node code)
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;

class OpcUaClientManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.session = null;
    this.subscriptions = new Map();
    this.isConnected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.reconnectDelay = config.reconnectDelay || 5000;
    this.operationTimeout = config.operationTimeout || 10000; // 10s default
    // Single-flight lock for reconnect() — DEBT-01
    this._reconnectPromise = null;
    // Reconnect cool-down: after a reconnect succeeds, a fresh reconnect()
    // call arriving within this window (while already connected) is treated
    // as already satisfied instead of forcing another full teardown+connect.
    // This removes the race where a burst of callers right after recovery
    // each kick off a redundant connect() whose cleanup phase briefly flips
    // isConnected=false under other in-flight operations.
    this._reconnectCooldownMs =
      config.reconnectCooldownMs != null ? config.reconnectCooldownMs : 250;
    this._lastReconnectSuccessAt = null;
    // Tracks whether connect() has ever succeeded, so we can tell an initial
    // connect apart from a reconnect and only fire "session_recreated" on the
    // latter (subscriptions are only stale after a session is replaced).
    this._everConnected = false;
  }

  /**
   * Called whenever a brand-new session replaces a previous one during a
   * reconnect. Every ClientSubscription/MonitoredItem created on the old
   * session is now bound to a dead session and would throw "expecting a
   * valid session" on reuse, so we drop the stale handles and let consumer
   * nodes rebuild via the "session_recreated" event.
   */
  _handleSessionReplaced() {
    this.subscriptions.clear();
    this.emit("session_recreated");
  }

  /**
   * Classify whether an error indicates a lost / invalid OPC UA connection
   * (vs. a logic error like an invalid NodeId or a read timeout).
   *
   * The list of known strings was migrated from nodes/opcua-client.js as
   * part of DEBT-01 so every consumer node can decide whether to call
   * reconnect() in its catch blocks.
   *
   * @param {Error|*} err
   * @returns {boolean} true when the error message matches a known
   *                    connection-lost pattern, false otherwise.
   */
  _isConnectionLostError(err) {
    if (!err || !err.message) return false;
    const m = err.message;
    return (
      m === "Session is no longer valid" ||
      m === "Not connected" ||
      m.includes("premature disconnection") ||
      m.includes("Secure Channel Closed") ||
      m.includes("connection may have been rejected") ||
      m.includes("Server end point") ||
      m.includes("socket has been disconnected") ||
      // Transaction aborted because the secure channel is tearing down — seen
      // when the session/channel closes while a request is in flight (e.g. a
      // reconnect storm under load). Treated as connection-lost so the
      // operation is retried rather than failed.
      m.includes("Transaction has been canceled") ||
      m.includes("channel is being closed") ||
      m.includes("BadSessionClosed") ||
      m.includes("BadSessionIdInvalid") ||
      m.includes("BadConnectionClosed") ||
      m.includes("BadSecureChannelClosed")
    );
  }

  /**
   * Public reconnect entry point — owns the retry loop, exponential
   * backoff, and single-flight lock. Consumer nodes call this instead
   * of running their own retry logic. (DEBT-01)
   *
   * Concurrent callers share the same in-flight Promise. The internal
   * field is nulled in .finally() so a fresh attempt is allowed once the
   * current one settles.
   *
   * @param {Object} [opts]
   * @param {number} [opts.maxAttempts] default this.maxReconnectAttempts;
   *                                    0 = infinite retry.
   * @param {number} [opts.initialDelay=2000] base backoff in ms.
   * @param {number} [opts.maxDelay=30000]    cap for exponential backoff.
   * @param {AbortSignal} [opts.signal]       optional cancel signal.
   * @param {string} [opts.reason]            label for logging.
   * @returns {Promise<void>} resolves on success, rejects with the last
   *                          attempt's error after maxAttempts exhausted
   *                          or with `new Error("reconnect aborted")` if
   *                          the AbortSignal fires.
   */
  reconnect(opts = {}) {
    if (this._reconnectPromise) return this._reconnectPromise;

    // Cool-down coalescing: if a reconnect just succeeded and the connection
    // is currently healthy, a redundant reconnect() (e.g. from a sibling
    // operation that raced the recovery) is a no-op. We only reach a forced
    // reconnect when callers genuinely lost the connection, which flips
    // isConnected=false (see _ensureConnected / _withTimeout / chaos), so a
    // true=isConnected here means recovery already happened.
    if (
      this._reconnectCooldownMs > 0 &&
      this.isConnected &&
      this._lastReconnectSuccessAt !== null &&
      Date.now() - this._lastReconnectSuccessAt < this._reconnectCooldownMs
    ) {
      return Promise.resolve();
    }

    const maxAttempts = opts.maxAttempts !== undefined
      ? opts.maxAttempts
      : this.maxReconnectAttempts;
    const initialDelay = opts.initialDelay || RECONNECT_BASE_DELAY_MS;
    const maxDelay = opts.maxDelay || RECONNECT_MAX_DELAY_MS;
    const signal = opts.signal;

    const infinite = maxAttempts === 0;

    const run = async () => {
      this.emit("reconnecting", { reason: opts.reason });
      // Force the existing connect() path to fully reinitialise the client
      this.isConnected = false;
      this.reconnectAttempts = 0;

      let lastError = null;
      let attempt = 0;

      while (infinite || attempt < maxAttempts) {
        if (signal && signal.aborted) {
          throw new Error("reconnect aborted");
        }
        attempt++;
        try {
          await this.connect();
          this.emit("reconnected", { attempt, reason: opts.reason });
          return;
        } catch (err) {
          lastError = err;
          if (!infinite && attempt >= maxAttempts) break;
          const delay = Math.min(initialDelay * attempt, maxDelay);
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, delay);
            if (signal) {
              const onAbort = () => {
                clearTimeout(t);
                reject(new Error("reconnect aborted"));
              };
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener("abort", onAbort, { once: true });
              }
            }
          });
        }
      }

      this.emit("reconnect_failed", {
        attempts: attempt,
        reason: opts.reason,
        error: lastError,
      });
      throw lastError || new Error("reconnect failed");
    };

    this._reconnectPromise = run()
      .then((v) => {
        this._lastReconnectSuccessAt = Date.now();
        return v;
      })
      .finally(() => {
        this._reconnectPromise = null;
      });
    return this._reconnectPromise;
  }

  /**
   * Wrap a promise with a timeout. If the promise does not settle within
   * the given milliseconds the returned promise rejects and the connection
   * is marked as dead so the next message triggers a fresh reconnect.
   */
  _withTimeout(promise, ms, label) {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The session is likely dead – mark disconnected so the next
        // incoming message triggers a reconnect instead of hanging again.
        this.isConnected = false;
        reject(new Error(`Operation timed out after ${ms}ms: ${label}`));
      }, ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  async connect() {
    if (this.isConnected) return;

    // Clean up previous client to avoid orphaned event handlers
    // that could interfere with the new connection's state.
    if (this.client) {
      try {
        this.client.removeAllListeners();
        if (this.session) { try { await this.session.close(); } catch (_) { /* ignore */ } }
        await this.client.disconnect();
      } catch (_) { /* ignore – best effort cleanup */ }
      this.client = null;
      this.session = null;
    }

    try {
      let securityMode = MessageSecurityMode.None;
      if (
        this.config.securityMode &&
        typeof this.config.securityMode === "string"
      ) {
        securityMode =
          MessageSecurityMode[this.config.securityMode] ||
          MessageSecurityMode.None;
      }

      let securityPolicy = SecurityPolicy.None;
      if (
        this.config.securityPolicy &&
        typeof this.config.securityPolicy === "string"
      ) {
        securityPolicy =
          SecurityPolicy[this.config.securityPolicy] || SecurityPolicy.None;
      }

      const clientOptions = {
        applicationName:
          this.config.applicationName || "Node-RED OPC UA Client",
        connectionStrategy: {
          initialDelay: 1000,
          maxRetry: this.maxReconnectAttempts,
          maxDelay: this.reconnectDelay,
        },
        keepSessionAlive: true,
        requestedSessionTimeout: 60000,
        securityMode,
        securityPolicy,
        endpointMustExist: false,
      };

      // Certificate support
      if (
        this.config.certificateFile &&
        fs.existsSync(this.config.certificateFile)
      ) {
        clientOptions.certificateFile = this.config.certificateFile;
      }
      if (
        this.config.privateKeyFile &&
        fs.existsSync(this.config.privateKeyFile)
      ) {
        clientOptions.privateKeyFile = this.config.privateKeyFile;
      }
      if (
        this.config.caCertificateFile &&
        fs.existsSync(this.config.caCertificateFile)
      ) {
        clientOptions.serverCertificate = fs.readFileSync(
          this.config.caCertificateFile,
        );
      }

      this.client = OPCUAClient.create(clientOptions);

      this.client.on("backoff", (retry, delay) => {
        this.emit("backoff", { retry, delay });
      });

      this.client.on("start_reconnection", () => {
        this.emit("reconnecting");
      });

      this.client.on("connection_lost", () => {
        this.isConnected = false;
        this.emit("disconnected");
      });

      this.client.on("after_reconnection", async () => {
        // Session recovery after automatic reconnect
        try {
          let sessionReplaced = false;
          if (!this.session || this.session.isReconnecting) {
            const userIdentity = this._buildUserIdentity();
            this.session = await this.client.createSession(userIdentity);
            sessionReplaced = true;
          }
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit("connected");
          // The prior session (e.g. after a Siemens S7 server-side session
          // timeout) is gone; tell consumers to rebuild their subscriptions
          // on the fresh session instead of reusing the dead handles.
          if (sessionReplaced) this._handleSessionReplaced();
        } catch (error) {
          this.emit("error", error);
          this.isConnected = false;
          this.scheduleReconnect();
        }
      });

      this.client.on("connection_failed", () => {
        this.isConnected = false;
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      await this.client.connect(this.config.endpointUrl);

      // Build user identity based on available credentials
      const userIdentity = this._buildUserIdentity();
      this.session = await this.client.createSession(userIdentity);

      this.isConnected = true;
      this.reconnectAttempts = 0;
      const wasReconnect = this._everConnected;
      this._everConnected = true;
      this.emit("connected");
      // A full connect() during a reconnect (public reconnect() / operation
      // retry loop / scheduleReconnect) also stands up a fresh session, so
      // any subscriptions from the previous one are dead — replay them.
      if (wasReconnect) this._handleSessionReplaced();
    } catch (error) {
      this.emit("error", error);
      this.scheduleReconnect();
      throw error;
    }
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const subscription of this.subscriptions.values()) {
      try {
        await subscription.terminate();
      } catch (e) {
        /* ignore */
      }
    }
    this.subscriptions.clear();

    if (this.session) {
      try {
        await this.session.close();
      } catch (e) {
        /* ignore */
      }
      this.session = null;
    }

    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (e) {
        /* ignore */
      }
      this.client = null;
    }

    this.isConnected = false;
    this.emit("disconnected");
  }

  scheduleReconnect() {
    if (
      this.reconnectTimer ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    )
      return;

    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (e) {
        /* handled by connect */
      }
    }, this.reconnectDelay);
  }

  // ─── Helpers ───

  _buildUserIdentity() {
    // X509 certificate-based authentication
    if (this.config.userCertificateFile && this.config.userPrivateKeyFile) {
      const certFile = this.config.userCertificateFile;
      const keyFile = this.config.userPrivateKeyFile;
      if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
        return {
          type: 2, // UserTokenType.Certificate
          certificateData: fs.readFileSync(certFile),
          privateKey: fs.readFileSync(keyFile, "utf8"),
        };
      }
    }
    // Username/Password authentication
    if (this.config.userName) {
      return {
        userName: this.config.userName,
        password: this.config.password,
      };
    }
    // Anonymous
    return {};
  }

  _toOpcUaNodeId(nodeId) {
    if (typeof nodeId === "string") {
      return resolveNodeId(nodeId);
    } else if (nodeId && nodeId.namespaceIndex !== undefined) {
      return resolveNodeId(nodeIdToString(nodeId));
    }
    return nodeId;
  }

  _createVariant(value, datatype, arrayType = null) {
    // Array (ValueRank) support: when the caller flags an array, build the
    // Variant with VariantArrayType.Array. Type inference probes the first
    // element so the element DataType is still detected for auto mode.
    const wantArray =
      arrayType === "Array" ||
      arrayType === true ||
      arrayType === VariantArrayType.Array;
    const base = wantArray ? { arrayType: VariantArrayType.Array } : {};

    if (datatype) {
      const dt = DataType[datatype];
      if (dt !== undefined) {
        return new Variant({ ...base, dataType: dt, value });
      }
    }
    const probe = wantArray && Array.isArray(value) ? value[0] : value;
    if (typeof probe === "boolean")
      return new Variant({ ...base, dataType: DataType.Boolean, value });
    if (typeof probe === "number") {
      return Number.isInteger(probe)
        ? new Variant({ ...base, dataType: DataType.Int32, value })
        : new Variant({ ...base, dataType: DataType.Double, value });
    }
    if (typeof probe === "string")
      return new Variant({ ...base, dataType: DataType.String, value });
    if (probe instanceof Date)
      return new Variant({ ...base, dataType: DataType.DateTime, value });
    return new Variant({ ...base, value });
  }

  // ─── ExtensionObject Helpers ───

  /**
   * Construct an OPC UA ExtensionObject from a plain JSON object.
   * Uses the session's DataType manager to resolve the structured type.
   *
   * @param {string|NodeId} dataTypeNodeId - NodeId of the DataType definition (e.g. "ns=2;i=3003")
   * @param {Object} fields - Plain object with field values, e.g. { temperature: 25.5, unit: "C" }
   * @returns {Promise<ExtensionObject>} The constructed ExtensionObject ready for writing
   */
  async constructExtensionObject(dataTypeNodeId, fields = {}) {
    this._ensureConnected();
    const dtNodeId =
      typeof dataTypeNodeId === "string"
        ? coerceNodeId(dataTypeNodeId)
        : dataTypeNodeId;

    try {
      const extObj = await this._withTimeout(
        this.session.constructExtensionObject(dtNodeId, fields),
        this.operationTimeout,
        "constructExtensionObject",
      );
      return extObj;
    } catch (error) {
      throw new Error(
        `Failed to construct ExtensionObject for DataType ${dtNodeId}: ${error.message}`,
      );
    }
  }

  /**
   * Create a Variant for an ExtensionObject value.
   * Constructs the ExtensionObject from a plain JSON object using the session's type system.
   *
   * @param {Object} value - Plain object with field values
   * @param {string|NodeId} dataTypeNodeId - NodeId of the DataType definition
   * @returns {Promise<Variant>} A Variant with DataType.ExtensionObject
   */
  async _createExtensionObjectVariant(value, dataTypeNodeId) {
    const extObj = await this.constructExtensionObject(dataTypeNodeId, value);
    return new Variant({ dataType: DataType.ExtensionObject, value: extObj });
  }

  /**
   * Serialize a read result value, converting ExtensionObjects to plain JSON.
   * @param {*} value - The raw value from a DataValue
   * @returns {*} Plain JSON-friendly value
   */
  _serializeValue(value) {
    if (value === null || value === undefined) return value;
    // Single ExtensionObject — has a schema property (node-opcua typed ExtensionObject)
    if (typeof value === "object" && value.schema) {
      return serializeExtensionObject(value);
    }
    // OpaqueStructure — check via instanceof when available, otherwise duck-type
    if (
      (OpaqueStructure && value instanceof OpaqueStructure) ||
      (!OpaqueStructure &&
        value.constructor &&
        value.constructor.name === "OpaqueStructure")
    ) {
      return serializeExtensionObject(value);
    }
    // Array of ExtensionObjects
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value[0] &&
      (value[0].schema || value[0] instanceof OpaqueStructure)
    ) {
      return value.map((v) => serializeExtensionObject(v));
    }
    return value;
  }

  _ensureConnected() {
    if (!this.isConnected || !this.session) {
      throw new Error("Not connected");
    }
    // Detect sessions that node-opcua has already marked as closed/invalid.
    // hasBeenClosed is a method in node-opcua (not a property).
    const closed = typeof this.session.hasBeenClosed === "function"
      ? this.session.hasBeenClosed()
      : this.session.hasBeenClosed;
    if (this.session.isReconnecting || closed) {
      this.isConnected = false;
      throw new Error("Session is no longer valid");
    }
  }

  // ─── Single Read ───

  async read(nodeId) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);
      const dataValue = await this._withTimeout(
        this.session.read({
          nodeId: opcuaNodeId,
          attributeId: AttributeIds.Value,
        }),
        this.operationTimeout,
        "read",
      );

      // If Value attribute is invalid (e.g. Object/ObjectType nodes),
      // fall back to reading common attributes instead.
      if (
        dataValue.statusCode.value !== 0 &&
        dataValue.statusCode.name === "BadAttributeIdInvalid"
      ) {
        return await this._readNodeAttributes(opcuaNodeId);
      }

      const rawValue = dataValue.value?.value;
      return {
        value: this._serializeValue(rawValue),
        dataType:
          dataValue.value?.dataType !== undefined
            ? DataType[dataValue.value.dataType]
            : undefined,
        statusCode: dataValue.statusCode.toString(),
        sourceTimestamp: dataValue.sourceTimestamp,
        serverTimestamp: dataValue.serverTimestamp,
      };
    } catch (error) {
      throw new Error(`Error reading: ${error.message}`);
    }
  }

  /**
   * Read common attributes for non-Variable nodes (Objects, ObjectTypes, etc.)
   * Returns nodeClass, browseName, displayName, and description.
   */
  async _readNodeAttributes(opcuaNodeId) {
    const attrs = [
      AttributeIds.NodeClass,
      AttributeIds.BrowseName,
      AttributeIds.DisplayName,
      AttributeIds.Description,
    ];
    const nodesToRead = attrs.map((attributeId) => ({
      nodeId: opcuaNodeId,
      attributeId,
    }));
    const results = await this._withTimeout(
      this.session.read(nodesToRead),
      this.operationTimeout,
      "readNodeAttributes",
    );
    const [nodeClassDv, browseNameDv, displayNameDv, descriptionDv] = results;

    return {
      value: {
        nodeClass: nodeClassDv.value?.value,
        browseName: browseNameDv.value?.value?.name || browseNameDv.value?.value?.toString(),
        displayName: displayNameDv.value?.value?.text || displayNameDv.value?.value?.toString(),
        description: descriptionDv.value?.value?.text || descriptionDv.value?.value?.toString() || null,
      },
      dataType: "Object",
      statusCode: "Good (0x00000000)",
      sourceTimestamp: nodeClassDv.sourceTimestamp,
      serverTimestamp: nodeClassDv.serverTimestamp,
    };
  }

  // ─── Read Attribute (read any attribute) ───

  async readAttribute(nodeId, attributeId) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);
      const attrId =
        typeof attributeId === "string"
          ? AttributeIds[attributeId] || AttributeIds.Value
          : attributeId || AttributeIds.Value;

      const dataValue = await this._withTimeout(
        this.session.read({
          nodeId: opcuaNodeId,
          attributeId: attrId,
        }),
        this.operationTimeout,
        "readAttribute",
      );
      return {
        value: dataValue.value?.value,
        statusCode: dataValue.statusCode.toString(),
        sourceTimestamp: dataValue.sourceTimestamp,
        serverTimestamp: dataValue.serverTimestamp,
      };
    } catch (error) {
      throw new Error(`Error reading attribute: ${error.message}`);
    }
  }

  // ─── Multiple Read ───

  async readMultiple(nodeIds) {
    this._ensureConnected();
    try {
      const nodesToRead = nodeIds.map((nodeId) => ({
        nodeId: this._toOpcUaNodeId(nodeId),
        attributeId: AttributeIds.Value,
      }));

      const dataValues = await this._withTimeout(
        this.session.read(nodesToRead),
        this.operationTimeout,
        "readMultiple",
      );
      const results = Array.isArray(dataValues) ? dataValues : [dataValues];

      // Process results, falling back to attribute read for Object nodes
      const processedResults = await Promise.all(
        results.map(async (dataValue, index) => {
          const nodeIdStr =
            typeof nodeIds[index] === "string"
              ? nodeIds[index]
              : nodeIdToString(nodeIds[index]);

          // Fall back for non-Variable nodes (e.g. Objects)
          if (
            dataValue.statusCode.value !== 0 &&
            dataValue.statusCode.name === "BadAttributeIdInvalid"
          ) {
            const fallback = await this._readNodeAttributes(
              this._toOpcUaNodeId(nodeIds[index]),
            );
            return { ...fallback, nodeId: nodeIdStr };
          }

          return {
            nodeId: nodeIdStr,
            value: this._serializeValue(dataValue.value?.value),
            dataType:
              dataValue.value?.dataType !== undefined
                ? DataType[dataValue.value.dataType]
                : undefined,
            statusCode: dataValue.statusCode.toString(),
            sourceTimestamp: dataValue.sourceTimestamp,
            serverTimestamp: dataValue.serverTimestamp,
          };
        }),
      );

      return processedResults;
    } catch (error) {
      throw new Error(`Error reading multiple values: ${error.message}`);
    }
  }

  // ─── Single Write ───

  async write(nodeId, value, datatype = null, dataTypeNodeId = null, arrayType = null) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);
      let variant;

      // ExtensionObject: construct from plain JSON using the session's type system
      if (datatype === "ExtensionObject" && dataTypeNodeId) {
        variant = await this._createExtensionObjectVariant(
          value,
          dataTypeNodeId,
        );
      } else {
        variant = this._createVariant(value, datatype, arrayType);
      }

      const statusCode = await this._withTimeout(
        this.session.write({
          nodeId: opcuaNodeId,
          attributeId: AttributeIds.Value,
          value: { value: variant },
        }),
        this.operationTimeout,
        "write",
      );

      return { statusCode: statusCode.toString() };
    } catch (error) {
      throw new Error(`Error writing: ${error.message}`);
    }
  }

  // ─── Multiple Write ───

  async writeMultiple(items) {
    this._ensureConnected();
    try {
      // Build write items — some may need async ExtensionObject construction
      const nodesToWrite = await Promise.all(
        items.map(async (item) => {
          let variant;
          if (item.datatype === "ExtensionObject" && item.dataTypeNodeId) {
            variant = await this._createExtensionObjectVariant(
              item.value,
              item.dataTypeNodeId,
            );
          } else {
            variant = this._createVariant(
              item.value,
              item.datatype,
              item.arrayType,
            );
          }
          return {
            nodeId: this._toOpcUaNodeId(item.nodeId),
            attributeId: AttributeIds.Value,
            value: { value: variant },
          };
        }),
      );

      const statusCodes = await this._withTimeout(
        this.session.write(nodesToWrite),
        this.operationTimeout,
        "writeMultiple",
      );
      const results = Array.isArray(statusCodes) ? statusCodes : [statusCodes];

      return results.map((statusCode, index) => ({
        nodeId:
          typeof items[index].nodeId === "string"
            ? items[index].nodeId
            : nodeIdToString(items[index].nodeId),
        value: items[index].value,
        statusCode: statusCode.toString(),
      }));
    } catch (error) {
      throw new Error(`Error writing multiple values: ${error.message}`);
    }
  }

  // ─── Method Call ───

  async callMethod(objectId, methodId, inputArguments = []) {
    this._ensureConnected();
    try {
      const opcuaObjectId = this._toOpcUaNodeId(objectId);
      const opcuaMethodId = this._toOpcUaNodeId(methodId);

      // Convert input arguments to Variants if necessary
      // Some may be ExtensionObjects requiring async construction
      const args = await Promise.all(
        inputArguments.map(async (arg) => {
          if (arg instanceof Variant) return arg;
          if (arg && arg.dataType !== undefined && arg.value !== undefined) {
            // ExtensionObject input argument
            if (
              (arg.dataType === "ExtensionObject" ||
                arg.dataType === DataType.ExtensionObject) &&
              arg.dataTypeNodeId
            ) {
              return await this._createExtensionObjectVariant(
                arg.value,
                arg.dataTypeNodeId,
              );
            }
            const dt =
              typeof arg.dataType === "string"
                ? DataType[arg.dataType]
                : arg.dataType;
            return new Variant({
              dataType: dt || DataType.Null,
              value: arg.value,
            });
          }
          // Auto-detect
          return this._createVariant(arg, null);
        }),
      );

      const result = await this._withTimeout(
        this.session.call({
          objectId: opcuaObjectId,
          methodId: opcuaMethodId,
          inputArguments: args,
        }),
        this.operationTimeout,
        "callMethod",
      );

      return {
        statusCode: result.statusCode.toString(),
        outputArguments: (result.outputArguments || []).map((arg) => ({
          dataType: DataType[arg.dataType] || arg.dataType,
          value: this._serializeValue(arg.value),
        })),
        inputArgumentResults: result.inputArgumentResults || [],
      };
    } catch (error) {
      throw new Error(`Error calling method: ${error.message}`);
    }
  }

  // ─── History Read ───

  async historyRead(nodeId, startTime, endTime, options = {}) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);

      const start = startTime instanceof Date ? startTime : new Date(startTime);
      const end = endTime instanceof Date ? endTime : new Date(endTime);

      const historyReadResult = await this._withTimeout(
        this.session.readHistoryValue(
          opcuaNodeId,
          start,
          end,
          {
            numValuesPerNode: options.maxValues || 1000,
            isReadModified: options.isReadModified || false,
            returnBounds: options.returnBounds || false,
          },
        ),
        this.operationTimeout,
        "historyRead",
      );

      const values = (historyReadResult.historyData?.dataValues || []).map(
        (dv) => ({
          value: this._serializeValue(dv.value?.value),
          statusCode: dv.statusCode?.toString(),
          sourceTimestamp: dv.sourceTimestamp,
          serverTimestamp: dv.serverTimestamp,
        }),
      );

      return {
        nodeId: typeof nodeId === "string" ? nodeId : nodeIdToString(nodeId),
        statusCode: historyReadResult.statusCode?.toString(),
        values,
        count: values.length,
        continuationPoint: historyReadResult.continuationPoint || null,
      };
    } catch (error) {
      throw new Error(`Error reading history: ${error.message}`);
    }
  }

  // ─── Subscription ───

  async createSubscription(options = {}) {
    this._ensureConnected();
    try {
      const subscription = ClientSubscription.create(this.session, {
        requestedPublishingInterval: options.interval || 1000,
        requestedLifetimeCount: options.lifetimeCount || 100,
        requestedMaxKeepAliveCount: options.maxKeepAliveCount || 10,
        maxNotificationsPerPublish: options.maxNotificationsPerPublish || 100,
        publishingEnabled: true,
        priority: options.priority || 10,
      });

      subscription.on("started", () =>
        this.emit("subscription_started", subscription),
      );
      subscription.on("keepalive", () =>
        this.emit("subscription_keepalive", subscription),
      );
      subscription.on("terminated", () => {
        this.subscriptions.delete(subscription.subscriptionId);
        this.emit("subscription_terminated", subscription);
      });

      this.subscriptions.set(subscription.subscriptionId, subscription);
      return subscription;
    } catch (error) {
      throw new Error(`Error creating subscription: ${error.message}`);
    }
  }

  // ─── Browse ───

  /**
   * Follow a BrowseResult's continuation points until the server has
   * returned all references. Servers with a low per-browse reference
   * limit (e.g. Siemens S7-1500 caps at 100) set a continuationPoint
   * instead of returning everything at once.
   */
  async _resolveContinuationPoints(browseResult) {
    const references = [...(browseResult.references || [])];
    let continuationPoint = browseResult.continuationPoint;
    // Safety cap so a misbehaving server returning the same
    // continuation point forever cannot lock us in a loop.
    let remainingRounds = 1000;
    while (
      continuationPoint &&
      continuationPoint.length > 0 &&
      remainingRounds-- > 0
    ) {
      const nextResult = await this._withTimeout(
        this.session.browseNext(continuationPoint, false),
        this.operationTimeout,
        "browseNext",
      );
      references.push(...(nextResult.references || []));
      continuationPoint = nextResult.continuationPoint;
    }
    return references;
  }

  async browse(nodeId) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);
      const browseResult = await this._withTimeout(
        this.session.browse({
          nodeId: opcuaNodeId,
          resultMask: 63,
        }),
        this.operationTimeout,
        "browse",
      );
      if (
        browseResult.statusCode &&
        typeof browseResult.statusCode.isNotGood === "function" &&
        browseResult.statusCode.isNotGood()
      ) {
        throw new Error(browseResult.statusCode.toString());
      }
      return await this._resolveContinuationPoints(browseResult);
    } catch (error) {
      throw new Error(`Browse error: ${error.message}`);
    }
  }

  // ─── Translate Browse Path ───

  async translateBrowsePath(startNodeId, relativePath) {
    this._ensureConnected();
    try {
      const browsePath = makeBrowsePath(
        this._toOpcUaNodeId(startNodeId),
        relativePath,
      );

      const result = await this._withTimeout(
        this.session.translateBrowsePath(browsePath),
        this.operationTimeout,
        "translateBrowsePath",
      );
      if (
        result.statusCode.isGood() &&
        result.targets &&
        result.targets.length > 0
      ) {
        return {
          statusCode: result.statusCode.toString(),
          targets: result.targets.map((t) => ({
            nodeId: t.targetId.toString(),
            remainingPathIndex: t.remainingPathIndex,
          })),
        };
      }
      return {
        statusCode: result.statusCode.toString(),
        targets: [],
      };
    } catch (error) {
      throw new Error(`Error in TranslateBrowsePath: ${error.message}`);
    }
  }

  // ─── Register / Unregister Nodes ───

  async registerNodes(nodeIds) {
    this._ensureConnected();
    try {
      const opcuaNodeIds = nodeIds.map((n) => this._toOpcUaNodeId(n));
      const result = await this._withTimeout(
        this.session.registerNodes(opcuaNodeIds),
        this.operationTimeout,
        "registerNodes",
      );
      return (result.registeredNodeIds || []).map((n) => n.toString());
    } catch (error) {
      throw new Error(`Error in RegisterNodes: ${error.message}`);
    }
  }

  async unregisterNodes(nodeIds) {
    this._ensureConnected();
    try {
      const opcuaNodeIds = nodeIds.map((n) => this._toOpcUaNodeId(n));
      await this._withTimeout(
        this.session.unregisterNodes(opcuaNodeIds),
        this.operationTimeout,
        "unregisterNodes",
      );
      return { success: true };
    } catch (error) {
      throw new Error(`Error in UnregisterNodes: ${error.message}`);
    }
  }

  // ─── Get Endpoints (Discovery) ───

  async getEndpoints(endpointUrl) {
    try {
      const url = endpointUrl || this.config.endpointUrl;
      const client = OPCUAClient.create({
        endpointMustExist: false,
      });
      await client.connect(url);
      const endpoints = await client.getEndpoints();
      await client.disconnect();

      return endpoints.map((ep) => ({
        endpointUrl: ep.endpointUrl,
        securityMode: MessageSecurityMode[ep.securityMode] || ep.securityMode,
        securityPolicy: ep.securityPolicyUri?.split("#").pop() || "",
        serverCertificate: ep.serverCertificate ? "(present)" : "(none)",
        userIdentityTokens: (ep.userIdentityTokens || []).map((t) => ({
          policyId: t.policyId,
          tokenType: t.tokenType,
        })),
      }));
    } catch (error) {
      throw new Error(`Error in GetEndpoints: ${error.message}`);
    }
  }

  // ─── Expose session for advanced operations ───

  getSession() {
    this._ensureConnected();
    return this.session;
  }
}

module.exports = OpcUaClientManager;

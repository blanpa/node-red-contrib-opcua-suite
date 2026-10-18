/**
 * OPC UA Client Manager
 * Manages OPC UA client connections with automatic reconnect
 */

const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  ClientSubscription,
  resolveNodeId,
  Variant,
  VariantArrayType,
  DataType,
  AttributeIds,
  makeBrowsePath,
  coerceNodeId,
  ExtensionObject,
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
const {
  nodeIdToString,
  serializeExtensionObject,
  terminateWithin,
} = require("./opcua-utils");
const {
  buildVariant,
  resolveDataType,
  looksLikeStructure,
} = require("./opcua-variant");
const { prepareClientCertificate } = require("./pki-lock");

// Reconnect retry-loop tuning (DEBT-01: owned by the manager, not by node code)
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
// Cap for the background reconnect back-off (scheduleReconnect). It never
// gives up, so a long outage settles at one attempt per minute.
const BACKGROUND_RECONNECT_MAX_DELAY_MS = 60000;

// Editor values arrive as strings and an explicit 0 is meaningful, so a
// plain `value || fallback` (which turned "0"/0 into the fallback, or let
// the string "0" through as truthy) is not enough.
function toCount(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Marks an OPCUAClient this manager has already torn down, so the several
// teardown paths that can meet on one client (disconnect(), an aborted
// connect attempt, the next connect's cleanup) disconnect it only once.
const DISPOSED = Symbol("opcua-suite.disposed");

function closedError() {
  return new Error("Connection closed");
}

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
    // How often node-opcua retries inside ONE connect attempt before it
    // fails — which is also how long a message waits for a connection. The
    // background reconnect (scheduleReconnect) is not bounded by this.
    this.maxReconnectAttempts = toCount(config.maxReconnectAttempts, 10);
    this.reconnectDelay = toCount(config.reconnectDelay, 5000) || 5000;
    this.operationTimeout = config.operationTimeout || 10000; // 10s default
    // Single-flight lock for reconnect() — DEBT-01
    this._reconnectPromise = null;
    // Single-flight lock for connect() — issue #17. See connect().
    this._connectPromise = null;
    // Pending wait for node-opcua's own session repair after it restored
    // the secure channel. See _onAfterReconnection().
    this._repairWait = null;
    // One lifecycle per connect…disconnect span. disconnect() aborts it, and
    // every connect attempt, retry loop and reconnect timer started under it
    // stands down instead of reviving a connection nobody owns any more.
    this._lifecycle = new AbortController();
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
    // An EventEmitter with no "error" listener THROWS the emitted error at the
    // emit() call site. Inside connect()'s catch that silently skipped the
    // scheduleReconnect() below it, and inside the async "after_reconnection"
    // handler it became an unhandled rejection. Consumers that care (the
    // endpoint config node, the pool) still attach their own listener; this
    // one only guarantees emit("error") never throws.
    this.on("error", () => {});
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
      m.includes("BadSecureChannelClosed") ||
      // node-opcua fails requests that were queued while it repaired the
      // session if the repair is abandoned ("client or session is not
      // usable anymore"); the connection is gone, so retry like the rest.
      m.includes("Failure during reconnection") ||
      // _withTimeout already flips isConnected=false when an operation
      // overruns, so the connection IS considered dead — but the message did
      // not match anything here, so the caller's retry loop skipped the
      // reconnect and failed the message outright. The very next message then
      // reconnected and succeeded, which is exactly the "one lost message per
      // hiccup" pattern. Classify it so the retry loop handles it.
      m.includes("Operation timed out after")
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

    // Only an explicit opts.maxAttempts of 0 means "retry forever". The
    // default comes from maxReconnectAttempts, where 0 means "no retries
    // inside a connect" — it must not turn every node's reconnect() into an
    // endless loop, so it counts as a single attempt here.
    const maxAttempts =
      opts.maxAttempts !== undefined
        ? opts.maxAttempts
        : Math.max(1, this.maxReconnectAttempts);
    const initialDelay = opts.initialDelay || RECONNECT_BASE_DELAY_MS;
    const maxDelay = opts.maxDelay || RECONNECT_MAX_DELAY_MS;
    const signal = opts.signal;

    const infinite = maxAttempts === 0;

    const life = this._lifecycle.signal;
    const signals = signal ? [signal, life] : [life];
    const aborted = () => signals.some((s) => s.aborted);

    const run = async () => {
      this.emit("reconnecting", { reason: opts.reason });
      // Force the existing connect() path to fully reinitialise the client
      this.isConnected = false;
      this.reconnectAttempts = 0;

      let lastError = null;
      let attempt = 0;

      while (infinite || attempt < maxAttempts) {
        if (aborted()) {
          throw new Error("reconnect aborted");
        }
        attempt++;
        try {
          await this.connect();
          this.emit("reconnected", { attempt, reason: opts.reason });
          return;
        } catch (err) {
          // disconnect() ended this lifecycle: stop instead of retrying.
          if (life.aborted) throw new Error("reconnect aborted");
          lastError = err;
          if (!infinite && attempt >= maxAttempts) break;
          const delay = Math.min(initialDelay * attempt, maxDelay);
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(t);
              for (const s of signals) s.removeEventListener("abort", onAbort);
              reject(new Error("reconnect aborted"));
            };
            const t = setTimeout(() => {
              for (const s of signals) s.removeEventListener("abort", onAbort);
              resolve();
            }, delay);
            if (aborted()) {
              onAbort();
            } else {
              for (const s of signals) {
                s.addEventListener("abort", onAbort, { once: true });
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
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Public connect entry point with a single-flight lock.
   *
   * Every consumer node calls connect() on the SHARED manager when its flow
   * is deployed (opcua-client autoConnect, and the lazy `if (!isConnected)
   * await connect()` in browser/method/event/browse-client). Without a lock
   * those calls all pass the `isConnected` check in the same tick and each
   * builds its own OPCUAClient + session; only the last assignment survives
   * in this.client/this.session, so every earlier session is orphaned —
   * still open on the server, kept alive by `keepSessionAlive`, and invisible
   * to disconnect(). Each redeploy leaked another round until the server hit
   * its session limit and answered "connection was rejected by the server"
   * (issue #17).
   *
   * Concurrent callers now share one in-flight attempt; the field is nulled
   * in .finally() so a later call can start a fresh one.
   */
  connect() {
    if (this.isConnected) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = this._doConnect().finally(() => {
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  async _doConnect() {
    const life = this._lifecycle.signal;

    // Clean up previous client to avoid orphaned event handlers
    // that could interfere with the new connection's state.
    if (this.client) {
      const previous = this.client;
      previous.removeAllListeners();
      if (this.session) {
        try {
          await this.session.close();
        } catch (_) {
          /* ignore */
        }
      }
      await this._disposeClient(previous);
      if (this.client === previous) {
        this.client = null;
        this.session = null;
      }
    }

    let client = null;
    let session = null;
    try {
      if (life.aborted) throw closedError();

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
        connectionStrategy: this._connectionStrategy(),
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

      client = OPCUAClient.create(clientOptions);
      this.client = client;

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

      this.client.on("after_reconnection", () => {
        this._onAfterReconnection(client).catch((error) => {
          this.emit("error", error);
        });
      });

      this.client.on("connection_failed", () => {
        this.isConnected = false;
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      await prepareClientCertificate(client);
      if (life.aborted) throw closedError();
      await client.connect(this.config.endpointUrl);
      if (life.aborted) throw closedError();

      // Build user identity based on available credentials
      const userIdentity = this._buildUserIdentity();
      try {
        session = await client.createSession(userIdentity);
      } catch (sessionError) {
        // The secure channel is up but the session was refused (bad
        // credentials, session limit reached, ...). Tear the channel down
        // here — otherwise it stays open on the server until the socket
        // times out and counts against maxConnectionsPerEndpoint.
        await this._disposeClient(client);
        if (this.client === client) this.client = null;
        throw sessionError;
      }
      if (life.aborted) throw closedError();
      this.session = session;

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
      if (life.aborted) {
        // disconnect() ran while this attempt was in flight. Release what
        // it opened and stay quiet: no "error" for the nodes being closed,
        // and above all no scheduleReconnect() that would reconnect later
        // and leave a session open that no node owns any more.
        if (session) {
          try {
            await session.close();
          } catch (_) {
            /* ignore */
          }
        }
        await this._disposeClient(client);
        if (this.client === client) {
          this.client = null;
          this.session = null;
        }
        throw closedError();
      }
      this.emit("error", error);
      this.scheduleReconnect();
      throw error;
    }
  }

  /**
   * Disconnects `client` once, however many teardown paths reach it.
   * Disconnecting also aborts a client.connect() still retrying an
   * unreachable endpoint, which then rejects at once.
   */
  async _disposeClient(client) {
    if (!client || client[DISPOSED]) return;
    client[DISPOSED] = true;
    client.removeAllListeners();
    try {
      await client.disconnect();
    } catch (_) {
      /* ignore – best effort cleanup */
    }
  }

  /**
   * Runs after node-opcua has re-established the secure channel on its own
   * (server restart, network drop). node-opcua emits "after_reconnection"
   * BEFORE it repairs the session: it then re-activates the existing
   * session, or creates a replacement and transfers/recreates every
   * subscription onto it, retrying every 2 s until that succeeds. The
   * ClientSession and ClientSubscription objects survive the repair, so
   * consumer handles stay valid and no "session_recreated" is needed.
   *
   * This used to create a second session here and close the one node-opcua
   * was repairing. The repair then failed forever ("session has no
   * userIdentityInfo"), the replayed subscribes landed on a session that was
   * itself mid-reconnect ("Session is no longer valid"), and subscriptions
   * stayed dead while the status showed "connected".
   *
   * Only when the repair ends with the session closed do we fall back to a
   * full connect(), which stands up a fresh client + session and fires
   * "session_recreated" so consumers rebuild.
   */
  async _onAfterReconnection(client) {
    // Single-flight: a flapping link fires after_reconnection repeatedly;
    // the waiter already running covers the newer repair too.
    if (this._repairWait) return;
    const session = this.session;
    const stale = () => this.client !== client || this.session !== session;

    if (session) {
      this._repairWait = this._waitForSessionRepair(session, stale);
      try {
        await this._repairWait;
      } finally {
        this._repairWait = null;
      }
    }
    // A full connect()/disconnect() replaced or dropped this client while
    // we waited; it owns the state now.
    if (stale()) return;

    const closed =
      !session ||
      (typeof session.hasBeenClosed === "function"
        ? session.hasBeenClosed()
        : session.hasBeenClosed);
    if (closed) {
      this.isConnected = false;
      try {
        await this.connect();
      } catch (_) {
        /* _doConnect already emitted "error" and scheduled a retry */
      }
      return;
    }

    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.emit("connected");
  }

  /**
   * Resolves once node-opcua has stopped repairing `session` (successfully
   * or by closing it), or as soon as `isStale()` reports that the manager
   * moved on to another client/session. node-opcua exposes no single
   * "repair finished" event for both outcomes, so poll isReconnecting.
   */
  _waitForSessionRepair(session, isStale) {
    return new Promise((resolve) => {
      const check = () => {
        if (isStale() || !session.isReconnecting) {
          clearInterval(timer);
          resolve();
        }
      };
      const timer = setInterval(check, 100);
      if (timer.unref) timer.unref();
      check();
    });
  }

  async disconnect() {
    // End the lifecycle first: every connect attempt, retry loop and timer
    // still running belongs to it and must not bring the connection back.
    this._lifecycle.abort();
    this._lifecycle = new AbortController();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // A redeploy can land while connect() is still in flight. Waiting it out
    // took up to ~40 s with the defaults (node-opcua retries an unreachable
    // endpoint maxReconnectAttempts times inside client.connect()), far past
    // Node-RED's 15 s close timeout. Disconnecting the in-flight client
    // aborts that at once; the attempt then sees the aborted lifecycle and
    // releases whatever it had opened itself.
    if (this._connectPromise) {
      await this._disposeClient(this.client);
      try {
        await this._connectPromise;
      } catch (_) {
        /* ignore – we are shutting down anyway */
      }
    }

    // Offline, node-opcua holds subscription/session requests until the
    // channel is back — terminate() would block the close indefinitely.
    // Disconnecting the client first cancels its reconnection and makes the
    // teardown below settle at once; there is no server to tell anyway.
    const offline =
      !this.isConnected || (this.session && this.session.isReconnecting);
    if (offline && this.client) await this._disposeClient(this.client);

    await terminateWithin([...this.subscriptions.values()]);
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
      await this._disposeClient(this.client);
      this.client = null;
    }

    this.isConnected = false;
    this.emit("disconnected");
  }

  /**
   * Background reconnect after a failed connect. It never gives up while
   * the manager is in use: it used to stop after maxReconnectAttempts
   * (~8 min with the defaults), and a flow that only subscribes — no input
   * message ever triggers a connect — then stayed disconnected for good
   * once the server came back, until the next redeploy. The delay doubles
   * from reconnectDelay up to one minute. disconnect() ends the lifecycle,
   * which clears the timer and stops the chain.
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = this._backgroundReconnectDelay(this.reconnectAttempts);
    const life = this._lifecycle.signal;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (life.aborted) return;
      try {
        await this.connect();
      } catch (e) {
        /* handled by connect */
      }
    }, delay);
  }

  /**
   * node-opcua's retry strategy inside one connect attempt. Its back-off
   * requires maxDelay > initialDelay; with the old fixed initialDelay of
   * 1000 ms a reconnectDelay of 1000 (the editor's minimum) or less failed
   * every connect within milliseconds with "The maximal backoff delay…",
   * even with the server up. initialDelay therefore follows reconnectDelay.
   */
  _connectionStrategy() {
    const maxDelay = Math.max(this.reconnectDelay, 2);
    return {
      initialDelay: Math.min(1000, Math.floor(maxDelay / 2)),
      maxRetry: this.maxReconnectAttempts,
      maxDelay,
    };
  }

  _backgroundReconnectDelay(attempt) {
    const exp = Math.min(attempt - 1, 16);
    return Math.min(
      this.reconnectDelay * 2 ** exp,
      Math.max(BACKGROUND_RECONNECT_MAX_DELAY_MS, this.reconnectDelay),
    );
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
    return buildVariant(value, datatype, arrayType);
  }

  /**
   * The DataType of a variable: its DataType NodeId (a structure's own type
   * for a UDT) and the built-in type that encodes it. Cached per session —
   * a variable's DataType does not change while the session lives.
   */
  async _getVariableDataType(opcuaNodeId) {
    if (this._dataTypeCacheSession !== this.session) {
      this._dataTypeCacheSession = this.session;
      this._dataTypeCache = new Map();
    }
    const key = opcuaNodeId.toString();
    const cached = this._dataTypeCache.get(key);
    if (cached) return cached;

    const dataValue = await this._withTimeout(
      this.session.read({
        nodeId: opcuaNodeId,
        attributeId: AttributeIds.DataType,
      }),
      this.operationTimeout,
      "readDataType",
    );
    const dataTypeNodeId = dataValue.value?.value;
    if (!dataValue.statusCode?.isGood?.() || !dataTypeNodeId) {
      throw new Error(
        `Cannot read the DataType of ${key}: ${dataValue.statusCode?.toString()}`,
      );
    }
    const builtIn = await this._withTimeout(
      this.session.getBuiltInDataType(opcuaNodeId),
      this.operationTimeout,
      "getBuiltInDataType",
    );
    const info = { dataTypeNodeId, builtIn };
    this._dataTypeCache.set(key, info);
    return info;
  }

  /**
   * Builds the Variant for writing `value` to a variable.
   *
   * - `ExtensionObject` without a dataTypeNodeId takes the structure type
   *   from the variable's DataType attribute.
   * - In auto mode a plain object (or an array of them) is resolved the same
   *   way, so a UDT can be written without any type configuration.
   */
  async _createWriteVariant(
    opcuaNodeId,
    value,
    datatype,
    dataTypeNodeId,
    arrayType,
  ) {
    const dataType = resolveDataType(datatype);

    if (dataType === DataType.ExtensionObject) {
      if (value instanceof Variant) return value;
      const dtNodeId =
        dataTypeNodeId ||
        (await this._getVariableDataType(opcuaNodeId)).dataTypeNodeId;
      return this._createExtensionObjectVariant(value, dtNodeId, arrayType);
    }

    if (dataType === null && looksLikeStructure(value)) {
      const info = await this._getVariableDataType(opcuaNodeId);
      if (info.builtIn === DataType.ExtensionObject) {
        return this._createExtensionObjectVariant(
          value,
          dataTypeNodeId || info.dataTypeNodeId,
          arrayType,
        );
      }
      // A built-in type given as an object, e.g. LocalizedText {locale, text}
      return buildVariant(value, info.builtIn, arrayType);
    }

    return buildVariant(value, dataType, arrayType);
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
   * Create a Variant for an ExtensionObject value — or an array of them.
   * Constructs each ExtensionObject from a plain JSON object using the
   * session's type system.
   *
   * @param {Object|Object[]} value - Plain object(s) with field values
   * @param {string|NodeId} dataTypeNodeId - NodeId of the DataType definition
   * @param {string|boolean|null} [arrayType] - "Array" to require an array
   * @returns {Promise<Variant>} A Variant with DataType.ExtensionObject
   */
  async _createExtensionObjectVariant(value, dataTypeNodeId, arrayType = null) {
    if (Array.isArray(value)) {
      // Previously the whole array was handed to constructExtensionObject,
      // which built ONE empty structure from it — the server answered Good
      // and the array was replaced by a single default record.
      const extObjs = await Promise.all(
        value.map((fields) =>
          fields instanceof ExtensionObject
            ? fields
            : this.constructExtensionObject(dataTypeNodeId, fields),
        ),
      );
      return new Variant({
        dataType: DataType.ExtensionObject,
        arrayType: VariantArrayType.Array,
        value: extObjs,
      });
    }
    if (arrayType === "Array" || arrayType === true) {
      throw new Error("Array value expected for an ExtensionObject array");
    }
    const extObj =
      value instanceof ExtensionObject
        ? value
        : await this.constructExtensionObject(dataTypeNodeId, value);
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
    const closed =
      typeof this.session.hasBeenClosed === "function"
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
        browseName:
          browseNameDv.value?.value?.name ||
          browseNameDv.value?.value?.toString(),
        displayName:
          displayNameDv.value?.value?.text ||
          displayNameDv.value?.value?.toString(),
        description:
          descriptionDv.value?.value?.text ||
          descriptionDv.value?.value?.toString() ||
          null,
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
        value: this._serializeValue(dataValue.value?.value),
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

  async write(
    nodeId,
    value,
    datatype = null,
    dataTypeNodeId = null,
    arrayType = null,
  ) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);
      const variant = await this._createWriteVariant(
        opcuaNodeId,
        value,
        datatype,
        dataTypeNodeId,
        arrayType,
      );

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
          const opcuaNodeId = this._toOpcUaNodeId(item.nodeId);
          let variant;
          try {
            variant = await this._createWriteVariant(
              opcuaNodeId,
              item.value,
              item.datatype,
              item.dataTypeNodeId,
              item.arrayType,
            );
          } catch (error) {
            throw new Error(`${opcuaNodeId.toString()}: ${error.message}`);
          }
          return {
            nodeId: opcuaNodeId,
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
        inputArguments.map(async (arg, index) => {
          if (arg instanceof Variant) return arg;
          try {
            if (arg && arg.dataType !== undefined && arg.value !== undefined) {
              const dt = resolveDataType(arg.dataType);
              if (dt === DataType.ExtensionObject) {
                if (!arg.dataTypeNodeId) {
                  throw new Error(
                    "ExtensionObject argument needs a dataTypeNodeId",
                  );
                }
                return await this._createExtensionObjectVariant(
                  arg.value,
                  arg.dataTypeNodeId,
                  arg.arrayType,
                );
              }
              return buildVariant(arg.value, dt, arg.arrayType);
            }
            // Auto-detect
            return buildVariant(arg, null);
          } catch (error) {
            throw new Error(`Input argument ${index}: ${error.message}`);
          }
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
        this.session.readHistoryValue(opcuaNodeId, start, end, {
          numValuesPerNode: options.maxValues || 1000,
          isReadModified: options.isReadModified || false,
          returnBounds: options.returnBounds || false,
        }),
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

  /**
   * Browse one node's forward references.
   *
   * `referenceTypeId` defaults to "HierarchicalReferences" — the same default
   * node-opcua applies to `session.browse("<nodeId>")` and the same filter the
   * editor tree uses. Passing a BrowseDescription OBJECT (as this method does)
   * bypasses that default and yields `null` = every reference type, which mixed
   * HasTypeDefinition/HasSubtype links into the children of an address-space
   * browse and made recursive browsing walk into the type system.
   *
   * Callers that really want every reference type can pass
   * `{ referenceTypeId: null }`; "References" (the root reference type, with
   * includeSubtypes) is the spec-conform way to say the same thing.
   *
   * @param {string|NodeId} nodeId
   * @param {Object} [options]
   * @param {string|NodeId|null} [options.referenceTypeId="HierarchicalReferences"]
   * @param {boolean} [options.includeSubtypes=true]
   */
  async browse(nodeId, options = {}) {
    this._ensureConnected();
    try {
      const opcuaNodeId = this._toOpcUaNodeId(nodeId);
      const referenceTypeId =
        options.referenceTypeId !== undefined
          ? options.referenceTypeId
          : "HierarchicalReferences";
      const browseResult = await this._withTimeout(
        this.session.browse({
          nodeId: opcuaNodeId,
          referenceTypeId,
          includeSubtypes:
            options.includeSubtypes !== undefined
              ? options.includeSubtypes
              : true,
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
      // node-opcua resolves with the NodeId[] itself, not with the
      // RegisterNodesResponse. Reading result.registeredNodeIds always gave
      // an empty list, so the registered aliases never reached the flow.
      const registered = Array.isArray(result)
        ? result
        : (result && result.registeredNodeIds) || [];
      return registered.map((n) => n.toString());
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
      let endpoints;
      await prepareClientCertificate(client);
      await client.connect(url);
      try {
        endpoints = await client.getEndpoints();
      } finally {
        // Without the finally a throwing getEndpoints() left the discovery
        // channel open for the lifetime of the process.
        try {
          await client.disconnect();
        } catch (_) {
          /* ignore */
        }
      }

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

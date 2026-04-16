/**
 * OPC UA Client Node
 * All-in-One: Read, Write, Subscribe, Browse — single and batch
 *
 * Batch operations:
 *   msg.operation = "readmultiple"  + msg.items = [{nodeId: "ns=2;s=Var1"}, ...]
 *   msg.operation = "writemultiple" + msg.items = [{nodeId: "ns=2;s=Var1", value: 42, datatype: "Int32"}, ...]
 *
 * Single operations (as before):
 *   msg.operation = "read"  + msg.topic/msg.nodeId
 *   msg.operation = "write" + msg.topic/msg.nodeId + msg.payload
 */

const { parseNodeId, createError } = require("../lib/opcua-utils");

module.exports = function (RED) {
  function OpcUaClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const verboseLog = config.verboseLog !== false;

    const endpointConfig = RED.nodes.getNode(config.endpoint);
    if (!endpointConfig) {
      node.error("Endpoint configuration missing");
      return;
    }

    if (!endpointConfig.getSharedManager) {
      node.error(
        "Endpoint node does not support connection sharing — please update",
      );
      return;
    }

    // Get shared ClientManager from endpoint (connection sharing)
    let clientManager = endpointConfig.getSharedManager({
      applicationName: config.applicationName || "Node-RED OPC UA Client",
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      reconnectDelay: config.reconnectDelay || 5000,
    });

    let subscription = null;
    const monitorItems = new Map();

    // Expose clientManager for other nodes (Browser, Method, etc.)
    node.clientManager = clientManager;

    node.status({ fill: "red", shape: "ring", text: "not connected" });

    // Status updates via endpoint callback (shared across all clients)
    const statusCallback = (event, error) => {
      switch (event) {
        case "connected":
          node.status({ fill: "green", shape: "dot", text: "connected" });
          break;
        case "disconnected":
          node.status({ fill: "red", shape: "ring", text: "disconnected" });
          monitorItems.clear();
          break;
        case "reconnecting":
          node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
          break;
        case "error":
          if (verboseLog) node.error(`OPC UA error: ${error ? error.message : "unknown"}`);
          node.status({ fill: "red", shape: "ring", text: "error" });
          break;
      }
    };
    endpointConfig.registerStatusCallback(statusCallback);

    // If already connected (another client node connected first), update status
    if (clientManager.isConnected) {
      node.status({ fill: "green", shape: "dot", text: "connected" });
    }

    // ─── Input Handler ───

    async function executeOperation(msg, operation, send) {
      let result;

      switch (operation) {
        case "read":
          result = await handleRead(msg, clientManager);
          break;

        case "readmultiple":
          result = await handleReadMultiple(msg, clientManager);
          break;

        case "write":
          result = await handleWrite(msg, clientManager);
          break;

        case "writemultiple":
          result = await handleWriteMultiple(msg, clientManager);
          break;

        case "subscribe":
          await handleSubscribe(
            msg,
            clientManager,
            send,
            node,
            subscription,
            monitorItems,
            (sub) => {
              subscription = sub;
            },
          );
          return undefined;

        case "unsubscribe":
          result = await handleUnsubscribe(msg, monitorItems);
          break;

        case "browse":
          result = await handleBrowse(msg, clientManager);
          break;

        case "method":
          result = await handleMethod(msg, clientManager);
          break;

        case "history":
          result = await handleHistory(msg, clientManager);
          break;

        case "getendpoints":
          result = await handleGetEndpoints(msg, clientManager);
          break;

        case "readattribute":
          result = await handleReadAttribute(msg, clientManager);
          break;

        case "registernodes":
          result = await handleRegisterNodes(msg, clientManager);
          break;

        case "unregisternodes":
          result = await handleUnregisterNodes(msg, clientManager);
          break;

        case "translatebrowsepath":
          result = await handleTranslateBrowsePath(msg, clientManager);
          break;

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      return result;
    }

    function isConnectionLostError(error) {
      if (!error || !error.message) return false;
      const m = error.message;
      return m === "Session is no longer valid" ||
        m === "Not connected" ||
        m.includes("premature disconnection") ||
        m.includes("Secure Channel Closed") ||
        m.includes("connection may have been rejected") ||
        m.includes("Server end point") ||
        m.includes("socket has been disconnected");
    }

    async function ensureConnected() {
      if (!clientManager.isConnected) {
        clientManager.reconnectAttempts = 0;
        await clientManager.connect();
      }
    }

    const RECONNECT_BASE_DELAY_MS = 2000;
    const RECONNECT_MAX_DELAY_MS = 30000;
    const retryAttempts = Number(config.retryAttempts) || 0;
    let reconnectPromise = null;

    async function forceReconnect() {
      if (reconnectPromise) return reconnectPromise;
      reconnectPromise = _doForceReconnect();
      try {
        await reconnectPromise;
      } finally {
        reconnectPromise = null;
      }
    }

    async function _doForceReconnect() {
      clientManager.isConnected = false;
      clientManager.reconnectAttempts = 0;

      const infinite = retryAttempts <= 0;
      const totalLabel = infinite ? "∞" : String(retryAttempts);

      for (let attempt = 1; infinite || attempt <= retryAttempts; attempt++) {
        try {
          await clientManager.connect();
          if (verboseLog) node.warn(`Reconnected to OPC UA server (attempt ${attempt}/${totalLabel})`);
          return;
        } catch (err) {
          if (!infinite && attempt === retryAttempts) throw err;
          const delay = Math.min(RECONNECT_BASE_DELAY_MS * attempt, RECONNECT_MAX_DELAY_MS);
          if (verboseLog) node.warn(`Reconnect attempt ${attempt}/${totalLabel} failed – retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          clientManager.isConnected = false;
          clientManager.reconnectAttempts = 0;
        }
      }
    }

    node.on("input", async function (msg, send, done) {
      const operation = (
        msg.operation ||
        config.defaultOperation ||
        "read"
      ).toLowerCase();

      async function tryOnce() {
        await ensureConnected();
        return await executeOperation(msg, operation, send);
      }

      try {
        let result;
        try {
          result = await tryOnce();
        } catch (error) {
          if (isConnectionLostError(error)) {
            if (verboseLog) node.warn(`Connection lost (${error.message}) – reconnecting...`);
            node.status({ fill: "yellow", shape: "ring", text: "reconnecting..." });
            await forceReconnect();
            result = await executeOperation(msg, operation, send);
          } else {
            throw error;
          }
        }

        if (result === undefined) {
          done();
          return;
        }

        Object.assign(msg, result);
        node.status({ fill: "green", shape: "dot", text: "connected" });
        send(msg);
        done();
      } catch (error) {
        node.error(`Operation error: ${error.message}`);
        node.status({ fill: "red", shape: "ring", text: "error" });
        msg.error = createError(error.message, error);
        send(msg);
        done(error);
      }
    });

    // ─── Cleanup ───

    node.on("close", async function (removed, done) {
      for (const monitorItem of monitorItems.values()) {
        try {
          await monitorItem.terminate();
        } catch (e) {
          /* ignore */
        }
      }
      monitorItems.clear();

      if (subscription) {
        try {
          await subscription.terminate();
        } catch (e) {
          /* ignore */
        }
        subscription = null;
      }

      // Unregister status callback and release shared connection
      if (endpointConfig.unregisterStatusCallback) {
        endpointConfig.unregisterStatusCallback(statusCallback);
      }
      if (endpointConfig.releaseSharedManager) {
        try {
          await endpointConfig.releaseSharedManager();
        } catch (e) {
          /* ignore */
        }
      }
      done();
    });
  }

  // ─── Single Read ───

  async function handleRead(msg, mgr) {
    // If msg.items is present, automatically switch to readmultiple
    if (msg.items && Array.isArray(msg.items) && msg.items.length > 0) {
      return handleReadMultiple(msg, mgr);
    }

    const nodeIdString = msg.topic || msg.nodeId;
    if (!nodeIdString) {
      throw new Error("NodeId missing (msg.topic or msg.nodeId)");
    }

    const nodeId = parseNodeId(nodeIdString);
    if (!nodeId) throw new Error(`Invalid NodeId: ${nodeIdString}`);

    const result = await mgr.read(nodeId);
    return {
      payload: result.value,
      statusCode: result.statusCode,
      sourceTimestamp: result.sourceTimestamp,
      serverTimestamp: result.serverTimestamp,
      nodeId: nodeIdString,
    };
  }

  // ─── Multiple Read ───

  async function handleReadMultiple(msg, mgr) {
    // Support msg.payload as items source:
    //   Array: [{nodeId: "ns=1;s=Var1"}, ...]
    //   Object: {"Temp": "ns=1;s=Temp", "Press": "ns=1;s=Press"}
    let items = msg.items;
    if (
      (!items || !Array.isArray(items) || items.length === 0) &&
      msg.payload
    ) {
      if (
        Array.isArray(msg.payload) &&
        msg.payload.length > 0 &&
        msg.payload[0].nodeId
      ) {
        items = msg.payload;
      } else if (
        typeof msg.payload === "object" &&
        !Array.isArray(msg.payload)
      ) {
        items = Object.entries(msg.payload).map(([name, nodeId]) => ({
          nodeId: typeof nodeId === "string" ? nodeId : nodeId.nodeId,
          name: name,
          datatype: typeof nodeId === "object" ? nodeId.datatype : undefined,
        }));
      }
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error("msg.items or msg.payload with NodeIds missing");
    }

    // Extract and validate NodeIds from items
    const nodeIds = items.map((item, idx) => {
      const nodeIdStr = item.nodeId || item.topic;
      if (!nodeIdStr) throw new Error(`Item[${idx}]: nodeId missing`);
      const nodeId = parseNodeId(nodeIdStr);
      if (!nodeId)
        throw new Error(`Item[${idx}]: Invalid NodeId: ${nodeIdStr}`);
      return nodeId;
    });

    const results = await mgr.readMultiple(nodeIds);

    // Merge results with original item info
    const enrichedResults = results.map((r, idx) => ({
      ...r,
      itemName: items[idx].itemName || items[idx].name || undefined,
    }));

    return {
      payload: enrichedResults,
      operation: "readmultiple",
      count: enrichedResults.length,
    };
  }

  // ─── Single Write ───

  async function handleWrite(msg, mgr) {
    // If msg.items is present, automatically switch to writemultiple
    if (msg.items && Array.isArray(msg.items) && msg.items.length > 0) {
      return handleWriteMultiple(msg, mgr);
    }

    const nodeIdString = msg.topic || msg.nodeId;
    if (!nodeIdString) {
      throw new Error("NodeId missing (msg.topic or msg.nodeId)");
    }

    const value = msg.payload;
    if (value === undefined || value === null) {
      throw new Error("Value missing (msg.payload)");
    }

    const nodeId = parseNodeId(nodeIdString);
    if (!nodeId) throw new Error(`Invalid NodeId: ${nodeIdString}`);

    const result = await mgr.write(
      nodeId,
      value,
      msg.datatype || null,
      msg.dataTypeNodeId || null,
    );
    return {
      payload: value,
      statusCode: result.statusCode,
      nodeId: nodeIdString,
    };
  }

  // ─── Multiple Write ───

  async function handleWriteMultiple(msg, mgr) {
    // Support msg.payload as items source:
    //   Array: [{nodeId: "ns=1;s=Var1", value: 42, datatype: "Int32"}, ...]
    //   Object: {"ns=1;s=Temp": {value: 25.5, datatype: "Double"}, ...}
    let items = msg.items;
    if (
      (!items || !Array.isArray(items) || items.length === 0) &&
      msg.payload
    ) {
      if (
        Array.isArray(msg.payload) &&
        msg.payload.length > 0 &&
        msg.payload[0].nodeId
      ) {
        items = msg.payload;
      } else if (
        typeof msg.payload === "object" &&
        !Array.isArray(msg.payload)
      ) {
        items = Object.entries(msg.payload).map(([nodeId, valObj]) => {
          if (
            typeof valObj === "object" &&
            valObj !== null &&
            valObj.value !== undefined
          ) {
            return {
              nodeId,
              value: valObj.value,
              datatype: valObj.datatype || null,
              dataTypeNodeId: valObj.dataTypeNodeId || null,
              name: valObj.name,
            };
          }
          return { nodeId, value: valObj };
        });
      }
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error("msg.items or msg.payload with write data missing");
    }

    // Validate items
    const writeItems = items.map((item, idx) => {
      const nodeIdStr = item.nodeId || item.topic;
      if (!nodeIdStr) throw new Error(`Item[${idx}]: nodeId missing`);
      const nodeId = parseNodeId(nodeIdStr);
      if (!nodeId)
        throw new Error(`Item[${idx}]: Invalid NodeId: ${nodeIdStr}`);
      if (item.value === undefined || item.value === null) {
        throw new Error(`Item[${idx}]: value missing`);
      }
      return {
        nodeId: nodeId,
        value: item.value,
        datatype: item.datatype || null,
        dataTypeNodeId: item.dataTypeNodeId || null,
      };
    });

    const results = await mgr.writeMultiple(writeItems);

    const enrichedResults = results.map((r, idx) => ({
      ...r,
      itemName: items[idx].itemName || items[idx].name || undefined,
    }));

    return {
      payload: enrichedResults,
      operation: "writemultiple",
      count: enrichedResults.length,
    };
  }

  // ─── Subscribe ───

  async function handleSubscribe(
    msg,
    mgr,
    send,
    node,
    subscription,
    monitorItems,
    setSubscription,
  ) {
    const nodeIdString = msg.topic || msg.nodeId;
    if (!nodeIdString) throw new Error("NodeId missing");

    const nodeId = parseNodeId(nodeIdString);
    if (!nodeId) throw new Error(`Invalid NodeId: ${nodeIdString}`);

    const interval = msg.interval || 1000;
    const queueSize = msg.queueSize || 10;

    if (!subscription) {
      subscription = await mgr.createSubscription({
        interval,
        maxNotificationsPerPublish: queueSize,
      });
      setSubscription(subscription);
    }

    if (monitorItems.has(nodeIdString)) {
      const resultMsg = {
        ...msg,
        payload: "Already subscribed",
        nodeId: nodeIdString,
      };
      send(resultMsg);
      return;
    }

    const { ClientMonitoredItem } = require("node-opcua");
    const opcuaNodeId = mgr._toOpcUaNodeId(nodeId);

    const monitorItem = ClientMonitoredItem.create(
      subscription,
      { nodeId: opcuaNodeId, attributeId: 13 },
      { samplingInterval: interval, discardOldest: true, queueSize },
    );

    monitorItem.on("changed", (dataValue) => {
      send({
        payload: dataValue.value.value,
        statusCode: dataValue.statusCode.toString(),
        sourceTimestamp: dataValue.sourceTimestamp,
        serverTimestamp: dataValue.serverTimestamp,
        nodeId: nodeIdString,
        operation: "subscribe",
      });
    });

    monitorItems.set(nodeIdString, monitorItem);
    send({ ...msg, payload: "Subscribed", nodeId: nodeIdString });
  }

  // ─── Unsubscribe ───

  async function handleUnsubscribe(msg, monitorItems) {
    const nodeIdString = msg.topic || msg.nodeId;
    if (!nodeIdString) throw new Error("NodeId missing");

    const monitorItem = monitorItems.get(nodeIdString);
    if (!monitorItem) {
      return { nodeId: nodeIdString, payload: "Not subscribed" };
    }

    await monitorItem.terminate();
    monitorItems.delete(nodeIdString);
    return { nodeId: nodeIdString, payload: "Unsubscribed" };
  }

  // ─── Browse ───

  async function handleBrowse(msg, mgr) {
    const nodeIdString = msg.topic || msg.nodeId || "RootFolder";
    const nodeId = parseNodeId(nodeIdString);
    if (!nodeId) throw new Error(`Invalid NodeId: ${nodeIdString}`);

    const references = await mgr.browse(nodeId);
    return {
      payload: references.map((ref) => ({
        browseName: ref.browseName?.name || "",
        nodeId: ref.nodeId?.toString() || "",
        nodeClass: ref.nodeClass || "",
        typeDefinition: ref.typeDefinition?.toString() || "",
        isForward: ref.isForward || false,
      })),
      references,
      nodeId: nodeIdString,
      count: references.length,
    };
  }

  // ─── Method Call ───

  async function handleMethod(msg, mgr) {
    const objectId = msg.objectNodeId || msg.topic;
    const methodId = msg.methodNodeId;
    if (!objectId) throw new Error("objectNodeId missing");
    if (!methodId) throw new Error("methodNodeId missing");

    const objParsed = parseNodeId(objectId);
    const methParsed = parseNodeId(methodId);
    if (!objParsed) throw new Error(`Invalid Object NodeId: ${objectId}`);
    if (!methParsed) throw new Error(`Invalid Method NodeId: ${methodId}`);

    const args = msg.inputArguments || msg.payload || [];
    const result = await mgr.callMethod(
      objParsed,
      methParsed,
      Array.isArray(args) ? args : [args],
    );

    return {
      payload: result.outputArguments.map((a) => a.value),
      methodResult: result,
      statusCode: result.statusCode,
    };
  }

  // ─── History Read ───

  async function handleHistory(msg, mgr) {
    const nodeIdString = msg.topic || msg.nodeId;
    if (!nodeIdString) throw new Error("NodeId missing");
    const nodeId = parseNodeId(nodeIdString);
    if (!nodeId) throw new Error(`Invalid NodeId: ${nodeIdString}`);

    const startTime =
      msg.startTime || msg.payload?.startTime || new Date(Date.now() - 3600000);
    const endTime = msg.endTime || msg.payload?.endTime || new Date();

    const result = await mgr.historyRead(nodeId, startTime, endTime, {
      maxValues: msg.maxValues || 1000,
    });

    return {
      payload: result.values,
      statusCode: result.statusCode,
      nodeId: nodeIdString,
      count: result.count,
    };
  }

  // ─── Get Endpoints ───

  async function handleGetEndpoints(msg, mgr) {
    const url = msg.endpointUrl || msg.payload;
    const endpoints = await mgr.getEndpoints(url || undefined);
    return { payload: endpoints, count: endpoints.length };
  }

  // ─── Read Attribute ───

  async function handleReadAttribute(msg, mgr) {
    const nodeIdString = msg.topic || msg.nodeId;
    if (!nodeIdString) throw new Error("NodeId missing");
    const nodeId = parseNodeId(nodeIdString);
    if (!nodeId) throw new Error(`Invalid NodeId: ${nodeIdString}`);

    const attributeId = msg.attributeId || "Value";
    const result = await mgr.readAttribute(nodeId, attributeId);
    return {
      payload: result.value,
      statusCode: result.statusCode,
      nodeId: nodeIdString,
    };
  }

  // ─── Register Nodes ───

  async function handleRegisterNodes(msg, mgr) {
    const items = msg.items || [{ nodeId: msg.topic || msg.nodeId }];
    const nodeIds = items.map((i) => {
      const nid = parseNodeId(i.nodeId || i.topic);
      if (!nid) throw new Error(`Invalid NodeId: ${i.nodeId}`);
      return nid;
    });
    const registered = await mgr.registerNodes(nodeIds);
    return { payload: registered, operation: "registernodes" };
  }

  // ─── Unregister Nodes ───

  async function handleUnregisterNodes(msg, mgr) {
    const items = msg.items || [{ nodeId: msg.topic || msg.nodeId }];
    const nodeIds = items.map((i) => {
      const nid = parseNodeId(i.nodeId || i.topic);
      if (!nid) throw new Error(`Invalid NodeId: ${i.nodeId}`);
      return nid;
    });
    await mgr.unregisterNodes(nodeIds);
    return { payload: true, operation: "unregisternodes" };
  }

  // ─── Translate Browse Path ───

  async function handleTranslateBrowsePath(msg, mgr) {
    const startNodeId = msg.startNodeId || msg.topic || "i=84";
    const browsePath = msg.browsePath || msg.payload;
    if (!browsePath) throw new Error("browsePath missing");

    const startParsed = parseNodeId(startNodeId);
    if (!startParsed) throw new Error(`Invalid Start NodeId: ${startNodeId}`);

    const result = await mgr.translateBrowsePath(startParsed, browsePath);
    return { payload: result.targets, statusCode: result.statusCode };
  }

  RED.nodes.registerType("opcua-client", OpcUaClientNode);
};

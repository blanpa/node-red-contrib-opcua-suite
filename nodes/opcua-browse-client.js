/**
 * OPC UA Browse Client Node (Experimental)
 * Browse the OPC UA address space in the editor, select any node type,
 * then read or subscribe to them at runtime.
 */

const {
  parseNodeId,
  createError,
  serializeExtensionObject,
} = require("../lib/opcua-utils");
const OpcUaClientManager = require("../lib/opcua-client-manager");
const { resolveNodeId, NodeClass, AttributeIds } = require("node-opcua");

module.exports = function (RED) {
  // ─── Cached browse connections (per endpoint, shared across editor tabs) ───
  const browseConnections = new Map(); // endpointId -> { mgr, timer }
  // Single-flight per endpoint. The editor tree fires several expand requests
  // in parallel; without this each one built its own manager and overwrote
  // browseConnections, orphaning the earlier sessions with nothing left to
  // close them (issue #17, editor-side variant of the same bug).
  const pendingConnections = new Map(); // endpointId -> Promise<OpcUaClientManager>

  const IDLE_TIMEOUT_MS = 60000;

  /**
   * Middleware enforcing a Node-RED admin permission, or a pass-through when
   * RED.auth is unavailable. These routes open OPC UA connections to arbitrary
   * configured endpoints, so they must not be reachable unauthenticated when
   * adminAuth is configured.
   */
  function permission(scope) {
    if (RED.auth && typeof RED.auth.needsPermission === "function") {
      return RED.auth.needsPermission(scope);
    }
    return function (req, res, next) {
      next();
    };
  }

  function getBrowseConnection(endpointNode) {
    const id = endpointNode.id;

    const existing = browseConnections.get(id);
    if (existing) {
      // Reset idle timer
      clearTimeout(existing.timer);
      existing.timer = setTimeout(
        () => closeBrowseConnection(id),
        IDLE_TIMEOUT_MS,
      );
      if (existing.mgr.isConnected) {
        return Promise.resolve(existing.mgr);
      }
      // Connection lost — drop it and build a fresh one below.
      browseConnections.delete(id);
      Promise.resolve(existing.mgr.disconnect()).catch(() => {});
    }

    const inFlight = pendingConnections.get(id);
    if (inFlight) return inFlight;

    const attempt = createBrowseConnection(endpointNode).finally(() => {
      pendingConnections.delete(id);
    });
    pendingConnections.set(id, attempt);
    return attempt;
  }

  async function createBrowseConnection(endpointNode) {
    const id = endpointNode.id;
    const certData = endpointNode.getCertificateData
      ? endpointNode.getCertificateData()
      : {};
    const mgr = new OpcUaClientManager({
      endpointUrl: endpointNode.endpointUrl,
      userName: endpointNode.credentials?.userName || "",
      password: endpointNode.credentials?.password || "",
      securityMode: endpointNode.securityMode || "None",
      securityPolicy: endpointNode.securityPolicy || "None",
      applicationName: "Node-RED OPC UA Browser (Editor)",
      maxReconnectAttempts: 0,
      reconnectDelay: 5000,
      certificateFile: certData.certificateFile || "",
      privateKeyFile: certData.privateKeyFile || "",
      caCertificateFile: certData.caCertificateFile || "",
      userCertificateFile: certData.userCertificateFile || "",
      userPrivateKeyFile: certData.userPrivateKeyFile || "",
    });

    try {
      await mgr.connect();
    } catch (err) {
      // Never leave a half-built manager (and its channel) behind.
      try {
        await mgr.disconnect();
      } catch (e) {
        /* ignore */
      }
      throw err;
    }

    const timer = setTimeout(() => closeBrowseConnection(id), IDLE_TIMEOUT_MS);
    browseConnections.set(id, { mgr, timer });
    return mgr;
  }

  async function closeBrowseConnection(id) {
    const entry = browseConnections.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      browseConnections.delete(id);
      try {
        await entry.mgr.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  }

  async function closeAllBrowseConnections() {
    await Promise.all(
      [...browseConnections.keys()].map((id) => closeBrowseConnection(id)),
    );
  }

  // Editor browse sessions are not tied to any deployed node, so nothing else
  // would close them on shutdown — they would linger until the 60s idle timer,
  // or forever if the process exits before it fires (the server then keeps the
  // session until its own timeout). "flows:stopped" fires on shutdown and on
  // every redeploy; rebuilding a cached browse connection on the next editor
  // request is cheap, so closing on both is the safe side.
  if (RED.events && typeof RED.events.on === "function") {
    RED.events.on("flows:stopped", function () {
      closeAllBrowseConnections().catch(() => {});
    });
  }

  // ─── Browse ResultMask bit flags (OPC UA Part 4, §7.5) ───
  // Bit 0 (1)  = ReferenceType   — NodeId of the reference type
  // Bit 1 (2)  = IsForward       — direction of the reference
  // Bit 2 (4)  = NodeClass       — NodeClass of the target node
  // Bit 3 (8)  = BrowseName      — QualifiedName of the target
  // Bit 4 (16) = DisplayName     — LocalizedText display name
  // Bit 5 (32) = TypeDefinition  — TypeDefinition of the target
  const RESULT_MASK = {
    // Main tree browse: we need everything except ReferenceType
    // IsForward + NodeClass + BrowseName + DisplayName + TypeDefinition
    BROWSE: 2 | 4 | 8 | 16 | 32, // 62
    // Fallback browse (unfiltered): only need IsForward + NodeClass to filter,
    // plus BrowseName + DisplayName + TypeDefinition for the survivors
    FALLBACK: 2 | 4 | 8 | 16 | 32, // 62
    // Supertype walk: we only need IsForward + NodeId (NodeId is always included)
    SUPERTYPE: 2, // 2
  };

  // NodeClass number -> name mapping (node-opcua uses enums that may serialize as numbers)
  function resolveNodeClassName(nc) {
    if (typeof nc === "string") return nc;
    if (typeof nc === "number") return NodeClass[nc] || String(nc);
    return String(nc);
  }

  // Which NodeClasses can have children (worth expanding)
  const EXPANDABLE_CLASSES = new Set([
    "Object",
    "Variable",
    "ObjectType",
    "VariableType",
    "ReferenceType",
    "DataType",
    "View",
    // Numeric equivalents
    1,
    2,
    8,
    16,
    32,
    64,
    128,
  ]);

  function canHaveChildren(nodeClass, nodeClassNum) {
    return (
      EXPANDABLE_CLASSES.has(nodeClass) || EXPANDABLE_CLASSES.has(nodeClassNum)
    );
  }

  // Well-known OPC UA DataType NodeIds -> friendly names
  const BUILTIN_DATATYPE_MAP = {
    "i=1": "Boolean",
    "i=2": "SByte",
    "i=3": "Byte",
    "i=4": "Int16",
    "i=5": "UInt16",
    "i=6": "Int32",
    "i=7": "UInt32",
    "i=8": "Int64",
    "i=9": "UInt64",
    "i=10": "Float",
    "i=11": "Double",
    "i=12": "String",
    "i=13": "DateTime",
    "i=14": "Guid",
    "i=15": "ByteString",
    "i=16": "XmlElement",
    "i=17": "NodeId",
    "i=19": "StatusCode",
    "i=20": "QualifiedName",
    "i=21": "LocalizedText",
    "i=22": "ExtensionObject",
    "i=24": "BaseDataType",
    "i=26": "Number",
    "i=27": "Integer",
    "i=28": "UInteger",
    "i=29": "Enumeration",
  };

  function resolveDataTypeName(dtNodeId) {
    if (!dtNodeId) return "";
    const s = dtNodeId.toString();
    return BUILTIN_DATATYPE_MAP[s] || null;
  }

  // NodeClasses that support Value attribute subscription
  const SUBSCRIBABLE_CLASSES = new Set(["Variable", "VariableType"]);

  /**
   * Browse a node and follow continuation points until the server has
   * returned all references. Servers with a low per-browse reference
   * limit (e.g. Siemens S7-1500 caps at 100) set a continuationPoint
   * instead of returning everything at once (issue #14).
   * Returns { references, statusCode }.
   */
  async function browseAllReferences(session, browseDescription) {
    const browseResult = await session.browse(browseDescription);
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
      const nextResult = await session.browseNext(continuationPoint, false);
      references.push(...(nextResult.references || []));
      continuationPoint = nextResult.continuationPoint;
    }
    return { references, statusCode: browseResult.statusCode };
  }

  // ─── HTTP API for Editor Tree Browsing ───

  if (RED.httpAdmin) {
    RED.httpAdmin.post(
      "/opcua-browse-client/browse",
      permission("flows.read"),
      async function (req, res) {
        try {
          const { endpointId, nodeId } = req.body;
          if (!endpointId) {
            return res.status(400).json({ error: "endpointId required" });
          }

          const endpointNode = RED.nodes.getNode(endpointId);
          if (!endpointNode) {
            return res
              .status(404)
              .json({ error: "Endpoint node not found. Deploy first." });
          }

          const mgr = await getBrowseConnection(endpointNode);
          const session = mgr.getSession();

          const browseNodeId = nodeId || "RootFolder";
          const resolvedNodeId = resolveNodeId(browseNodeId);
          const browseResult = await browseAllReferences(session, {
            nodeId: resolvedNodeId,
            referenceTypeId: "HierarchicalReferences",
            includeSubtypes: true,
            resultMask: RESULT_MASK.BROWSE,
          });

          let forwardRefs = browseResult.references.filter(
            (ref) => ref.isForward,
          );

          // If hierarchical browse returned nothing, retry without
          // referenceTypeId filter and keep only Variable / Object children.
          // This covers ExtensionObject variables whose fields are exposed
          // via non-hierarchical references on some servers.
          let extensionFields = null;
          let fallbackStatusCode = null;
          if (forwardRefs.length === 0 && nodeId) {
            const fallbackResult = await browseAllReferences(session, {
              nodeId: resolvedNodeId,
              resultMask: RESULT_MASK.FALLBACK,
            });
            fallbackStatusCode = fallbackResult.statusCode;
            const KEEP_CLASSES = new Set([
              "Variable",
              "Object",
              1, // Object (numeric)
              2, // Variable (numeric)
            ]);
            forwardRefs = fallbackResult.references.filter((ref) => {
              if (!ref.isForward) return false;
              const nc = resolveNodeClassName(ref.nodeClass);
              const ncNum =
                typeof ref.nodeClass === "number" ? ref.nodeClass : undefined;
              return KEEP_CLASSES.has(nc) || KEEP_CLASSES.has(ncNum);
            });

            // If still nothing, try reading the value to extract
            // ExtensionObject fields (server doesn't expose them as nodes)
            if (forwardRefs.length === 0) {
              try {
                const dataValue = await session.read({
                  nodeId: resolvedNodeId,
                  attributeId: AttributeIds.Value,
                });
                const raw =
                  dataValue.value &&
                  dataValue.value.value !== null &&
                  dataValue.value.value !== undefined
                    ? dataValue.value.value
                    : null;

                if (raw && typeof raw === "object") {
                  const extObj = Array.isArray(raw) ? raw[0] : raw;
                  if (
                    extObj &&
                    typeof extObj === "object" &&
                    !(
                      extObj.constructor &&
                      extObj.constructor.name === "OpaqueStructure"
                    )
                  ) {
                    const keys = new Set(Object.keys(extObj));
                    if (extObj.schema && extObj.schema.fields) {
                      for (const f of extObj.schema.fields) {
                        if (f.name) keys.add(f.name);
                      }
                    }
                    const fields = [];
                    for (const key of keys) {
                      if (
                        key.startsWith("_") ||
                        key === "schema" ||
                        key === "nodeId"
                      )
                        continue;
                      const val = extObj[key];
                      if (typeof val === "function") continue;

                      let dtName = "";
                      if (val === null || val === undefined) {
                        dtName = "Null";
                      } else if (typeof val === "boolean") {
                        dtName = "Boolean";
                      } else if (typeof val === "number") {
                        dtName = Number.isInteger(val) ? "Int32" : "Double";
                      } else if (typeof val === "string") {
                        dtName = "String";
                      } else if (val instanceof Date) {
                        dtName = "DateTime";
                      } else if (Buffer.isBuffer(val)) {
                        dtName = "ByteString";
                      } else if (Array.isArray(val)) {
                        dtName = "Array[" + val.length + "]";
                      } else if (typeof val === "object") {
                        if (val.schema && val.schema.name) {
                          dtName = "ExtensionObject (" + val.schema.name + ")";
                        } else {
                          dtName = "Structure";
                        }
                      }

                      let displayValue;
                      try {
                        displayValue = serializeExtensionObject(val);
                      } catch (_e) {
                        displayValue = String(val);
                      }

                      fields.push({
                        browseName: key,
                        displayName: key,
                        dataType: dtName,
                        value: displayValue,
                      });
                    }
                    if (fields.length > 0) {
                      extensionFields = fields;
                    }
                  }
                }
              } catch (_e) {
                /* non-critical — value may not be readable */
              }
            }
          }

          // Collect Variable nodeIds to batch-read their DataType attribute
          const variableIndices = [];
          const variableNodeIds = [];
          forwardRefs.forEach((ref, idx) => {
            const nc = resolveNodeClassName(ref.nodeClass);
            if (nc === "Variable" || nc === "VariableType") {
              variableIndices.push(idx);
              variableNodeIds.push(ref.nodeId);
            }
          });

          // Batch read DataType attribute for all variables
          const dataTypeMap = {};
          if (variableNodeIds.length > 0) {
            try {
              const readItems = variableNodeIds.map((nid) => ({
                nodeId: nid,
                attributeId: AttributeIds.DataType,
              }));
              const dataValues = await session.read(readItems);
              const results = Array.isArray(dataValues)
                ? dataValues
                : [dataValues];

              // Collect unknown DataType NodeIds that need further resolution
              const unknownDtNodeIds = []; // { varNidStr, dtNodeId }
              results.forEach((dv, i) => {
                const nidStr = variableNodeIds[i].toString();
                if (dv.value && dv.value.value) {
                  const dtNodeId = dv.value.value;
                  const dtName = resolveDataTypeName(dtNodeId);
                  if (dtName) {
                    dataTypeMap[nidStr] = dtName;
                  } else {
                    // Not a builtin type — need to resolve the BrowseName
                    unknownDtNodeIds.push({ varNidStr: nidStr, dtNodeId });
                  }
                }
              });

              // For unknown DataType NodeIds, batch-read their BrowseName
              // and check if they are subtypes of Structure (i=22)
              if (unknownDtNodeIds.length > 0) {
                try {
                  const browseNameReads = unknownDtNodeIds.map((u) => ({
                    nodeId: u.dtNodeId,
                    attributeId: AttributeIds.BrowseName,
                  }));
                  const bnResults = await session.read(browseNameReads);
                  const bnArr = Array.isArray(bnResults)
                    ? bnResults
                    : [bnResults];

                  // For each unknown type, browse its supertype chain to detect Structure subtypes
                  for (let j = 0; j < unknownDtNodeIds.length; j++) {
                    const { varNidStr, dtNodeId } = unknownDtNodeIds[j];
                    const typeName =
                      bnArr[j]?.value?.value?.name || dtNodeId.toString();
                    let isStructSubtype = false;

                    // Walk the HasSubtype (inverse) chain up to 5 levels to find i=22 (Structure)
                    try {
                      let currentId = dtNodeId;
                      for (let depth = 0; depth < 5; depth++) {
                        const parentBrowse = await session.browse({
                          nodeId: currentId,
                          browseDirection: 1, // Inverse
                          referenceTypeId: "HasSubtype",
                          resultMask: RESULT_MASK.SUPERTYPE,
                        });
                        const parentRef = (parentBrowse.references || []).find(
                          (r) => !r.isForward,
                        );
                        if (!parentRef) break;
                        const parentStr = parentRef.nodeId?.toString() || "";
                        if (parentStr === "ns=0;i=22" || parentStr === "i=22") {
                          isStructSubtype = true;
                          break;
                        }
                        currentId = parentRef.nodeId;
                      }
                    } catch (_e) {
                      /* non-critical */
                    }

                    if (isStructSubtype) {
                      dataTypeMap[varNidStr] =
                        "ExtensionObject (" + typeName + ")";
                    } else {
                      dataTypeMap[varNidStr] = typeName;
                    }
                  }
                } catch (_e) {
                  // Fallback: use raw NodeId strings
                  unknownDtNodeIds.forEach((u) => {
                    dataTypeMap[u.varNidStr] = u.dtNodeId.toString();
                  });
                }
              }
            } catch (e) {
              // Non-critical — just skip datatype info
            }
          }

          const refs = forwardRefs.map((ref) => {
            const ncRaw = ref.nodeClass;
            const ncName = resolveNodeClassName(ncRaw);
            const ncNum = typeof ncRaw === "number" ? ncRaw : undefined;
            const nidStr = ref.nodeId?.toString() || "";
            return {
              browseName: ref.browseName?.name || "",
              nodeId: nidStr,
              nodeClass: ncName,
              displayName: ref.displayName?.text || ref.browseName?.name || "",
              typeDefinition: ref.typeDefinition?.toString() || "",
              dataType: dataTypeMap[nidStr] || "",
              hasChildren: canHaveChildren(ncName, ncNum),
            };
          });

          // Surface a failed browse instead of showing an empty folder —
          // an empty result with a Good status is a legitimately empty node.
          if (refs.length === 0 && !extensionFields) {
            const badStatus = [
              browseResult.statusCode,
              fallbackStatusCode,
            ].find(
              (sc) =>
                sc && typeof sc.isNotGood === "function" && sc.isNotGood(),
            );
            if (badStatus) {
              return res.status(500).json({
                error: `Browse failed: ${badStatus.toString()}`,
              });
            }
          }

          const response = { references: refs };
          if (extensionFields) {
            response.extensionFields = extensionFields;
          }
          res.json(response);
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      },
    );

    // Disconnect cached browse connection
    RED.httpAdmin.post(
      "/opcua-browse-client/disconnect",
      permission("flows.read"),
      async function (req, res) {
        try {
          const { endpointId } = req.body;
          if (endpointId) {
            await closeBrowseConnection(endpointId);
          }
          res.json({ success: true });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      },
    );
  }

  // ─── Runtime Node ───

  function OpcUaBrowseClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const endpointConfig = RED.nodes.getNode(config.endpoint);
    if (!endpointConfig) {
      node.error("Endpoint configuration missing");
      return;
    }
    if (!endpointConfig.getSharedManager) {
      node.error("Endpoint node does not support connection sharing");
      return;
    }

    const clientManager = endpointConfig.getSharedManager({
      applicationName:
        config.applicationName || "Node-RED OPC UA Browse Client",
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      reconnectDelay: config.reconnectDelay || 5000,
    });

    const selectedItems = config.selectedItems || [];
    const mode = config.mode || "read";
    const publishInterval = config.publishInterval || 1000;

    let subscription = null;
    const monitorItems = new Map();

    node.status({ fill: "red", shape: "ring", text: "not connected" });

    const statusCallback = (event, error) => {
      switch (event) {
        case "connected":
          node.status({
            fill: "green",
            shape: "dot",
            text: `connected (${selectedItems.length} items)`,
          });
          if (mode === "subscribe" && selectedItems.length > 0) {
            setupSubscriptions();
          }
          break;
        case "disconnected":
          node.status({ fill: "red", shape: "ring", text: "disconnected" });
          monitorItems.clear();
          subscription = null;
          break;
        case "session_recreated":
          // The manager replaced the session after a reconnect (e.g. a Siemens
          // S7 ~60s session timeout). Every ClientSubscription/MonitoredItem we
          // hold is bound to the dead session and would throw "expecting a valid
          // session" on reuse, so drop them and rebuild on the fresh session —
          // the same fix opcua-client got for issue #15.
          monitorItems.clear();
          subscription = null;
          if (mode === "subscribe" && selectedItems.length > 0) {
            setupSubscriptions();
          }
          break;
        case "reconnecting":
          node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
          break;
        case "error":
          node.error(`OPC UA error: ${error ? error.message : "unknown"}`);
          node.status({ fill: "red", shape: "ring", text: "error" });
          break;
      }
    };
    endpointConfig.registerStatusCallback(statusCallback);

    if (clientManager.isConnected) {
      node.status({
        fill: "green",
        shape: "dot",
        text: `connected (${selectedItems.length} items)`,
      });
      if (mode === "subscribe" && selectedItems.length > 0) {
        setupSubscriptions();
      }
    } else if (mode === "subscribe" && selectedItems.length > 0) {
      // Subscribe mode is passive — nothing here ever sends an input message,
      // so without a proactive connect a flow whose only OPC UA node is this
      // one stayed at "not connected" forever and never delivered a value.
      node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
      clientManager.connect().catch((err) => {
        node.warn(`Initial connect failed: ${err.message}`);
      });
    }

    // ─── Subscribe Mode ───

    async function setupSubscriptions() {
      if (subscription || selectedItems.length === 0) return;

      try {
        const { ClientMonitoredItem } = require("node-opcua");
        subscription = await clientManager.createSubscription({
          interval: publishInterval,
        });

        const subscribableItems = selectedItems.filter((item) =>
          SUBSCRIBABLE_CLASSES.has(item.nodeClass),
        );
        const skippedCount = selectedItems.length - subscribableItems.length;
        if (skippedCount > 0) {
          node.warn(
            `Skipping ${skippedCount} non-subscribable item(s) (only Variable/VariableType support subscriptions)`,
          );
        }

        for (const item of subscribableItems) {
          try {
            const opcuaNodeId = resolveNodeId(item.nodeId);
            const monitorItem = ClientMonitoredItem.create(
              subscription,
              { nodeId: opcuaNodeId, attributeId: AttributeIds.Value },
              {
                samplingInterval: publishInterval,
                discardOldest: true,
                queueSize: 10,
              },
            );

            monitorItem.on("changed", (dataValue) => {
              let payload = dataValue.value?.value;
              // Serialize ExtensionObjects to plain JSON
              if (payload && typeof payload === "object" && payload.schema) {
                payload = serializeExtensionObject(payload);
              } else if (
                Array.isArray(payload) &&
                payload.length > 0 &&
                payload[0] &&
                payload[0].schema
              ) {
                payload = payload.map((v) => serializeExtensionObject(v));
              }
              node.send({
                payload: payload,
                statusCode: dataValue.statusCode?.toString(),
                sourceTimestamp: dataValue.sourceTimestamp,
                serverTimestamp: dataValue.serverTimestamp,
                nodeId: item.nodeId,
                browseName: item.browseName || "",
                displayName: item.displayName || "",
                nodeClass: item.nodeClass || "",
                dataType: item.dataType || "",
                operation: "subscribe",
              });
            });

            monitorItems.set(item.nodeId, monitorItem);
          } catch (e) {
            node.warn(
              `Failed to subscribe to ${item.nodeId} (${item.nodeClass}): ${e.message}`,
            );
          }
        }

        node.status({
          fill: "green",
          shape: "dot",
          text: `subscribed (${monitorItems.size}/${subscribableItems.length})`,
        });
      } catch (e) {
        node.error(`Subscription setup failed: ${e.message}`);
      }
    }

    // ─── Input Handler ───

    node.on("input", async function (msg, send, done) {
      try {
        if (!clientManager.isConnected) {
          await clientManager.connect();
        }

        const operation = (msg.operation || mode).toLowerCase();

        if (operation === "read" || operation === "readmultiple") {
          const items = selectedItems.length > 0 ? selectedItems : [];
          if (items.length === 0) {
            throw new Error(
              "No items selected. Open node settings and browse the server to select items.",
            );
          }

          const nodeIds = items.map((item) => parseNodeId(item.nodeId));
          const results = await clientManager.readMultiple(nodeIds);

          const enriched = results.map((r, idx) => ({
            ...r,
            browseName: items[idx].browseName || "",
            displayName: items[idx].displayName || "",
            nodeClass: items[idx].nodeClass || "",
          }));

          msg.payload = enriched;
          msg.operation = "readmultiple";
          msg.count = enriched.length;
          send(msg);
          done();
        } else if (operation === "subscribe") {
          await setupSubscriptions();
          msg.payload = `Subscribed to ${monitorItems.size} items`;
          send(msg);
          done();
        } else if (operation === "unsubscribe") {
          for (const mi of monitorItems.values()) {
            try {
              await mi.terminate();
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
          msg.payload = "Unsubscribed";
          send(msg);
          done();
        } else {
          throw new Error(`Unknown operation: ${operation}`);
        }
      } catch (error) {
        // DEBT-01: delegate recovery to the manager on session loss.
        if (
          clientManager._isConnectionLostError &&
          clientManager._isConnectionLostError(error)
        ) {
          try {
            await clientManager.reconnect({ reason: "session-lost" });
          } catch (e) {
            /* handled by reconnect */
          }
        }
        node.error(`Operation error: ${error.message}`);
        node.status({ fill: "red", shape: "ring", text: "error" });
        msg.error = createError(error.message, error);
        send(msg);
        done(error);
      }
    });

    // ─── Cleanup ───

    node.on("close", async function (removed, done) {
      for (const mi of monitorItems.values()) {
        try {
          await mi.terminate();
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

  RED.nodes.registerType("opcua-browse-client", OpcUaBrowseClientNode);
};

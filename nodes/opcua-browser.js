/**
 * OPC UA Browser Node
 * Browses OPC UA server address space with improved output
 */

const { parseNodeId } = require("../lib/opcua-utils");
const { NodeClass } = require("node-opcua");

// ReferenceDescription.nodeClass is a NodeClass ENUM value, not a string, so
// the old `ref.nodeClass === 'Object'` comparisons were always false.
function nodeClassName(nodeClass) {
  if (typeof nodeClass === "string") return nodeClass;
  if (typeof nodeClass === "number")
    return NodeClass[nodeClass] || String(nodeClass);
  return nodeClass != null ? String(nodeClass) : "";
}

module.exports = function (RED) {
  function OpcUaBrowserNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Endpoint config node (for shared connection)
    const endpointConfig = RED.nodes.getNode(config.endpoint);
    if (!endpointConfig || !endpointConfig.getSharedManager) {
      node.error("OPC UA Endpoint missing");
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    const clientManager = endpointConfig.getSharedManager({
      applicationName: "Node-RED OPC UA Browser",
    });

    // Status callback
    const statusCallback = (event, error) => {
      switch (event) {
        case "connected":
          node.status({ fill: "green", shape: "dot", text: "connected" });
          break;
        case "disconnected":
          node.status({ fill: "red", shape: "ring", text: "disconnected" });
          break;
        case "reconnecting":
          node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
          break;
        case "error":
          // The connection error was previously received and dropped,
          // leaving a red dot with no explanation anywhere.
          node.error(`OPC UA error: ${error ? error.message : "unknown"}`);
          node.status({ fill: "red", shape: "ring", text: "error" });
          break;
      }
    };
    endpointConfig.registerStatusCallback(statusCallback);

    if (clientManager.isConnected) {
      node.status({ fill: "green", shape: "dot", text: "connected" });
    } else {
      node.status({ fill: "yellow", shape: "ring", text: "ready" });
    }

    // Input Handler
    node.on("input", async function (msg, send, done) {
      try {
        // Auto-connect if not connected
        if (!clientManager.isConnected) {
          await clientManager.connect();
        }

        const nodeIdString =
          msg.topic || msg.nodeId || config.startNodeId || "RootFolder";
        const nodeId = parseNodeId(nodeIdString);

        if (!nodeId) {
          throw new Error(`Invalid NodeId: ${nodeIdString}`);
        }

        // Perform browse
        const references = await clientManager.browse(nodeId);

        // Structured output
        const browseResult = {
          nodeId: nodeIdString,
          references: references.map((ref) => ({
            browseName: ref.browseName?.name || "",
            nodeId: ref.nodeId?.toString() || "",
            nodeClass: nodeClassName(ref.nodeClass),
            typeDefinition: ref.typeDefinition?.toString() || "",
            isForward: ref.isForward || false,
          })),
          count: references.length,
        };

        // Output
        msg.payload = browseResult.references;
        msg.browseResult = browseResult;
        msg.nodeId = nodeIdString;

        // If recursive is enabled
        if (config.recursive || msg.recursive) {
          const recursiveResult = await browseRecursive(
            clientManager,
            nodeId,
            config.maxDepth || 10,
          );
          msg.recursiveResult = recursiveResult;
        }

        send(msg);
        done();
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
        node.error(`Browse error: ${error.message}`, { error });
        msg.error = error.message;
        send(msg);
        done(error);
      }
    });

    // Cleanup
    node.on("close", async function (removed, done) {
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

  // Recursive browsing.
  //
  // `visited` guards against revisiting a node: an OPC UA address space is a
  // graph, not a tree, and without the guard a shared child (or an inverse
  // reference exposed by the server) makes this walk the same subtree over
  // and over. `manager.browse()` restricts itself to HierarchicalReferences,
  // so we stay inside the address space instead of descending into the type
  // system via HasTypeDefinition.
  async function browseRecursive(
    manager,
    nodeId,
    maxDepth,
    currentDepth = 0,
    visited = new Set(),
  ) {
    if (currentDepth >= maxDepth) {
      return [];
    }

    try {
      const references = await manager.browse(nodeId);
      const result = [];

      for (const ref of references) {
        const refNodeId = ref.nodeId?.toString() || "";
        const ncName = nodeClassName(ref.nodeClass);
        const item = {
          browseName: ref.browseName?.name || "",
          nodeId: refNodeId,
          nodeClass: ncName,
          depth: currentDepth,
          children: [],
        };

        // Only browse objects and variables recursively
        if (
          (ncName === "Object" || ncName === "Variable") &&
          ref.isForward &&
          refNodeId &&
          !visited.has(refNodeId)
        ) {
          visited.add(refNodeId);
          item.children = await browseRecursive(
            manager,
            ref.nodeId,
            maxDepth,
            currentDepth + 1,
            visited,
          );
        }

        result.push(item);
      }

      return result;
    } catch (error) {
      return [];
    }
  }

  RED.nodes.registerType("opcua-browser", OpcUaBrowserNode);
};

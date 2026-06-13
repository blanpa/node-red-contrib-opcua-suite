/**
 * OPC UA Publisher Node (PubSub)
 *
 * User-facing PubSub worker node — the producing half of the round-trip loop.
 * References an opcua-pubsub-connection config node, declares exactly one
 * WriterGroup with one or more DataSetWriters (each bound to a PublishedDataSet),
 * and publishes OPC UA PubSub NetworkMessages over the shared transport in BOTH
 * acyclic (msg-driven, PUB-03) and cyclic (interval-driven with KeepAlive, PUB-02)
 * modes, with node.status() indicators driven by the connection's status fan-out
 * (STAT-01).
 *
 * Config build (WriterGroup / DataSetWriter / PublishedDataSet) is done through the
 * Phase 2 validating factories (lib/pubsub-config.js); any thrown validation error
 * surfaces as node.error + red status with NO transport acquired (D4-04).
 */

"use strict";

const { WriterGroup, DataSetWriter, PublishedDataSet } = require("../lib/pubsub-config");

module.exports = function (RED) {
  function OpcUaPublisherNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // ─── 1. Connection guard (D4-02) ───
    const conn = RED.nodes.getNode(config.connection);
    if (!conn) {
      node.status({ fill: "red", shape: "ring", text: "no connection" });
      return;
    }

    // ─── 2. Encoding selection (D4-03) ───
    // Default derives from transportType; both default to "uadp" — JSON must be
    // explicitly chosen, and is only valid over MQTT.
    node.messageEncoding =
      config.messageEncoding || (conn.transportType === "udp" ? "uadp" : "uadp");

    if (conn.transportType === "udp" && node.messageEncoding === "json") {
      node.error(
        "UDP transport requires UADP encoding (UDP-JSON is not a supported combination)"
      );
      node.status({ fill: "red", shape: "ring", text: "UDP requires UADP" });
      return;
    }

    const encoder =
      node.messageEncoding === "json"
        ? require("../lib/json-encoder")
        : require("../lib/uadp-encoder");

    // ─── 3. publishMode (D4-06) ───
    node.publishMode = config.publishMode || "acyclic";

    // ─── 4. Build config objects via Phase 2 factories (D4-04) ───
    try {
      node.writerGroup = WriterGroup({
        publishingInterval: Number(config.publishingInterval),
        keepAliveTime:
          config.keepAliveTime != null && config.keepAliveTime !== ""
            ? Number(config.keepAliveTime)
            : undefined,
        maxNetworkMessageSize:
          config.maxNetworkMessageSize != null && config.maxNetworkMessageSize !== ""
            ? Number(config.maxNetworkMessageSize)
            : undefined,
        priority:
          config.priority != null && config.priority !== ""
            ? Number(config.priority)
            : undefined,
        writerGroupId: Number(config.writerGroupId)
      });

      const rawWriters =
        typeof config.writers === "string"
          ? JSON.parse(config.writers || "[]")
          : config.writers || [];

      node.writers = rawWriters.map(function (w) {
        const pds = PublishedDataSet(w.publishedDataSet);
        return DataSetWriter({
          dataSetWriterId: Number(w.dataSetWriterId),
          dataSetName: w.dataSetName,
          publishedDataSet: pds
        });
      });

      if (node.writers.length === 0) {
        throw new Error("Publisher requires at least one DataSetWriter");
      }
    } catch (err) {
      node.error(err.message);
      node.status({ fill: "red", shape: "ring", text: "config error" });
      return;
    }

    // The PublishedDataSet fields[] are the authority for outgoing field typing
    // (D4-04). DataSetWriter() re-freezes publishedDataSet internally; keep the
    // frozen reference so fields[] is at hand.
    node._publishedDataSets = node.writers.map(function (w) {
      return w.publishedDataSet;
    });

    // ─── 5. Sequence state ───
    node._nmSeq = 0;           // NetworkMessage groupHeader.sequenceNumber
    node._dsmSeq = {};         // per-writer DataSetMessage sequenceNumber

    // ─── Cyclic latest-value state (Task 2) ───
    node._latestValues = {};
    node._dirty = false;
    node._interval = null;

    // ─── 6. Status (D4-10, STAT-01) ───
    node.status({ fill: "blue", shape: "dot", text: "idle" });

    node._setPublishing = function () {
      node.status({ fill: "green", shape: "ring", text: "publishing" });
    };

    node._statusCb = function (status, err) {
      switch (status) {
        case "connected":
          node.status({ fill: "green", shape: "dot", text: "connected" });
          break;
        case "disconnected":
        case "reconnecting":
          node.status({ fill: "yellow", shape: "ring", text: "disconnected" });
          break;
        case "error":
          node.status({
            fill: "red",
            shape: "ring",
            text: err && err.message ? "error: " + err.message : "error"
          });
          break;
        default:
          break;
      }
    };
    conn.registerStatusCallback(node._statusCb);

    // ─── Acquire shared transport (D4-02) ───
    node.transport = conn.acquireTransport();

    // ─── 7. NetworkMessage builder (keyframe) ───
    node._buildNetworkMessage = function (sourceValues) {
      sourceValues = sourceValues || {};
      node._nmSeq++;
      const payload = node.writers.map(function (writer) {
        const id = writer.dataSetWriterId;
        node._dsmSeq[id] = (node._dsmSeq[id] || 0) + 1;
        const fields = {};
        writer.publishedDataSet.fields.forEach(function (field) {
          if (sourceValues[field.name] !== undefined) {
            fields[field.name] = {
              dataType: field.dataType,
              value: sourceValues[field.name]
            };
          }
        });
        return {
          dataSetWriterId: id,
          messageType: "keyframe",
          sequenceNumber: node._dsmSeq[id],
          configurationVersion: writer.publishedDataSet.configurationVersion,
          fields: fields
        };
      });
      return {
        publisherId: conn.publisherId,
        groupHeader: {
          writerGroupId: node.writerGroup.writerGroupId,
          sequenceNumber: node._nmSeq
        },
        payloadHeader: {
          dataSetWriterIds: node.writers.map(function (w) {
            return w.dataSetWriterId;
          })
        },
        timestamp: new Date(),
        payload: payload
      };
    };

    // ─── KeepAlive builder (cyclic no-change, D4-06) ───
    node._buildKeepAlive = function () {
      node._nmSeq++;
      const payload = node.writers.map(function (writer) {
        const id = writer.dataSetWriterId;
        node._dsmSeq[id] = (node._dsmSeq[id] || 0) + 1;
        return {
          dataSetWriterId: id,
          messageType: "keepalive",
          sequenceNumber: node._dsmSeq[id],
          fields: {}
        };
      });
      return {
        publisherId: conn.publisherId,
        groupHeader: {
          writerGroupId: node.writerGroup.writerGroupId,
          sequenceNumber: node._nmSeq
        },
        payloadHeader: {
          dataSetWriterIds: node.writers.map(function (w) {
            return w.dataSetWriterId;
          })
        },
        timestamp: new Date(),
        payload: payload
      };
    };

    // ─── 8. Encode + send a NetworkMessage ───
    // MQTT requires topic identifiers — the MqttTransport builds
    // `${prefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}` from the
    // send() opts and throws TOPIC_INVALID_CHARACTER when they are missing. UDP
    // ignores opts. Pass the WriterGroup id + first DataSetWriter id (the topic
    // granularity matching the published frame) so the MQTT path actually
    // publishes instead of throwing.
    node._sendOpts = {
      writerGroupId: node.writerGroup.writerGroupId,
      dataSetWriterId: node.writers[0].dataSetWriterId
    };

    node._emit = function (nm) {
      const encoded = encoder.encodeNetworkMessage(nm, {
        mtu: node.writerGroup.maxNetworkMessageSize
      });
      node.transport.send(encoded, node._sendOpts);
      node._setPublishing();
    };

    // ─── Cyclic interval: one setInterval per WriterGroup (D4-06, PUB-02) ───
    if (node.publishMode === "cyclic") {
      node._interval = setInterval(function () {
        try {
          let nm;
          if (node._dirty) {
            nm = node._buildNetworkMessage(node._latestValues);
            node._dirty = false;
          } else {
            nm = node._buildKeepAlive();
          }
          node._emit(nm);
        } catch (e) {
          node.error(e.message);
          node.status({ fill: "red", shape: "ring", text: "error" });
        }
      }, node.writerGroup.publishingInterval);
    }

    // ─── 9. Input handler (D4-05, PUB-03) ───
    node.on("input", function (msg, send, done) {
      send = send || function () {};
      done = done || function () {};
      try {
        const sourceValues =
          msg && msg.payload && typeof msg.payload === "object" ? msg.payload : {};

        if (node.publishMode === "cyclic") {
          // Cyclic: merge values; the interval emits the frame.
          Object.assign(node._latestValues, sourceValues);
          node._dirty = true;
          send(msg);
          done();
          return;
        }

        // Acyclic: one inbound msg → one outbound NetworkMessage.
        const nm = node._buildNetworkMessage(sourceValues);
        node._emit(nm);
        send(msg);
        done();
      } catch (e) {
        node.error(e.message, msg);
        node.status({ fill: "red", shape: "ring", text: "error" });
        done(e);
      }
    });

    // ─── 10. Close handler (D4-02, D4-06) ───
    // Two-argument (removed, done) signature is mandatory — the one-arg form
    // breaks the Node-RED close handshake.
    node.on("close", function (removed, done) {
      if (node._interval) {
        clearInterval(node._interval);
        node._interval = null;
      }
      if (conn.unregisterStatusCallback && node._statusCb) {
        conn.unregisterStatusCallback(node._statusCb);
      }
      if (conn.releaseTransport) {
        conn.releaseTransport();
      }
      done();
    });
  }

  RED.nodes.registerType("opcua-publisher", OpcUaPublisherNode);
};

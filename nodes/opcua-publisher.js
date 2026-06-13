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
    // UADP is the default for every transport (UDP and MQTT alike); JSON must be
    // explicitly chosen and is only valid over MQTT.
    node.messageEncoding = config.messageEncoding || "uadp";

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

      // ME-06: a JSON object/scalar (e.g. "{}") parses fine but is not iterable —
      // reject it with a clear operator-facing message rather than a cryptic
      // "rawWriters.map is not a function".
      if (!Array.isArray(rawWriters)) {
        throw new Error("writers must be a JSON array");
      }

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
      // ME-06: validation factories attach a collected `err.errors` list; surface all
      // of them (not just err.errors[0].message) so operators see every problem at once.
      let detail = err.message;
      if (Array.isArray(err.errors) && err.errors.length) {
        detail = err.errors
          .map(function (e) {
            return e && e.message ? e.message : String(e);
          })
          .join("; ");
      }
      node.error(detail);
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

    // ─── Cyclic latest-value state (Task 2 / HI-03) ───
    // _latestValues accumulates the latest value per field from inbound msgs (a field
    // is never auto-removed; the producer overwrites it). _publishedSnapshot holds the
    // field values of the LAST emitted keyframe. On each cyclic tick we deep-compare
    // _latestValues to _publishedSnapshot: unchanged → KeepAlive; changed → keyframe +
    // refresh the snapshot. This is real "no field value changed" detection (PUB-02),
    // not a one-shot dirty flag — a value that arrives equal to the last published one
    // does NOT force a keyframe.
    node._latestValues = {};
    node._publishedSnapshot = null; // null until the first keyframe is published
    node._interval = null;

    // Deep value-equality for the published-vs-current comparison (scalars + the
    // shallow plain objects produced by Object.assign of msg.payload fields).
    node._valuesChanged = function (current, snapshot) {
      if (snapshot === null) {
        return true; // nothing published yet → first frame must be a keyframe
      }
      return JSON.stringify(current) !== JSON.stringify(snapshot);
    };

    // ─── 6. Status (D4-10, STAT-01) ───
    node.status({ fill: "blue", shape: "dot", text: "idle" });

    // HI-05: connection-readiness gate. The shared transport's connect() is kicked off
    // async and not awaited, so an inbound publish can land before the socket/MQTT
    // client is connected. We gate sends on _connected and queue the single most-recent
    // pending NetworkMessage, flushed on 'connected', so the first inject is not silently
    // dropped (UDP would surface a tolerable error; MQTT would drop with only an event).
    node._connected = false;
    node._pendingSend = null;

    node._setPublishing = function () {
      node.status({ fill: "green", shape: "ring", text: "publishing" });
    };

    node._statusCb = function (status, err) {
      switch (status) {
        case "connected":
          node._connected = true;
          node.status({ fill: "green", shape: "dot", text: "connected" });
          // Flush the most-recent pending publish queued before we were connected.
          if (node._pendingSend) {
            const queued = node._pendingSend;
            node._pendingSend = null;
            try {
              node._emit(queued);
            } catch (e) {
              node.error(e.message);
              node.status({ fill: "red", shape: "ring", text: "error" });
            }
          }
          break;
        case "disconnected":
        case "reconnecting":
          node._connected = false;
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

    // HI-05: sections 7-9 run after the transport is acquired but before the `close`
    // handler is registered. Any throw in this window would leak the transport ref
    // permanently (the grace timer never starts because refCount never returns to 0).
    // Wrap it so a setup failure releases the transport and unregisters the status
    // callback (mirroring the section-4 pattern) before red-statusing.
    try {

    // ─── 7. NetworkMessage builder (keyframe) ───
    node._buildNetworkMessage = function (sourceValues) {
      sourceValues = sourceValues || {};
      // HI-04: UADP sequence numbers are UInt16; wrap modulo 0x10000 so a long-running
      // publisher rolls 65535 → 0 (spec-correct) instead of overflowing writeUInt16LE.
      node._nmSeq = (node._nmSeq + 1) & 0xFFFF;
      const payload = node.writers.map(function (writer) {
        const id = writer.dataSetWriterId;
        node._dsmSeq[id] = ((node._dsmSeq[id] || 0) + 1) & 0xFFFF;
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
      // HI-04: same UInt16 wraparound as the keyframe path.
      node._nmSeq = (node._nmSeq + 1) & 0xFFFF;
      const payload = node.writers.map(function (writer) {
        const id = writer.dataSetWriterId;
        node._dsmSeq[id] = ((node._dsmSeq[id] || 0) + 1) & 0xFFFF;
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
      // HI-05: hold sends until the transport reports 'connected'. Queue only the
      // most-recent NetworkMessage (older pending frames are superseded) so a burst of
      // pre-connect injects collapses to the latest, then flushes on 'connected'.
      if (!node._connected) {
        node._pendingSend = nm;
        return;
      }
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
          // HI-03: deep-compare the accumulated latest values against the last PUBLISHED
          // snapshot. Changed (or nothing published yet) → keyframe + refresh snapshot;
          // unchanged → KeepAlive. A value re-sent equal to the last published one does
          // NOT force a keyframe.
          if (node._valuesChanged(node._latestValues, node._publishedSnapshot)) {
            nm = node._buildNetworkMessage(node._latestValues);
            // Snapshot the exact values that went into this keyframe.
            node._publishedSnapshot = JSON.parse(JSON.stringify(node._latestValues));
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
          // Cyclic: merge the latest value per field; the interval decides keyframe vs
          // KeepAlive by comparing _latestValues to the last published snapshot (HI-03).
          Object.assign(node._latestValues, sourceValues);
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

    } catch (setupErr) {
      // HI-05: post-acquire setup failed — release the transport and unregister the
      // status callback so no ref leaks, then surface the error.
      if (conn.releaseTransport) {
        conn.releaseTransport();
      }
      if (conn.unregisterStatusCallback && node._statusCb) {
        conn.unregisterStatusCallback(node._statusCb);
      }
      node.error(setupErr.message);
      node.status({ fill: "red", shape: "ring", text: "setup error" });
      return;
    }

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

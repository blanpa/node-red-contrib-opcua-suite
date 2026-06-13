/**
 * OPC UA Subscriber Node (PubSub)
 *
 * User-facing PubSub worker node — the consuming half of the round-trip loop.
 * References an opcua-pubsub-connection config node, declares ONE DataSetReader
 * filter (publisherId / writerGroupId / dataSetWriterId, at least one required),
 * registers its OWN listener on the shared transport's "message" event, decodes
 * each NetworkMessage with the encoding-selected decoder, filters +
 * ConfigurationVersion-checks each DataSetMessage, and emits one msg per matched
 * message in the exact D4-09 shape, with node.status() driven by the connection's
 * status fan-out (STAT-01).
 *
 * Locked decisions honored: D4-01 (registration), D4-02 (connection ref),
 * D4-03 (encoding select + UDP-JSON reject), D4-07 (own listener register/cleanup,
 * decode tolerance), D4-08 (silent filter skip vs visible ConfigurationVersion
 * error), D4-09 (exact msg shape), D4-10 (status mapping).
 */

"use strict";

const { DataSetReader } = require("../lib/pubsub-config");

module.exports = function (RED) {
  function OpcUaSubscriberNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // ─── 1. Connection guard (D4-02) ───
    const conn = RED.nodes.getNode(config.connection);
    if (!conn) {
      node.status({ fill: "red", shape: "ring", text: "no connection" });
      return;
    }

    // ─── 2. Encoding selection (D4-03) ───
    const transportType = conn.transportType;
    const encoding =
      config.messageEncoding || (transportType === "udp" ? "uadp" : "uadp");

    // D4-03 hard rule: UDP transport requires UADP encoding (UDP-JSON unsupported).
    if (transportType === "udp" && encoding === "json") {
      node.error(
        "UDP transport requires UADP encoding (UDP-JSON is not supported)"
      );
      node.status({ fill: "red", shape: "ring", text: "udp requires uadp" });
      return;
    }

    const decoder =
      encoding === "json"
        ? require("../lib/json-encoder")
        : require("../lib/uadp-encoder");

    // ─── 3. Build the DataSetReader filter (SUB-01) ───
    const readerCfg = {};
    if (config.publisherId !== undefined && config.publisherId !== "") {
      readerCfg.publisherId = config.publisherId;
    }
    if (config.writerGroupId !== undefined && config.writerGroupId !== "") {
      readerCfg.writerGroupId = Number(config.writerGroupId);
    }
    if (config.dataSetWriterId !== undefined && config.dataSetWriterId !== "") {
      readerCfg.dataSetWriterId = Number(config.dataSetWriterId);
    }

    let reader;
    try {
      reader = DataSetReader(readerCfg);
    } catch (e) {
      node.error(e.message);
      node.status({ fill: "red", shape: "ring", text: "invalid reader" });
      return;
    }

    // ─── 4. Optional expected ConfigurationVersion (D4-08) ───
    let expectedCv = null;
    if (config.expectedConfigVersion && config.expectedConfigVersion !== "") {
      const parts = String(config.expectedConfigVersion).split(".");
      const major = Number(parts[0]);
      const minor = Number(parts[1]);
      if (!Number.isNaN(major) && !Number.isNaN(minor)) {
        expectedCv = { major: major, minor: minor };
      }
    }

    // ─── 5. Initial status (D4-10) ───
    node.status({ fill: "blue", shape: "dot", text: "idle" });

    // ─── 6. Status callback (D4-10, STAT-01) ───
    let isSubscribed = false;
    const statusCallback = function (event) {
      switch (event) {
        case "connected":
          node.status(
            isSubscribed
              ? { fill: "green", shape: "ring", text: "subscribed" }
              : { fill: "green", shape: "dot", text: "connected" }
          );
          break;
        case "disconnected":
          node.status({ fill: "yellow", shape: "ring", text: "disconnected" });
          break;
        case "reconnecting":
          node.status({ fill: "yellow", shape: "ring", text: "reconnecting" });
          break;
        case "error":
          node.status({ fill: "red", shape: "ring", text: "error" });
          break;
        default:
          break;
      }
    };
    conn.registerStatusCallback(statusCallback);

    // ─── 7. Field unwrap helper (D4-09) ───
    // dsm.fields[name] is a Variant { dataType, value } or a DataValue
    // { value: { dataType, value }, statusCode?, ... }.
    function unwrap(w) {
      if (w == null) return w;
      // DataValue: { value: { dataType, value } }
      if (w.value && typeof w.value === "object" && "value" in w.value) {
        return w.value.value;
      }
      // Variant: { dataType, value }
      if ("value" in w) return w.value;
      return w;
    }

    // ─── 8. NetworkMessage handler (D4-08, D4-09) ───
    function handleNetworkMessage(nm, metadata) {
      const publisherId = nm.publisherId;
      const writerGroupId = nm.groupHeader && nm.groupHeader.writerGroupId;
      const nmSeq = nm.groupHeader && nm.groupHeader.sequenceNumber;
      const writerIds =
        (nm.payloadHeader && nm.payloadHeader.dataSetWriterIds) || [];

      const messages = nm.payload || [];
      for (let i = 0; i < messages.length; i++) {
        const dsm = messages[i];
        // The UADP decoder carries dataSetWriterId in payloadHeader only; the JSON
        // decoder carries it on the DataSetMessage. Prefer the dsm value, fall back
        // to the positional payloadHeader id.
        const dataSetWriterId =
          dsm.dataSetWriterId !== undefined ? dsm.dataSetWriterId : writerIds[i];

        // a. Filter (D4-08 — silent skip, NOT an error).
        if (
          reader.publisherId !== undefined &&
          String(reader.publisherId) !== String(publisherId)
        ) {
          continue;
        }
        if (
          reader.writerGroupId !== undefined &&
          reader.writerGroupId !== writerGroupId
        ) {
          continue;
        }
        if (
          reader.dataSetWriterId !== undefined &&
          reader.dataSetWriterId !== dataSetWriterId
        ) {
          continue;
        }

        // b. ConfigurationVersion check (D4-08 — VISIBLE error, NOT silent).
        const got = dsm.configurationVersion;
        if (
          expectedCv &&
          got &&
          (got.major !== expectedCv.major || got.minor !== expectedCv.minor)
        ) {
          node.error(
            "ConfigurationVersion mismatch: expected " +
              expectedCv.major +
              "." +
              expectedCv.minor +
              ", got " +
              got.major +
              "." +
              got.minor
          );
          continue; // dropped from output, but logged — NEVER silently swallowed
        }

        // c. Unwrap fields to raw scalars (D4-09).
        const payload = {};
        const fields = dsm.fields || {};
        for (const name of Object.keys(fields)) {
          payload[name] = unwrap(fields[name]);
        }

        // d. Build + send the D4-09 msg (one per matched DataSetMessage).
        const msg = {
          payload: payload,
          publisherId: publisherId,
          writerGroupId: writerGroupId,
          dataSetWriterId: dataSetWriterId,
          sequenceNumber: nmSeq !== undefined ? nmSeq : dsm.sequenceNumber,
          timestamp: dsm.timestamp || nm.timestamp || new Date(),
          statusCode: dsm.status !== undefined ? dsm.status : 0,
          encoding: encoding,
          transport: transportType
        };
        // topic: MQTT only — OMITTED entirely for UDP.
        if (transportType === "mqtt" && metadata && metadata.topic) {
          msg.topic = metadata.topic;
        }
        node.send(msg);
      }
    }

    // ─── 9. Acquire transport + register OWN message listener (D4-07) ───
    const transport = conn.acquireTransport();
    const onMessage = function (buffer, metadata) {
      try {
        // MQTT-JSON arrives as a Buffer; the JSON decoder takes a STRING.
        const input = encoding === "json" ? buffer.toString() : buffer;
        const nm = decoder.decodeNetworkMessage(input);
        handleNetworkMessage(nm, metadata);
      } catch (e) {
        // D4-07: never throw out of the EventEmitter callback (keep the shared
        // transport and sibling subscribers alive).
        node.error("PubSub decode error: " + e.message);
      }
    };
    transport.on("message", onMessage);
    isSubscribed = true;
    node.status({ fill: "green", shape: "ring", text: "subscribed" });

    // ─── 10. Close handler (D4-07 cleanup ordering) ───
    node.on("close", function (removed, done) {
      // removeListener MUST run before releaseTransport so the shared ref-counted
      // transport sheds this node's listener even when a sibling keeps it alive.
      try {
        transport.removeListener("message", onMessage);
      } catch (e) {
        /* ignore */
      }
      if (conn.unregisterStatusCallback) {
        conn.unregisterStatusCallback(statusCallback);
      }
      try {
        conn.releaseTransport();
      } catch (e) {
        /* ignore */
      }
      done();
    });
  }

  RED.nodes.registerType("opcua-subscriber", OpcUaSubscriberNode);
};

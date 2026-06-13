"use strict";

/**
 * PubSub round-trip integration tests (TEST-01, D4-11).
 *
 * Drives a REAL opcua-publisher + REAL opcua-subscriber (via the project's
 * hand-rolled createRED() mock — NOT node-red-node-test-helper) over a REAL
 * transport, for all three shipped combinations:
 *   - UDP-UADP   (real dgram multicast loopback; setMulticastLoopback already on)
 *   - MQTT-UADP  (in-process aedes broker on 127.0.0.1 at an EPHEMERAL port)
 *   - MQTT-JSON  (same aedes broker; JSON self-describes types)
 *
 * A published DataSet must arrive at the subscriber's send() with identical field
 * names, decoded values, JS types, and the publisher's sequenceNumber (D4-09).
 *
 * Determinism: every round-trip resolves on the subscriber's send() stub — NEVER
 * on a delivery sleep. The only time bound is the Mocha timeout failsafe so a
 * broken wire fails fast instead of hanging. The MQTT broker is in-process on
 * loopback and torn down per test; no external broker is ever contacted.
 *
 * Decoder nuances exercised here (verified in 04-02-SUMMARY Deviations):
 *   - UADP DataSetMessages carry NO own dataSetWriterId — it is read positionally
 *     from payloadHeader.dataSetWriterIds[index]; assert on msg.dataSetWriterId.
 *   - JSON NetworkMessages have NO groupHeader — msg.writerGroupId is UNDEFINED and
 *     sequenceNumber falls back to the DataSetMessage value; the MQTT-JSON
 *     subscriber filters on publisherId, NOT writerGroupId.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const net = require("net");
// aedes 1.x removed the synchronous default-export factory; the broker is created
// via the async Aedes.createBroker() static (see node_modules/aedes MIGRATION.MD).
const { Aedes } = require("aedes");
const { UdpTransport } = require("../lib/transports/udp-transport");
const { MqttTransport } = require("../lib/transports/mqtt-transport");

// ─── createRED() ctor-capture mock (verbatim convention from opcua-nodes.test.js,
//     extended with a node.send stub so the subscriber's emit is observable) ───
function createRED(nodeOverrides) {
  const types = {};
  const registeredNodes = {};
  return {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = (event, cb) => {
          (node._events[event] = node._events[event] || []).push(cb);
        };
        node.status = sinon.stub();
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
        node.send = sinon.stub();
      },
      registerType(name, ctor, opts) {
        types[name] = { constructor: ctor, opts };
      },
      getNode(id) {
        return registeredNodes[id] || (nodeOverrides && nodeOverrides[id]) || null;
      },
      _types: types,
      _registered: registeredNodes,
    },
  };
}

// ─── Connection-node stub: returns the SAME real transport to both worker nodes
//     and kicks off connect() on first acquire (mirrors the real config node). ───
function makeConnStub(transport, props) {
  let refs = 0;
  return Object.assign(
    {
      acquireTransport() {
        refs += 1;
        if (refs === 1) {
          // Connect once on first acquire; failures surface via the transport
          // 'error' event the round-trip listens for.
          Promise.resolve()
            .then(() => transport.connect())
            .catch(() => {});
        }
        return transport;
      },
      releaseTransport() {
        refs -= 1;
      },
      registerStatusCallback() {},
      unregisterStatusCallback() {},
      _refs: () => refs,
    },
    props
  );
}

// Unique-ish UDP port per round-trip to avoid collisions across repeated runs.
function freshPort() {
  return 45678 + Math.floor(Math.random() * 5000);
}

// ─── In-process aedes broker on an EPHEMERAL loopback port (NEVER external) ───
async function startAedes() {
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "mqtt://127.0.0.1:" + server.address().port;
  return { broker, server, url };
}

async function stopAedes(mq) {
  if (!mq) return;
  await new Promise((r) => mq.server.close(r));
  await new Promise((r) => mq.broker.close(r));
}

// Re-require both nodes against a single RED so getNode() resolves the SAME conn
// stub for publisher and subscriber, and registerType re-runs each call.
function loadNodes(RED) {
  ["opcua-publisher.js", "opcua-subscriber.js"].forEach((f) => {
    const p = path.resolve(__dirname, "..", "nodes", f);
    delete require.cache[require.resolve(p)];
    require(p)(RED);
  });
  return {
    Pub: RED.nodes._types["opcua-publisher"].constructor,
    Sub: RED.nodes._types["opcua-subscriber"].constructor,
  };
}

// A 3-field PublishedDataSet (Double / String / Int32) shared by every combo.
const FIELDS = [
  { name: "temperature", dataType: "Double" },
  { name: "label", dataType: "String" },
  { name: "count", dataType: "Int32" },
];

function publisherConfig(encoding) {
  return {
    id: "pub1",
    connection: "conn1",
    messageEncoding: encoding,
    publishMode: "acyclic",
    publishingInterval: 1000,
    writerGroupId: 1,
    priority: 128,
    maxNetworkMessageSize: 1400,
    writers: JSON.stringify([
      {
        dataSetWriterId: 1,
        dataSetName: "DataSet1",
        publishedDataSet: { name: "DataSet1", fields: FIELDS },
      },
    ]),
  };
}

// Both UADP and JSON now carry the writer-group identity (CR-02 fix), so every
// transport can filter on writerGroupId.
function subscriberConfig(encoding, publisherId) {
  const cfg = { id: "sub1", connection: "conn1", messageEncoding: encoding };
  cfg.writerGroupId = 1;
  return cfg;
}

describe("PubSub round-trip — TEST-01", function () {
  this.timeout(10000);

  let currentTransport = null;
  let currentNodes = [];
  let mq = null;

  async function fireClose(node) {
    if (!node || !node._events || !node._events.close) return;
    await new Promise((res) => node._events.close[0](false, () => res()));
  }

  afterEach(async function () {
    for (const n of currentNodes) {
      try {
        await fireClose(n);
      } catch (e) {
        /* ignore teardown errors */
      }
    }
    currentNodes = [];
    if (currentTransport) {
      try {
        await currentTransport.close();
      } catch (e) {
        /* ignore */
      }
      currentTransport = null;
    }
    if (mq) {
      await stopAedes(mq);
      mq = null;
    }
    sinon.restore();
  });

  // Build publisher + subscriber over a real transport, await readiness, publish
  // once, resolve on the subscriber's send(). publishCount > 1 fires multiple
  // inbound msgs and resolves after the Nth emitted msg (for monotonicity).
  function roundTrip({ transport, encoding, publisherId, payloads }) {
    currentTransport = transport;
    return new Promise((resolve, reject) => {
      const connStub = makeConnStub(transport, {
        transportType: transport instanceof UdpTransport ? "udp" : "mqtt",
        publisherId: String(publisherId),
      });
      const RED = createRED({ conn1: connStub });
      const { Pub, Sub } = loadNodes(RED);

      const emitted = [];
      const subNode = {};
      Sub.call(subNode, subscriberConfig(encoding, publisherId));
      subNode.send = (msg) => {
        emitted.push(msg);
        if (emitted.length >= payloads.length) {
          resolve({ msgs: emitted, transport });
        }
      };

      const pubNode = {};
      Pub.call(pubNode, publisherConfig(encoding));

      currentNodes.push(subNode, pubNode);
      transport.on("error", reject);

      // Deterministic readiness: publish only after the transport is connected
      // (MQTT subscribe is issued inside the connect handler before 'connected'
      // resolves; UDP loopback is ready as soon as the socket is bound).
      const publishAll = () => {
        const sendStub = sinon.stub();
        const doneStub = sinon.stub();
        for (const payload of payloads) {
          pubNode._events.input[0]({ payload }, sendStub, doneStub);
        }
      };

      if (transport.listenerCount && transport._connectedForTest) {
        publishAll();
      } else {
        transport.once("connected", () => {
          // Give the broker a microtask to register the subscription grant for
          // MQTT before the first publish; harmless for UDP.
          setImmediate(publishAll);
        });
      }
    });
  }

  describe("UDP-UADP", function () {
    it("round-trips fields/types/sequenceNumber (real dgram loopback)", async function () {
      const transport = new UdpTransport({
        port: freshPort(),
        multicastGroup: "239.0.0.1",
      });
      const { msgs } = await roundTrip({
        transport,
        encoding: "uadp",
        publisherId: "pub1",
        payloads: [{ temperature: 21.5, label: "ok", count: 7 }],
      });
      const msg = msgs[0];
      expect(msg.payload).to.deep.equal({
        temperature: 21.5,
        label: "ok",
        count: 7,
      });
      expect(typeof msg.payload.temperature).to.equal("number");
      expect(msg.payload.temperature).to.equal(21.5); // exact Double
      expect(typeof msg.payload.label).to.equal("string");
      expect(Number.isInteger(msg.payload.count)).to.equal(true);
      expect(msg.sequenceNumber).to.equal(1); // publisher's first emitted NM seq
      expect(msg.encoding).to.equal("uadp");
      expect(msg.transport).to.equal("udp");
      expect(msg.topic).to.equal(undefined);
      expect(msg.dataSetWriterId).to.equal(1); // positional from payloadHeader
    });

    it("sequenceNumber increases across two publishes (monotonic)", async function () {
      const transport = new UdpTransport({
        port: freshPort(),
        multicastGroup: "239.0.0.1",
      });
      const { msgs } = await roundTrip({
        transport,
        encoding: "uadp",
        publisherId: "pub1",
        payloads: [
          { temperature: 21.5, label: "a", count: 1 },
          { temperature: 22.0, label: "b", count: 2 },
        ],
      });
      expect(msgs).to.have.length(2);
      expect(msgs[1].sequenceNumber).to.be.greaterThan(msgs[0].sequenceNumber);
      expect(msgs[0].sequenceNumber).to.equal(1);
      expect(msgs[1].sequenceNumber).to.equal(2);
      expect(msgs[1].payload).to.deep.equal({
        temperature: 22.0,
        label: "b",
        count: 2,
      });
    });
  });

  describe("MQTT-UADP", function () {
    beforeEach(async function () {
      mq = await startAedes();
    });

    it("round-trips fields/types/sequenceNumber + msg.topic set (in-process aedes loopback)", async function () {
      const transport = new MqttTransport({
        brokerUrl: mq.url,
        qos: 0,
        topicPrefix: "ua",
        publisherId: "pub1",
        reconnectPeriod: 0,
      });
      const { msgs } = await roundTrip({
        transport,
        encoding: "uadp",
        publisherId: "pub1",
        payloads: [{ temperature: 21.5, label: "ok", count: 7 }],
      });
      const msg = msgs[0];
      expect(msg.payload).to.deep.equal({
        temperature: 21.5,
        label: "ok",
        count: 7,
      });
      expect(typeof msg.payload.temperature).to.equal("number");
      expect(typeof msg.payload.label).to.equal("string");
      expect(Number.isInteger(msg.payload.count)).to.equal(true);
      expect(msg.sequenceNumber).to.equal(1);
      expect(msg.encoding).to.equal("uadp");
      expect(msg.transport).to.equal("mqtt");
      // topic = `${prefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}`
      expect(msg.topic).to.equal("ua/pub1/1/1");
    });
  });

  describe("MQTT-JSON", function () {
    beforeEach(async function () {
      mq = await startAedes();
    });

    it("round-trips fields/types AND delivers a writerGroupId-filtered message (CR-02)", async function () {
      const transport = new MqttTransport({
        brokerUrl: mq.url,
        qos: 0,
        topicPrefix: "ua",
        publisherId: "pub1",
        reconnectPeriod: 0,
      });
      const { msgs } = await roundTrip({
        transport,
        encoding: "json",
        publisherId: "pub1",
        payloads: [{ temperature: 21.5, label: "ok", count: 7 }],
      });
      const msg = msgs[0];
      expect(msg.payload).to.deep.equal({
        temperature: 21.5,
        label: "ok",
        count: 7,
      });
      expect(typeof msg.payload.temperature).to.equal("number");
      expect(typeof msg.payload.label).to.equal("string");
      expect(Number.isInteger(msg.payload.count)).to.equal(true);
      expect(msg.encoding).to.equal("json");
      expect(msg.transport).to.equal("mqtt");
      expect(msg.topic).to.equal("ua/pub1/1/1");
      // CR-02: the JSON NetworkMessage now carries the writer-group identity, so a
      // writerGroupId-filtered subscriber receives the message with the group id set.
      expect(msg.writerGroupId).to.equal(1);
      expect(msg.dataSetWriterId).to.equal(1);
      // sequenceNumber comes from the NM groupHeader sequence on BOTH transports.
      expect(msg.sequenceNumber).to.equal(1);
    });
  });
});

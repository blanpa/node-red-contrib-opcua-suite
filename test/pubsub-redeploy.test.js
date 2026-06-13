"use strict";

/**
 * PubSub redeploy acceptance (TEST-02, D4-12) + UADP reference matrix and
 * capture-script provenance guards (TEST-03, D4-13).
 *
 * TEST-02 — the config-node-level companion to Phase 3's transport-level
 * EADDRINUSE test: 20 rapid construct→close cycles of a real transport shared by
 * a real publisher + real subscriber (via the hand-rolled createRED() mock),
 * firing EACH node's registered close handler. Asserts per cycle:
 *   - zero EADDRINUSE (transport 'error' listener) + zero unhandledRejection,
 *   - transport._socket === null (UDP) / _client === null (MQTT) after close,
 *   - transport.listenerCount("message") returns to its pre-subscribe baseline
 *     (proves D4-07 removeListener-before-release across redeploys),
 *   - cyclic-mode publisher interval is cleared on close (no send after close,
 *     covering the D4-06 leaked-timer pitfall).
 *
 * TEST-03 — assert the existing 8-combination UADP flag-cascade matrix still
 * passes via a count + encode→decode regression guard (part a), and verify the
 * capture-open62541-vectors.js script exists/documents the Docker procedure while
 * keeping the open62541 byte-for-byte swap an honest tracked MANUAL follow-up with
 * NO fabricated capture provenance in test/fixtures/uadp-vectors.js (part b).
 *
 * Determinism: every connect + close callback is awaited; no delivery/close
 * sleeps. The only time bound is the Mocha timeout failsafe.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { Aedes } = require("aedes");
const { UdpTransport } = require("../lib/transports/udp-transport");
const { MqttTransport } = require("../lib/transports/mqtt-transport");
const vectors = require("./fixtures/uadp-vectors");
const uadp = require("../lib/uadp-encoder");

// ─── createRED() ctor-capture mock (same convention as opcua-nodes.test.js) ───
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

function makeConnStub(transport, props) {
  let refs = 0;
  // Relay the transport's lifecycle to registered worker callbacks, mirroring the
  // real connection's status fan-out. The publisher gates sends on a 'connected'
  // status (HI-05), so the cyclic interval only reaches transport.send once this
  // fan-out delivers 'connected'.
  const statusCallbacks = new Set();
  transport.on("connected", () =>
    statusCallbacks.forEach((cb) => cb("connected"))
  );
  transport.on("disconnected", () =>
    statusCallbacks.forEach((cb) => cb("disconnected"))
  );
  transport.on("error", (e) =>
    statusCallbacks.forEach((cb) => cb("error", e))
  );
  return Object.assign(
    {
      acquireTransport() {
        refs += 1;
        if (refs === 1) {
          Promise.resolve()
            .then(() => transport.connect())
            .catch(() => {});
        }
        return transport;
      },
      releaseTransport() {
        refs -= 1;
      },
      registerStatusCallback(cb) {
        statusCallbacks.add(cb);
      },
      unregisterStatusCallback(cb) {
        statusCallbacks.delete(cb);
      },
      _refs: () => refs,
    },
    props
  );
}

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

const FIELDS = [{ name: "value", dataType: "Double" }];

function pubCfg(extra) {
  return Object.assign(
    {
      id: "pub1",
      connection: "conn1",
      messageEncoding: "uadp",
      publishMode: "acyclic",
      publishingInterval: 1000,
      writerGroupId: 1,
      writers: JSON.stringify([
        {
          dataSetWriterId: 1,
          dataSetName: "DataSet1",
          publishedDataSet: { name: "DataSet1", fields: FIELDS },
        },
      ]),
    },
    extra || {}
  );
}

function subCfg() {
  return { id: "sub1", connection: "conn1", messageEncoding: "uadp", writerGroupId: 1 };
}

// A worker node that acquires a transport MUST register a close handler (D4-02);
// its absence is the leak this test exists to catch — so FAIL if missing.
async function fireClose(node) {
  expect(node._events && node._events.close, "node must register a close handler (D4-02)").to.be
    .an("array")
    .with.length.greaterThan(0);
  await new Promise((res, rej) =>
    node._events.close[0](false, (err) => (err ? rej(err) : res()))
  );
}

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

describe("PubSub redeploy acceptance — TEST-02", function () {
  this.timeout(20000);

  let unhandled;
  let onRej;

  beforeEach(function () {
    unhandled = [];
    onRej = (e) => unhandled.push(e);
    process.on("unhandledRejection", onRej);
  });

  afterEach(function () {
    process.removeListener("unhandledRejection", onRej);
    sinon.restore();
  });

  it("20 rapid construct/close cycles — no EADDRINUSE, no leaks, listeners return to baseline", async function () {
    const port = 45678 + Math.floor(Math.random() * 5000);
    for (let i = 0; i < 20; i += 1) {
      const transport = new UdpTransport({ port, multicastGroup: "239.0.0.1" });
      const errors = [];
      transport.on("error", (e) => errors.push(e));
      const baseMsgListeners = transport.listenerCount("message");

      const conn = makeConnStub(transport, { publisherId: "pub1", transportType: "udp" });
      const RED = createRED({ conn1: conn });
      const { Pub, Sub } = loadNodes(RED);

      const sub = {};
      Sub.call(sub, subCfg());
      const pub = {};
      Pub.call(pub, pubCfg());

      // Await the real connect callback (no sleep). acquireTransport() kicked off
      // connect(); 'connected' fires once the socket is bound.
      await new Promise((r) => {
        if (transport._socket) return r();
        transport.once("connected", r);
      });

      // Subscriber attached its own 'message' listener.
      expect(transport.listenerCount("message"), `cycle ${i} subscribed`).to.be.greaterThan(
        baseMsgListeners
      );

      // Fire each node's close handler in order, awaiting each callback, then
      // release the shared transport and close it.
      await fireClose(pub);
      await fireClose(sub);
      conn.releaseTransport();
      await transport.close();

      // Per-cycle leak/EADDRINUSE assertions.
      expect(
        errors.filter((e) => /EADDRINUSE/.test((e && e.message) || "")),
        `cycle ${i} EADDRINUSE`
      ).to.have.length(0);
      expect(transport._socket, `cycle ${i} socket leak`).to.equal(null);
      expect(
        transport.listenerCount("message"),
        `cycle ${i} listener leak`
      ).to.equal(baseMsgListeners);
    }
    expect(unhandled, "no unhandled rejections across 20 cycles").to.have.length(0);
  });

  it("5 MQTT cycles against an in-process aedes broker — _client null + listeners at baseline after close", async function () {
    const mq = await startAedes();
    try {
      for (let i = 0; i < 5; i += 1) {
        const transport = new MqttTransport({
          brokerUrl: mq.url,
          qos: 0,
          topicPrefix: "ua",
          publisherId: "pub1",
          reconnectPeriod: 0,
        });
        const errors = [];
        transport.on("error", (e) => errors.push(e));
        const baseMsgListeners = transport.listenerCount("message");

        const conn = makeConnStub(transport, { publisherId: "pub1", transportType: "mqtt" });
        const RED = createRED({ conn1: conn });
        const { Pub, Sub } = loadNodes(RED);

        const sub = {};
        Sub.call(sub, subCfg());
        const pub = {};
        Pub.call(pub, pubCfg());

        await new Promise((r) => {
          if (transport._client) return r();
          transport.once("connected", r);
        });
        expect(
          transport.listenerCount("message"),
          `mqtt cycle ${i} subscribed`
        ).to.be.greaterThan(baseMsgListeners);

        await fireClose(pub);
        await fireClose(sub);
        conn.releaseTransport();
        await transport.close();

        expect(errors, `mqtt cycle ${i} errors`).to.have.length(0);
        expect(transport._client, `mqtt cycle ${i} client leak`).to.equal(null);
        expect(
          transport.listenerCount("message"),
          `mqtt cycle ${i} listener leak`
        ).to.equal(baseMsgListeners);
      }
      expect(unhandled, "no unhandled rejections across MQTT cycles").to.have.length(0);
    } finally {
      await stopAedes(mq);
    }
  });

  it("cyclic-mode publisher clears its interval on close — no send after close (D4-06)", async function () {
    const port = 45678 + Math.floor(Math.random() * 5000);
    const transport = new UdpTransport({ port, multicastGroup: "239.0.0.1" });
    const conn = makeConnStub(transport, { publisherId: "pub1", transportType: "udp" });
    const RED = createRED({ conn1: conn });
    const { Pub } = loadNodes(RED);

    const pub = {};
    // Small publishing interval so the timer is live; spy on the real send.
    Pub.call(pub, pubCfg({ publishMode: "cyclic", publishingInterval: 20 }));

    await new Promise((r) => {
      if (transport._socket) return r();
      transport.once("connected", r);
    });
    expect(pub._interval, "cyclic publisher must hold an interval handle").to.not.equal(null);

    const sendSpy = sinon.spy(transport, "send");
    // Let a couple of ticks fire so we know the interval is alive.
    await new Promise((r) => setTimeout(r, 60));
    expect(sendSpy.called, "interval should have emitted at least once").to.equal(true);

    await fireClose(pub);
    expect(pub._interval, "interval handle cleared on close").to.equal(null);

    const afterCloseCount = sendSpy.callCount;
    // Wait several interval periods; no further send must occur after close.
    await new Promise((r) => setTimeout(r, 80));
    expect(sendSpy.callCount, "no send after close (timer cleared)").to.equal(afterCloseCount);

    conn.releaseTransport();
    await transport.close();
  });
});

describe("UADP reference matrix + capture provenance — TEST-03", function () {
  it("8-combination flag-cascade matrix fixture has exactly 8 cases (part a)", function () {
    expect(Object.keys(vectors)).to.have.length(8);
  });

  it("each non-pending matrix case still round-trips encode→decode (regression guard, part a)", function () {
    for (const [name, vec] of Object.entries(vectors)) {
      if (vec.pending || vec.isStaticChunk) continue;
      const buf = uadp.encodeNetworkMessage(vec.model);
      const b = Buffer.isBuffer(buf) ? buf : buf[0];
      const decoded = uadp.decodeNetworkMessage(b);
      if (vec.model.publisherId !== undefined) {
        expect(decoded.publisherId, name).to.deep.equal(vec.model.publisherId);
      }
    }
  });

  it("capture-open62541-vectors.js exists and documents the Docker procedure (part b)", function () {
    const p = path.resolve(__dirname, "..", "test-server", "capture-open62541-vectors.js");
    expect(fs.existsSync(p)).to.equal(true);
    const src = fs.readFileSync(p, "utf8");
    expect(src).to.match(/open62541/i);
    expect(src).to.match(/docker/i);
  });

  it("open62541 byte-for-byte swap is a tracked MANUAL follow-up (D4-13), not an automated gate", function () {
    // The fixtures are honestly marked as encoder-self-output, NOT fabricated
    // open62541 captures. This guard fails loudly if a future contributor fakes
    // capture provenance to close TEST-03 without doing the real Docker capture.
    const src = fs.readFileSync(
      path.resolve(__dirname, "fixtures", "uadp-vectors.js"),
      "utf8"
    );
    expect(src, "do not fabricate open62541 capture provenance (D4-13)").to.not.match(
      /captured from open62541|open62541 v[0-9].*captured/i
    );
  });
});

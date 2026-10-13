"use strict";

/**
 * A publisher that joins an already-connected transport must still send.
 *
 * The shared transport announces 'connected' exactly once. A publisher
 * redeployed on its own (Node-RED "modified nodes" deploy keeps the
 * connection config node and its transport) or added next to a running
 * subscriber registered its status callback after that announcement, kept
 * its HI-05 readiness gate closed and queued every message forever.
 *
 * Uses the real opcua-pubsub-connection + opcua-publisher; only the UDP
 * socket is stubbed so the test needs no multicast networking.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const { UdpTransport } = require("../lib/transports/udp-transport");

function createRED() {
  const types = {};
  const nodes = {};
  return {
    settings: { userDir: "/tmp" },
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
        node.credentials = {};
        nodes[config.id] = node;
      },
      registerType(name, ctor, opts) {
        types[name] = { constructor: ctor, opts };
      },
      getNode(id) {
        return nodes[id] || null;
      },
      _types: types,
    },
  };
}

function load(RED) {
  ["opcua-pubsub-connection.js", "opcua-publisher.js"].forEach((f) => {
    const p = path.resolve(__dirname, "..", "nodes", f);
    delete require.cache[require.resolve(p)];
    require(p)(RED);
  });
  return {
    Conn: RED.nodes._types["opcua-pubsub-connection"].constructor,
    Pub: RED.nodes._types["opcua-publisher"].constructor,
  };
}

const pubCfg = (id) => ({
  id,
  connection: "conn1",
  messageEncoding: "uadp",
  publishMode: "acyclic",
  publishingInterval: 1000,
  writerGroupId: 1,
  writers: JSON.stringify([
    {
      dataSetWriterId: 1,
      dataSetName: "DataSet1",
      publishedDataSet: {
        name: "DataSet1",
        fields: [{ name: "value", dataType: "Double" }],
      },
    },
  ]),
});

const flush = () => new Promise((r) => setImmediate(r));

function closeNode(node) {
  return new Promise((resolve) => node._events.close[0](false, resolve));
}

function inject(node, payload) {
  return node._events.input[0]({ payload }, sinon.stub(), sinon.stub());
}

describe("PubSub publisher joining a connected transport", function () {
  let RED, Conn, Pub, conn, sendStub, clock;

  beforeEach(function () {
    // connect() behaves like a successful bind: announce, then resolve.
    sinon.stub(UdpTransport.prototype, "connect").callsFake(function () {
      this.emit("connected");
      return Promise.resolve();
    });
    sinon.stub(UdpTransport.prototype, "close").callsFake(function () {
      setImmediate(() => this.emit("disconnected"));
      return Promise.resolve();
    });
    sendStub = sinon.stub(UdpTransport.prototype, "send");
    RED = createRED();
    ({ Conn, Pub } = load(RED));
    conn = new Conn({
      id: "conn1",
      transportType: "udp",
      publisherIdType: "String",
      publisherId: "pub-test",
    });
  });

  afterEach(async function () {
    if (clock) clock.restore();
    clock = null;
    await closeNode(conn);
    sinon.restore();
  });

  it("a publisher redeployed on its own sends on the reused transport", async function () {
    const first = new Pub(pubCfg("pub1"));
    await flush();
    await inject(first, { value: 1 });
    expect(sendStub.callCount).to.equal(1);

    // Modified-nodes deploy: the publisher is closed and rebuilt, the
    // connection config node and its transport stay.
    await closeNode(first);
    const second = new Pub(pubCfg("pub1"));
    await flush();
    await inject(second, { value: 2 });

    expect(sendStub.callCount).to.equal(2);
    expect(UdpTransport.prototype.connect.callCount).to.equal(1);
    await closeNode(second);
  });

  it("a second publisher added to a running transport sends", async function () {
    const first = new Pub(pubCfg("pub1"));
    await flush();
    const added = new Pub(pubCfg("pub2"));
    await inject(added, { value: 3 });

    expect(sendStub.callCount).to.equal(1);
    await closeNode(first);
    await closeNode(added);
  });

  it("a late 'disconnected' from a transport closed by the grace timer does not stall its replacement", async function () {
    clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = new Pub(pubCfg("pub1"));
    await flush();
    await closeNode(first);
    clock.tick(501); // grace timer closes the old transport

    // The replacement connects before the old socket reports its close.
    const second = new Pub(pubCfg("pub1"));
    await flush();
    await flush();
    await inject(second, { value: 4 });

    expect(UdpTransport.prototype.connect.callCount).to.equal(2);
    expect(sendStub.callCount).to.equal(1);
    await closeNode(second);
  });
});

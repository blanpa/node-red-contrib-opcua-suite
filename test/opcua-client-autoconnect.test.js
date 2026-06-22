"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

// ─── Shared RED mock (same pattern as opcua-client-retry.test.js) ───

function createRED(nodeOverrides) {
  const types = {};
  return {
    nodes: {
      createNode: function (node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = function (event, cb) {
          (node._events[event] = node._events[event] || []).push(cb);
        };
        node.status = sinon.stub();
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
      },
      registerType: function (name, ctor, opts) {
        types[name] = { constructor: ctor, opts };
      },
      getNode: function (id) {
        return nodeOverrides?.[id] || null;
      },
      _types: types,
    },
  };
}

function createMockEndpoint(mockMgr) {
  return {
    getSharedManager: sinon.stub().returns(mockMgr),
    releaseSharedManager: sinon.stub().resolves(),
    registerStatusCallback: sinon.stub(),
    unregisterStatusCallback: sinon.stub(),
  };
}

function loadClientNode(RED) {
  const p = path.resolve(__dirname, "..", "nodes", "opcua-client.js");
  delete require.cache[require.resolve(p)];
  require(p)(RED);
  return RED.nodes._types["opcua-client"].constructor;
}

// Wait for pending microtasks (the proactive connect() runs detached).
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("opcua-client connect on deploy", function () {
  let mgr, RED, ctor;

  beforeEach(function () {
    mgr = {
      isConnected: false,
      connect: sinon.stub().callsFake(async function () {
        mgr.isConnected = true;
      }),
    };
    RED = createRED({ ep1: createMockEndpoint(mgr) });
    ctor = loadClientNode(RED);
  });

  it("should connect proactively on deploy (autoConnect default)", async function () {
    const node = {};
    ctor.call(node, { id: "c1", endpoint: "ep1" });
    await flush();

    expect(mgr.connect.calledOnce).to.be.true;
    // Shows "connecting..." immediately, before the connection resolves
    expect(node.status.calledWith(sinon.match({ text: "connecting..." }))).to.be
      .true;
  });

  it("should NOT connect on deploy when autoConnect is false", async function () {
    const node = {};
    ctor.call(node, { id: "c2", endpoint: "ep1", autoConnect: false });
    await flush();

    expect(mgr.connect.called).to.be.false;
    expect(node.status.calledWith(sinon.match({ text: "not connected" }))).to.be
      .true;
  });

  it("should not re-connect when another client already connected", async function () {
    mgr.isConnected = true;
    const node = {};
    ctor.call(node, { id: "c3", endpoint: "ep1" });
    await flush();

    expect(mgr.connect.called).to.be.false;
    expect(node.status.calledWith(sinon.match({ fill: "green" }))).to.be.true;
  });

  it("should warn but not throw when the initial connect fails", async function () {
    mgr.connect = sinon.stub().rejects(new Error("ECONNREFUSED"));
    const node = {};
    ctor.call(node, { id: "c4", endpoint: "ep1" });
    await flush();

    expect(mgr.connect.calledOnce).to.be.true;
    expect(node.warn.calledWithMatch(/Initial connect failed/)).to.be.true;
  });
});

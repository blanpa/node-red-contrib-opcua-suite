"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

// Reuses the lightweight RED/manager mock pattern from opcua-client-retry.test.js
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

function resultFor(nodeId, value, dataType) {
  return {
    nodeId,
    value,
    dataType: dataType || "Boolean",
    statusCode: "Good (0x00000000)",
    sourceTimestamp: null,
    serverTimestamp: new Date(),
  };
}

describe("opcua-client unwrap single value", function () {
  let mgr, RED, ctor;

  beforeEach(function () {
    mgr = {
      isConnected: true,
      connect: sinon.stub().resolves(),
      readMultiple: sinon.stub(),
      _isConnectionLostError: () => false,
    };
    RED = createRED({ ep1: createMockEndpoint(mgr) });
    ctor = loadClientNode(RED);
  });

  async function fire(config, msg) {
    const node = {};
    ctor.call(node, Object.assign({ id: "c1", endpoint: "ep1" }, config));
    const send = sinon.stub();
    const done = sinon.stub();
    await node._events["input"][0](msg, send, done);
    return { send, done };
  }

  it("returns the scalar value when unwrapSingle is on and one item is read", async function () {
    mgr.readMultiple.resolves([resultFor("ns=3;s=Bool", false, "Boolean")]);

    const { send, done } = await fire(
      { unwrapSingle: true },
      { operation: "readmultiple", items: [{ nodeId: "ns=3;s=Bool" }] },
    );

    const out = send.firstCall.args[0];
    expect(out.payload).to.equal(false);
    expect(out.dataType).to.equal("Boolean");
    expect(out.nodeId).to.equal("ns=3;s=Bool");
    expect(out.count).to.equal(1);
    expect(done.calledOnce).to.be.true;
  });

  it("keeps the array when unwrapSingle is off (default)", async function () {
    mgr.readMultiple.resolves([resultFor("ns=3;s=Bool", false, "Boolean")]);

    const { send } = await fire(
      {},
      { operation: "readmultiple", items: [{ nodeId: "ns=3;s=Bool" }] },
    );

    const out = send.firstCall.args[0];
    expect(out.payload).to.be.an("array").with.lengthOf(1);
    expect(out.payload[0].value).to.equal(false);
  });

  it("keeps the array for two or more items even with unwrapSingle on", async function () {
    mgr.readMultiple.resolves([
      resultFor("ns=3;s=A", true, "Boolean"),
      resultFor("ns=3;s=B", false, "Boolean"),
    ]);

    const { send } = await fire(
      { unwrapSingle: true },
      {
        operation: "readmultiple",
        items: [{ nodeId: "ns=3;s=A" }, { nodeId: "ns=3;s=B" }],
      },
    );

    const out = send.firstCall.args[0];
    expect(out.payload).to.be.an("array").with.lengthOf(2);
  });

  it("lets msg.unwrapSingle override the node default (off -> on)", async function () {
    mgr.readMultiple.resolves([resultFor("ns=3;s=Bool", false, "Boolean")]);

    const { send } = await fire(
      { unwrapSingle: false },
      {
        operation: "readmultiple",
        items: [{ nodeId: "ns=3;s=Bool" }],
        unwrapSingle: true,
      },
    );

    expect(send.firstCall.args[0].payload).to.equal(false);
  });

  it("lets msg.unwrapSingle override the node default (on -> off)", async function () {
    mgr.readMultiple.resolves([resultFor("ns=3;s=Bool", false, "Boolean")]);

    const { send } = await fire(
      { unwrapSingle: true },
      {
        operation: "readmultiple",
        items: [{ nodeId: "ns=3;s=Bool" }],
        unwrapSingle: false,
      },
    );

    expect(send.firstCall.args[0].payload).to.be.an("array").with.lengthOf(1);
  });

  it("unwraps a single-item 'read' that auto-switches to readmultiple", async function () {
    mgr.readMultiple.resolves([resultFor("ns=3;s=Bool", false, "Boolean")]);

    const { send } = await fire(
      { unwrapSingle: true },
      { operation: "read", items: [{ nodeId: "ns=3;s=Bool" }] },
    );

    expect(send.firstCall.args[0].payload).to.equal(false);
  });
});

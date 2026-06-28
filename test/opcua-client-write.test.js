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

describe("opcua-client write passthrough (arrayType / dataTypeNodeId)", function () {
  let mgr, RED, ctor;

  beforeEach(function () {
    mgr = {
      isConnected: true,
      connect: sinon.stub().resolves(),
      write: sinon.stub().resolves({ statusCode: "Good (0x00000000)" }),
      writeMultiple: sinon
        .stub()
        .resolves([{ nodeId: "ns=2;s=A", statusCode: "Good (0x00000000)" }]),
      _isConnectionLostError: () => false,
    };
    RED = createRED({ ep1: createMockEndpoint(mgr) });
    ctor = loadClientNode(RED);
  });

  async function fire(msg) {
    const node = {};
    ctor.call(node, { id: "c1", endpoint: "ep1" });
    const send = sinon.stub();
    const done = sinon.stub();
    await node._events["input"][0](msg, send, done);
    return { send, done };
  }

  it("forwards arrayType on a writemultiple item", async function () {
    await fire({
      operation: "writemultiple",
      items: [
        { nodeId: "ns=2;s=Arr", value: [1, 2, 3], datatype: "Int32", arrayType: "Array" },
      ],
    });
    const forwarded = mgr.writeMultiple.firstCall.args[0];
    expect(forwarded[0].arrayType).to.equal("Array");
    expect(forwarded[0].datatype).to.equal("Int32");
  });

  it("forwards dataTypeNodeId on an ExtensionObject writemultiple item", async function () {
    await fire({
      operation: "writemultiple",
      items: [
        {
          nodeId: "ns=2;s=Struct",
          value: { a: 1 },
          datatype: "ExtensionObject",
          dataTypeNodeId: "ns=2;i=3003",
        },
      ],
    });
    const forwarded = mgr.writeMultiple.firstCall.args[0];
    expect(forwarded[0].dataTypeNodeId).to.equal("ns=2;i=3003");
    expect(forwarded[0].datatype).to.equal("ExtensionObject");
  });

  it("forwards arrayType on a single write", async function () {
    await fire({
      operation: "write",
      topic: "ns=2;s=Arr",
      payload: [1, 2, 3],
      datatype: "Int32",
      arrayType: "Array",
    });
    // mgr.write(nodeId, value, datatype, dataTypeNodeId, arrayType)
    const args = mgr.write.firstCall.args;
    expect(args[2]).to.equal("Int32");
    expect(args[4]).to.equal("Array");
  });

  it("defaults arrayType/dataTypeNodeId to null when absent", async function () {
    await fire({
      operation: "writemultiple",
      items: [{ nodeId: "ns=2;s=Plain", value: 42, datatype: "Int32" }],
    });
    const forwarded = mgr.writeMultiple.firstCall.args[0];
    expect(forwarded[0].arrayType).to.equal(null);
    expect(forwarded[0].dataTypeNodeId).to.equal(null);
  });
});

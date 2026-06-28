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

describe("opcua-client output operation", function () {
  let mgr, RED, ctor;

  beforeEach(function () {
    mgr = {
      isConnected: true,
      connect: sinon.stub().resolves(),
      read: sinon.stub().resolves({
        value: false,
        statusCode: "Good (0x00000000)",
        sourceTimestamp: null,
        serverTimestamp: new Date(),
      }),
      write: sinon.stub().resolves({ statusCode: "Good (0x00000000)" }),
      browse: sinon.stub().resolves([]),
      readMultiple: sinon
        .stub()
        .resolves([{ nodeId: "ns=3;s=A", value: 1, dataType: "Int32" }]),
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
    return { node, send, done };
  }

  it("sets operation 'read' on a single read output", async function () {
    const { send } = await fire({}, { topic: "ns=3;s=Bool", operation: "read" });
    expect(send.firstCall.args[0].operation).to.equal("read");
  });

  it("sets operation 'read' even when msg.operation was not provided", async function () {
    const { send } = await fire(
      { defaultOperation: "read" },
      { topic: "ns=3;s=Bool" },
    );
    expect(send.firstCall.args[0].operation).to.equal("read");
  });

  it("sets operation 'write' on a single write output", async function () {
    const { send } = await fire(
      {},
      { topic: "ns=3;s=Bool", operation: "write", payload: true },
    );
    expect(send.firstCall.args[0].operation).to.equal("write");
  });

  it("sets operation 'browse' on a browse output", async function () {
    const { send } = await fire(
      {},
      { topic: "ns=3;s=Folder", operation: "browse" },
    );
    expect(send.firstCall.args[0].operation).to.equal("browse");
  });

  it("normalizes operation casing to lower case", async function () {
    const { send } = await fire({}, { topic: "ns=3;s=Bool", operation: "Read" });
    expect(send.firstCall.args[0].operation).to.equal("read");
  });

  it("keeps the more specific 'readmultiple' when a read auto-switches to batch", async function () {
    const { send } = await fire(
      {},
      { operation: "read", items: [{ nodeId: "ns=3;s=A" }] },
    );
    expect(send.firstCall.args[0].operation).to.equal("readmultiple");
  });

  it("keeps operation set on the error output", async function () {
    mgr.read.rejects(new Error("boom"));
    const { send } = await fire({}, { topic: "ns=3;s=Bool", operation: "read" });
    const out = send.firstCall.args[0];
    expect(out.operation).to.equal("read");
    expect(out.error).to.exist;
  });
});

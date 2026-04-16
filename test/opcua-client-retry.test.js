"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

// ─── Shared RED mock (same pattern as opcua-nodes.test.js) ───

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

function readResult(value) {
  return {
    payload: value,
    value: value,
    dataType: "Double",
    statusCode: "Good (0x00000000)",
    sourceTimestamp: new Date(),
    serverTimestamp: new Date(),
    operation: "read",
  };
}

describe("opcua-client session retry", function () {
  let mgr, RED, ctor;

  beforeEach(function () {
    mgr = {
      isConnected: true,
      reconnectAttempts: 0,
      connect: sinon.stub().callsFake(async function () {
        mgr.isConnected = true;
      }),
      read: sinon.stub(),
      readMultiple: sinon.stub(),
      write: sinon.stub(),
    };
    RED = createRED({ ep1: createMockEndpoint(mgr) });
    ctor = loadClientNode(RED);
  });

  it("should retry a read operation when session becomes invalid", async function () {
    mgr.read
      .onFirstCall()
      .rejects(new Error("Session is no longer valid"))
      .onSecondCall()
      .resolves({
        value: { value: 42, dataType: 6 },
        statusCode: {
          value: 0,
          name: "Good",
          toString: () => "Good (0x00000000)",
        },
        sourceTimestamp: new Date(),
        serverTimestamp: new Date(),
      });

    // After first failure, _ensureConnected sets isConnected = false
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 42, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c1", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=TestVar" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledTwice).to.be.true;
    expect(mgr.connect.calledOnce).to.be.true;
    expect(node.warn.called).to.be.true;
    expect(node.warn.firstCall.args[0]).to.include("reconnecting");
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
    expect(done.firstCall.args).to.have.lengthOf(0);
    expect(node.status.calledWith(sinon.match({ text: "reconnecting..." }))).to
      .be.true;
    expect(node.status.calledWith(sinon.match({ fill: "green" }))).to.be.true;
  });

  it('should retry when error is "Not connected"', async function () {
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Not connected");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 99, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c2", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledTwice).to.be.true;
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
  });

  it('should retry when error is "premature disconnection"', async function () {
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("premature disconnection 1");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 77, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c2b", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledTwice).to.be.true;
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
  });

  it('should retry when error is "Secure Channel Closed"', async function () {
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("The connection may have been rejected by server,\n Err = (Secure Channel Closed)");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 88, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c2c", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledTwice).to.be.true;
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
  });

  it("should fail after retry if reconnect also fails", async function () {
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.connect.rejects(new Error("Connection refused"));

    const node = {};
    ctor.call(node, { id: "c3", endpoint: "ep1", retryAttempts: 1 });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(node.error.calledOnce).to.be.true;
    expect(node.error.firstCall.args[0]).to.include("Connection refused");
    expect(send.calledOnce).to.be.true;
    expect(send.firstCall.args[0]).to.have.property("error");
    expect(done.calledOnce).to.be.true;
    expect(done.firstCall.args[0]).to.be.instanceOf(Error);
  });

  it("should fail after retry if second attempt also throws session error", async function () {
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.read.onSecondCall().rejects(new Error("Session is no longer valid"));

    const node = {};
    ctor.call(node, { id: "c4", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledTwice).to.be.true;
    expect(node.error.calledOnce).to.be.true;
    expect(node.status.calledWith(sinon.match({ fill: "red" }))).to.be.true;
    expect(done.firstCall.args[0]).to.be.instanceOf(Error);
  });

  it("should NOT retry on non-session errors", async function () {
    mgr.read.rejects(new Error("BadNodeIdUnknown"));

    const node = {};
    ctor.call(node, { id: "c5", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Invalid" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledOnce).to.be.true;
    expect(mgr.connect.notCalled).to.be.true;
    expect(node.error.calledOnce).to.be.true;
    expect(node.error.firstCall.args[0]).to.include("BadNodeIdUnknown");
  });

  it("should retry readmultiple when session is lost", async function () {
    mgr.readMultiple.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.readMultiple.onSecondCall().resolves([
      {
        value: 1,
        dataType: "Double",
        statusCode: "Good (0x00000000)",
        sourceTimestamp: new Date(),
        serverTimestamp: new Date(),
      },
      {
        value: 2,
        dataType: "Double",
        statusCode: "Good (0x00000000)",
        sourceTimestamp: new Date(),
        serverTimestamp: new Date(),
      },
    ]);

    const node = {};
    ctor.call(node, { id: "c6", endpoint: "ep1" });

    const msg = {
      operation: "readmultiple",
      items: [
        { nodeId: "ns=2;s=Var1" },
        { nodeId: "ns=2;s=Var2" },
      ],
    };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.readMultiple.calledTwice).to.be.true;
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
    expect(done.firstCall.args).to.have.lengthOf(0);
  });

  it("should retry write when session is lost", async function () {
    mgr.write.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.write.onSecondCall().resolves({
      value: 0,
      name: "Good",
      toString: () => "Good (0x00000000)",
    });

    const node = {};
    ctor.call(node, { id: "c7", endpoint: "ep1" });

    const msg = {
      operation: "write",
      topic: "ns=2;s=Var1",
      payload: 42,
      datatype: "Int32",
    };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.write.calledTwice).to.be.true;
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
  });

  it("should reset reconnectAttempts before reconnecting", async function () {
    mgr.reconnectAttempts = 10;
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 1, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c8", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.reconnectAttempts).to.equal(0);
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
  });

  it("should restore green status after successful retry", async function () {
    mgr.read.onFirstCall().callsFake(async () => {
      mgr.isConnected = false;
      throw new Error("Session is no longer valid");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 7, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c9", endpoint: "ep1" });

    await node._events["input"][0](
      { topic: "ns=2;s=Var" },
      sinon.stub(),
      sinon.stub(),
    );

    const statusCalls = node.status.args.map((a) => a[0]);
    const yellowIdx = statusCalls.findIndex(
      (s) => s.fill === "yellow" && s.text === "reconnecting...",
    );
    // Use findLastIndex: the constructor may set an initial green status,
    // but the retry should produce a green status *after* the yellow one.
    const greenIdx = statusCalls.findLastIndex(
      (s) => s.fill === "green" && s.text === "connected",
    );

    expect(yellowIdx).to.be.at.least(0);
    expect(greenIdx).to.be.at.least(0);
    expect(greenIdx).to.be.greaterThan(yellowIdx);
  });

  it("should succeed without retry when operation works first time", async function () {
    mgr.read.resolves({
      value: { value: 5, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c10", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    expect(mgr.read.calledOnce).to.be.true;
    expect(mgr.connect.notCalled).to.be.true;
    expect(node.warn.notCalled).to.be.true;
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
  });

  it("should force reconnect even if isConnected is still true (stale session)", async function () {
    // Simulates the case where isConnected is true but the session is
    // actually invalid (e.g. another node's reconnect set isConnected
    // back to true with a still-broken session).
    let callCount = 0;
    mgr.read.callsFake(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: session is stale, but isConnected is still true
        throw new Error("Session is no longer valid");
      }
      // Second call: after forceReconnect, session is fresh
      return {
        value: { value: 77, dataType: 6 },
        statusCode: {
          value: 0,
          name: "Good",
          toString: () => "Good (0x00000000)",
        },
        sourceTimestamp: new Date(),
        serverTimestamp: new Date(),
      };
    });

    const node = {};
    ctor.call(node, { id: "c11", endpoint: "ep1" });

    const msg = { topic: "ns=2;s=Var" };
    const send = sinon.stub();
    const done = sinon.stub();

    await node._events["input"][0](msg, send, done);

    // forceReconnect sets isConnected=false before calling connect(),
    // so connect() is always called regardless of prior state
    expect(mgr.connect.calledOnce).to.be.true;
    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
    expect(done.firstCall.args).to.have.lengthOf(0);
  });

  it("should force a full reconnect, not skip due to isConnected race", async function () {
    // Even if isConnected remains true (not reset by _ensureConnected
    // because the error came from a deeper layer), forceReconnect must
    // tear down and reconnect.
    mgr.read.onFirstCall().callsFake(async () => {
      // isConnected stays true — simulating a race where another async
      // path reconnected, but the session object is still stale.
      throw new Error("Session is no longer valid");
    });
    mgr.read.onSecondCall().resolves({
      value: { value: 42, dataType: 6 },
      statusCode: {
        value: 0,
        name: "Good",
        toString: () => "Good (0x00000000)",
      },
      sourceTimestamp: new Date(),
      serverTimestamp: new Date(),
    });

    const node = {};
    ctor.call(node, { id: "c12", endpoint: "ep1" });

    await node._events["input"][0](
      { topic: "ns=2;s=Var" },
      sinon.stub(),
      sinon.stub(),
    );

    // Key assertion: connect() must be called even though isConnected
    // was never set to false by the read mock.
    expect(mgr.connect.calledOnce).to.be.true;
  });
});

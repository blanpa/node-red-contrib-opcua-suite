"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const {
  OPCUAServer,
  Variant,
  DataType,
  MessageSecurityMode,
  SecurityPolicy,
} = require("node-opcua");

const OpcUaClientManager = require("../lib/opcua-client-manager");

// Use a random port to avoid conflicts with a running test-server.
const PORT = 48400 + Math.floor(Math.random() * 1000);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/IntegrationTest`;

// ─── Lightweight RED mock (same as opcua-nodes.test.js) ───

function createRED(nodeOverrides) {
  const types = {};
  return {
    nodes: {
      createNode(node, config) {
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
      registerType(name, ctor, opts) {
        types[name] = { constructor: ctor, opts };
      },
      getNode(id) {
        return nodeOverrides?.[id] || null;
      },
      _types: types,
    },
  };
}

describe("Integration: session retry with real OPC UA server", function () {
  this.timeout(60000);

  let server;

  before(async function () {
    server = new OPCUAServer({
      port: PORT,
      resourcePath: "/UA/IntegrationTest",
      maxAllowedSessionNumber: 50,
      securityModes: [MessageSecurityMode.None],
      securityPolicies: [SecurityPolicy.None],
      allowAnonymous: true,
    });

    await server.initialize();
    const addressSpace = server.engine.addressSpace;
    const ns = addressSpace.getOwnNamespace();

    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      browseName: "TestInt",
      nodeId: "s=TestInt",
      dataType: DataType.Int32,
      value: new Variant({ dataType: DataType.Int32, value: 42 }),
      writable: true,
    });

    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      browseName: "TestStr",
      nodeId: "s=TestStr",
      dataType: DataType.String,
      value: new Variant({ dataType: DataType.String, value: "hello" }),
    });

    await server.start();
  });

  after(async function () {
    if (server) {
      await server.shutdown();
    }
  });

  // ──────────────────────────────────────────────────────────
  // 1. Direct ClientManager test: read → kill session → read
  // ──────────────────────────────────────────────────────────

  it("ClientManager: read succeeds, session killed, re-read after reconnect succeeds", async function () {
    const mgr = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
    });

    await mgr.connect();
    expect(mgr.isConnected).to.be.true;

    // 1. Normal read
    const r1 = await mgr.read("ns=1;s=TestInt");
    expect(r1.value).to.equal(42);

    // 2. Kill the session server-side
    const sessionToClose = mgr.session;
    await sessionToClose.close();

    // 3. _ensureConnected should detect the dead session
    expect(() => mgr._ensureConnected()).to.throw(
      /Session is no longer valid|Not connected/,
    );
    expect(mgr.isConnected).to.be.false;

    // 4. Reconnect and read again
    await mgr.connect();
    expect(mgr.isConnected).to.be.true;

    const r2 = await mgr.read("ns=1;s=TestInt");
    expect(r2.value).to.equal(42);

    await mgr.disconnect();
  });

  // ──────────────────────────────────────────────────────────
  // 2. readMultiple: same pattern
  // ──────────────────────────────────────────────────────────

  it("ClientManager: readMultiple after session kill and reconnect", async function () {
    const mgr = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
    });

    await mgr.connect();

    const r1 = await mgr.readMultiple(["ns=1;s=TestInt", "ns=1;s=TestStr"]);
    expect(r1).to.have.lengthOf(2);
    expect(r1[0].value).to.equal(42);
    expect(r1[1].value).to.equal("hello");

    // Kill session
    await mgr.session.close();

    // Verify dead
    let threw = false;
    try {
      await mgr.readMultiple(["ns=1;s=TestInt"]);
    } catch (e) {
      threw = true;
      expect(e.message).to.match(/Session is no longer valid|Not connected/);
    }
    expect(threw).to.be.true;

    // Reconnect and retry
    await mgr.connect();
    const r2 = await mgr.readMultiple(["ns=1;s=TestInt", "ns=1;s=TestStr"]);
    expect(r2[0].value).to.equal(42);
    expect(r2[1].value).to.equal("hello");

    await mgr.disconnect();
  });

  // ──────────────────────────────────────────────────────────
  // 3. Full flow simulation: opcua-client node with retry
  // ──────────────────────────────────────────────────────────

  it("opcua-client node: retry transparently after session is killed", async function () {
    // Build a real ClientManager connected to the real server
    const mgr = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
    });
    await mgr.connect();

    // Create a mock endpoint config that returns the real manager
    const mockEndpoint = {
      getSharedManager: sinon.stub().returns(mgr),
      releaseSharedManager: sinon.stub().resolves(),
      registerStatusCallback: sinon.stub(),
      unregisterStatusCallback: sinon.stub(),
    };

    const RED = createRED({ ep1: mockEndpoint });
    const p = path.resolve(__dirname, "..", "nodes", "opcua-client.js");
    delete require.cache[require.resolve(p)];
    require(p)(RED);
    const ctor = RED.nodes._types["opcua-client"].constructor;

    const node = {};
    ctor.call(node, { id: "test-node", endpoint: "ep1" });

    const inputHandler = node._events["input"][0];

    // 1. Normal read through the node – should work
    {
      const msg = { topic: "ns=1;s=TestInt" };
      const send = sinon.stub();
      const done = sinon.stub();
      await inputHandler(msg, send, done);

      expect(send.calledOnce).to.be.true;
      expect(done.calledOnce).to.be.true;
      expect(send.firstCall.args[0].payload).to.equal(42);
      expect(node.error.called).to.be.false;
    }

    // 2. Kill the session server-side (simulates network drop / server restart)
    await mgr.session.close();

    // 3. Send another read – the retry logic should reconnect and succeed
    {
      const msg = { topic: "ns=1;s=TestInt" };
      const send = sinon.stub();
      const done = sinon.stub();
      await inputHandler(msg, send, done);

      expect(send.calledOnce, "send should be called once after retry").to.be
        .true;
      expect(
        done.calledOnce,
        "done should be called once (no error) after retry",
      ).to.be.true;
      expect(send.firstCall.args[0].payload).to.equal(42);
      expect(node.error.called).to.be.false;

      // Verify the warn was triggered
      expect(node.warn.called).to.be.true;
      expect(node.warn.firstCall.args[0]).to.include("reconnecting");

      // Verify status went yellow then green
      const statusCalls = node.status.args.map((a) => a[0]);
      const yellowIdx = statusCalls.findIndex(
        (s) => s.fill === "yellow" && s.text === "reconnecting...",
      );
      const greenIdx = statusCalls.findLastIndex(
        (s) => s.fill === "green" && s.text === "connected",
      );
      expect(yellowIdx).to.be.at.least(0);
      expect(greenIdx).to.be.greaterThan(yellowIdx);
    }

    // 4. Subsequent reads should work without retry
    node.warn.resetHistory();
    {
      const msg = { topic: "ns=1;s=TestStr" };
      const send = sinon.stub();
      const done = sinon.stub();
      await inputHandler(msg, send, done);

      expect(send.calledOnce).to.be.true;
      expect(send.firstCall.args[0].payload).to.equal("hello");
      expect(node.warn.called).to.be.false;
    }

    await mgr.disconnect();
  });

  // ──────────────────────────────────────────────────────────
  // 4. readMultiple through the node
  // ──────────────────────────────────────────────────────────

  it("opcua-client node: readmultiple retries after session kill", async function () {
    const mgr = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
    });
    await mgr.connect();

    const mockEndpoint = {
      getSharedManager: sinon.stub().returns(mgr),
      releaseSharedManager: sinon.stub().resolves(),
      registerStatusCallback: sinon.stub(),
      unregisterStatusCallback: sinon.stub(),
    };

    const RED = createRED({ ep1: mockEndpoint });
    const p = path.resolve(__dirname, "..", "nodes", "opcua-client.js");
    delete require.cache[require.resolve(p)];
    require(p)(RED);
    const ctor = RED.nodes._types["opcua-client"].constructor;
    const node = {};
    ctor.call(node, { id: "test-multi", endpoint: "ep1" });
    const inputHandler = node._events["input"][0];

    // Kill session before the first read
    await mgr.session.close();

    const msg = {
      operation: "readmultiple",
      items: [{ nodeId: "ns=1;s=TestInt" }, { nodeId: "ns=1;s=TestStr" }],
    };
    const send = sinon.stub();
    const done = sinon.stub();
    await inputHandler(msg, send, done);

    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
    expect(node.error.called).to.be.false;
    expect(node.warn.called).to.be.true;

    const payload = send.firstCall.args[0].payload;
    expect(payload).to.be.an("array").with.lengthOf(2);
    expect(payload[0].value).to.equal(42);
    expect(payload[1].value).to.equal("hello");

    await mgr.disconnect();
  });

  // ──────────────────────────────────────────────────────────
  // 5. Write through the node after session kill
  // ──────────────────────────────────────────────────────────

  it("opcua-client node: write retries after session kill", async function () {
    const mgr = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
    });
    await mgr.connect();

    const mockEndpoint = {
      getSharedManager: sinon.stub().returns(mgr),
      releaseSharedManager: sinon.stub().resolves(),
      registerStatusCallback: sinon.stub(),
      unregisterStatusCallback: sinon.stub(),
    };

    const RED = createRED({ ep1: mockEndpoint });
    const p = path.resolve(__dirname, "..", "nodes", "opcua-client.js");
    delete require.cache[require.resolve(p)];
    require(p)(RED);
    const ctor = RED.nodes._types["opcua-client"].constructor;
    const node = {};
    ctor.call(node, { id: "test-write", endpoint: "ep1" });
    const inputHandler = node._events["input"][0];

    // Kill session
    await mgr.session.close();

    // Write should retry and succeed
    const msg = {
      operation: "write",
      topic: "ns=1;s=TestInt",
      payload: 99,
      datatype: "Int32",
    };
    const send = sinon.stub();
    const done = sinon.stub();
    await inputHandler(msg, send, done);

    expect(send.calledOnce).to.be.true;
    expect(done.calledOnce).to.be.true;
    expect(node.error.called).to.be.false;
    expect(node.warn.called).to.be.true;

    // Verify the write actually worked by reading back
    const r = await mgr.read("ns=1;s=TestInt");
    expect(r.value).to.equal(99);

    // Reset the value for other tests
    await mgr.write("ns=1;s=TestInt", 42, "Int32");

    await mgr.disconnect();
  });
});

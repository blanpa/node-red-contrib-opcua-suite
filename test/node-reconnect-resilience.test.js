"use strict";

/**
 * Regression tests for the reconnect handling that issue #15 fixed in
 * opcua-client but which was missing in the Browse Client and Event nodes:
 * after the manager replaces the session, any ClientSubscription/MonitoredItem
 * created on the old one is dead and reusing it throws "expecting a valid
 * session" — the node then silently stops delivering data.
 *
 * Also covers the editor-side browse-connection single-flight (issue #17).
 */

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

const OpcUaClientManager = require("../lib/opcua-client-manager");

// ── Minimal Node-RED double ──────────────────────────────────────────────────
function createRED(endpointNodes) {
  const routes = {};
  const types = {};
  return {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = (event, cb) => {
          (node._events[event] = node._events[event] || []).push(cb);
        };
        node.send = sinon.stub();
        node.status = sinon.stub();
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
      },
      registerType(name, ctor, opts) {
        types[name] = { constructor: ctor, opts };
      },
      getNode: (id) => endpointNodes?.[id] || null,
      _types: types,
    },
    httpAdmin: {
      post(routePath, ...fns) { routes[routePath] = fns[fns.length - 1]; },
      get(routePath, ...fns) { routes[routePath] = fns[fns.length - 1]; },
    },
    events: { on() {} },
    _routes: routes,
  };
}

/**
 * Endpoint config-node double that hands out one shared manager stub and
 * exposes the registered status callbacks so a test can fire lifecycle events.
 */
function createEndpoint(manager) {
  const callbacks = new Set();
  return {
    id: "ep1",
    endpointUrl: "opc.tcp://plc:4840",
    securityMode: "None",
    securityPolicy: "None",
    getCertificateData: () => ({}),
    getSharedManager: () => manager,
    registerStatusCallback: (cb) => callbacks.add(cb),
    unregisterStatusCallback: (cb) => callbacks.delete(cb),
    releaseSharedManager: async () => {},
    _fire(event, payload) {
      for (const cb of callbacks) cb(event, payload);
    },
  };
}

function loadNode(file, RED) {
  const p = path.resolve(__dirname, "..", "nodes", file);
  delete require.cache[require.resolve(p)];
  require(p)(RED);
  return RED.nodes._types;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("opcua-browse-client — session_recreated (issue #15 parity)", function () {
  let manager, endpoint, node, createSubscription, monitoredItems;

  beforeEach(function () {
    monitoredItems = [];
    createSubscription = sinon.stub().callsFake(async () => ({
      terminate: sinon.stub().resolves(),
      _id: createSubscription.callCount,
    }));

    manager = {
      isConnected: false,
      connect: sinon.stub().resolves(),
      createSubscription,
      readMultiple: sinon.stub().resolves([]),
      _isConnectionLostError: () => false,
      _toOpcUaNodeId: (n) => n,
    };
    endpoint = createEndpoint(manager);

    const RED = createRED({ ep1: endpoint });
    const types = loadNode("opcua-browse-client.js", RED);
    node = {};
    types["opcua-browse-client"].constructor.call(node, {
      endpoint: "ep1",
      mode: "subscribe",
      publishInterval: 1000,
      selectedItems: [
        { nodeId: "ns=2;s=A", nodeClass: "Variable", browseName: "A" },
      ],
    });

    // Capture created monitored items via the node-opcua ClientMonitoredItem
    const nodeOpcua = require("node-opcua");
    sinon.stub(nodeOpcua.ClientMonitoredItem, "create").callsFake(() => {
      const mi = { on: sinon.stub(), terminate: sinon.stub().resolves() };
      monitoredItems.push(mi);
      return mi;
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("connects proactively in subscribe mode instead of waiting for a message", function () {
    // Without this the node sat at "not connected" forever in a flow whose
    // only OPC UA node is a subscribe-mode Browse Client.
    expect(manager.connect.called).to.equal(true);
  });

  it("rebuilds the subscription on a fresh session", async function () {
    manager.isConnected = true;
    endpoint._fire("connected");
    await new Promise((r) => setImmediate(r));
    expect(createSubscription.callCount).to.equal(1);

    // Server replaced the session (e.g. S7 60s session timeout).
    endpoint._fire("session_recreated");
    await new Promise((r) => setImmediate(r));

    expect(createSubscription.callCount).to.equal(2);
    expect(monitoredItems).to.have.length(2);
  });

  it("does not reuse the stale subscription after a plain reconnect", async function () {
    manager.isConnected = true;
    endpoint._fire("connected");
    await new Promise((r) => setImmediate(r));

    // A "connected" event alone must not create a second subscription while
    // the first one is still valid.
    endpoint._fire("connected");
    await new Promise((r) => setImmediate(r));
    expect(createSubscription.callCount).to.equal(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("opcua-event — session_recreated replay", function () {
  let manager, endpoint, node, createSubscription;

  beforeEach(function () {
    createSubscription = sinon.stub().callsFake(async () => ({
      terminate: sinon.stub().resolves(),
    }));
    manager = {
      isConnected: true,
      connect: sinon.stub().resolves(),
      createSubscription,
      _isConnectionLostError: () => false,
      _toOpcUaNodeId: (n) => n,
    };
    endpoint = createEndpoint(manager);

    const nodeOpcua = require("node-opcua");
    sinon.stub(nodeOpcua.ClientMonitoredItem, "create").callsFake(() => ({
      on: sinon.stub(),
      terminate: sinon.stub().resolves(),
    }));

    const RED = createRED({ ep1: endpoint });
    const types = loadNode("opcua-event.js", RED);
    node = {};
    types["opcua-event"].constructor.call(node, {
      endpoint: "ep1",
      sourceNodeId: "i=2253",
      eventType: "BaseEventType",
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("replays the remembered subscription after the session is replaced", async function () {
    const handler = node._events.input[0];
    await new Promise((resolve) =>
      handler({ action: "subscribe" }, () => {}, () => resolve()),
    );
    expect(createSubscription.callCount).to.equal(1);

    endpoint._fire("session_recreated");
    await new Promise((r) => setTimeout(r, 20));

    expect(createSubscription.callCount).to.equal(2);
  });

  it("stops replaying after an explicit unsubscribe", async function () {
    const handler = node._events.input[0];
    await new Promise((resolve) =>
      handler({ action: "subscribe" }, () => {}, () => resolve()),
    );
    await new Promise((resolve) =>
      handler({ action: "unsubscribe" }, () => {}, () => resolve()),
    );

    const before = createSubscription.callCount;
    endpoint._fire("session_recreated");
    await new Promise((r) => setTimeout(r, 20));

    expect(createSubscription.callCount).to.equal(before);
  });

  it("translates a non-default event type into an OfType where-clause", async function () {
    const nodeOpcua = require("node-opcua");
    const createStub = nodeOpcua.ClientMonitoredItem.create;
    const handler = node._events.input[0];

    await new Promise((resolve) =>
      handler({ action: "subscribe" }, () => {}, () => resolve()),
    );
    const baseFilter = createStub.lastCall.args[2].filter;
    // BaseEventType is the root of the hierarchy — filtering on it is a no-op.
    expect(baseFilter.whereClause?.elements ?? []).to.have.length(0);

    await new Promise((resolve) =>
      handler({ action: "subscribe", eventType: "SystemEventType" }, () => {}, () => resolve()),
    );
    // The configured event type used to be read and then discarded entirely,
    // so every event type was delivered regardless of the setting.
    const typedFilter = createStub.lastCall.args[2].filter;
    expect(typedFilter.whereClause.elements).to.have.length.greaterThan(0);
  });

  it("reports an unknown event type instead of silently ignoring it", async function () {
    const handler = node._events.input[0];
    let doneErr = null;
    await new Promise((resolve) =>
      handler({ action: "subscribe", eventType: "NoSuchEventType" }, () => {}, (err) => {
        doneErr = err;
        resolve();
      }),
    );
    expect(doneErr).to.be.an("error");
    expect(doneErr.message).to.include("NoSuchEventType");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("opcua-browse-client editor connection — single-flight (issue #17)", function () {
  let sandbox, RED, browseRoute, disconnectRoute, connectStub, disconnectStub;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    connectStub = sandbox
      .stub(OpcUaClientManager.prototype, "connect")
      .callsFake(async function () {
        await new Promise((r) => setTimeout(r, 20));
        this.isConnected = true;
      });
    disconnectStub = sandbox
      .stub(OpcUaClientManager.prototype, "disconnect")
      .callsFake(async function () {
        this.isConnected = false;
      });
    sandbox.stub(OpcUaClientManager.prototype, "getSession").callsFake(() => ({
      browse: sinon.stub().resolves({
        references: [],
        continuationPoint: null,
        statusCode: { isNotGood: () => false, toString: () => "Good" },
      }),
      browseNext: sinon.stub(),
      read: sinon.stub().resolves([]),
    }));

    RED = createRED({
      ep1: {
        id: "ep1",
        endpointUrl: "opc.tcp://plc:4840",
        securityMode: "None",
        securityPolicy: "None",
      },
    });
    loadNode("opcua-browse-client.js", RED);
    browseRoute = RED._routes["/opcua-browse-client/browse"];
    disconnectRoute = RED._routes["/opcua-browse-client/disconnect"];
  });

  afterEach(async function () {
    await disconnectRoute({ body: { endpointId: "ep1" } }, makeRes());
    sandbox.restore();
  });

  function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    return res;
  }

  it("parallel editor expands build exactly ONE browse connection", async function () {
    // The tree fires several expand requests at once; each used to construct
    // its own manager and overwrite the cache entry, orphaning the rest.
    await Promise.all([
      browseRoute({ body: { endpointId: "ep1", nodeId: "i=85" } }, makeRes()),
      browseRoute({ body: { endpointId: "ep1", nodeId: "i=86" } }, makeRes()),
      browseRoute({ body: { endpointId: "ep1", nodeId: "i=87" } }, makeRes()),
      browseRoute({ body: { endpointId: "ep1", nodeId: "i=88" } }, makeRes()),
    ]);

    expect(connectStub.callCount).to.equal(1);
  });

  it("a failed connect is not cached and does not leak a manager", async function () {
    connectStub.restore();
    let disconnects = 0;
    sandbox.stub(OpcUaClientManager.prototype, "connect").rejects(new Error("ECONNREFUSED"));
    disconnectStub.restore();
    sandbox.stub(OpcUaClientManager.prototype, "disconnect").callsFake(async function () {
      disconnects++;
      this.isConnected = false;
    });

    const res = makeRes();
    await browseRoute({ body: { endpointId: "ep1", nodeId: "i=85" } }, res);

    expect(res.statusCode).to.equal(500);
    expect(disconnects).to.be.greaterThan(0);
  });
});

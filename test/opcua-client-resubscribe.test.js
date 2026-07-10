"use strict";

/**
 * Regression test for issue #15 — subscribing to a variable disconnects
 * after ~1 minute with "expecting a valid session" on reconnect.
 *
 * Root cause: on a server-side session timeout (e.g. a Siemens S7-1200's
 * ~60s default), OpcUaClientManager reconnects and creates a NEW session,
 * but the node-local `subscription` kept pointing at the dead one. Data
 * silently stopped and a later "subscribe" crashed reusing the stale handle.
 *
 * Fix: the manager emits "session_recreated" whenever it replaces the
 * session; the client node discards the dead subscription/monitored items
 * and transparently replays every remembered subscribe request on the fresh
 * session. See the changes in lib/opcua-client-manager.js + nodes/opcua-client.js.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const nodeOpcua = require("node-opcua");

// Lightweight RED mock (same pattern as opcua-client-operation.test.js), plus
// a node.send stub because reconnect replays go through node.send (there is no
// per-message send outside the input handler).
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
        node.send = sinon.stub();
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

// Endpoint mock that records the client's status callback so the test can
// drive lifecycle events ("disconnected", "session_recreated", ...).
function createMockEndpoint(mockMgr) {
  const cbs = new Set();
  return {
    getSharedManager: sinon.stub().returns(mockMgr),
    releaseSharedManager: sinon.stub().resolves(),
    registerStatusCallback: (cb) => cbs.add(cb),
    unregisterStatusCallback: (cb) => cbs.delete(cb),
    fire: (event, err) => cbs.forEach((cb) => cb(event, err)),
  };
}

// Records every ClientMonitoredItem.create call and returns a minimal stub
// object supporting .on("changed") and .terminate().
function installMonitoredItemStub() {
  const created = [];
  nodeOpcua.ClientMonitoredItem.create = function (
    subscription,
    itemToMonitor,
    options,
  ) {
    const item = {
      subscription,
      itemToMonitor,
      options,
      _changed: null,
      on(ev, cb) {
        if (ev === "changed") this._changed = cb;
      },
      terminate: sinon.stub().resolves(),
    };
    created.push(item);
    return item;
  };
  return created;
}

function loadClientNode(RED) {
  const p = path.resolve(__dirname, "..", "nodes", "opcua-client.js");
  delete require.cache[require.resolve(p)];
  require(p)(RED);
  return RED.nodes._types["opcua-client"].constructor;
}

describe("opcua-client re-subscribe after session recreation (issue #15)", function () {
  let mgr, RED, endpoint, ctor, created;
  const origCreate = nodeOpcua.ClientMonitoredItem.create;

  beforeEach(function () {
    let subIdCounter = 0;
    mgr = {
      isConnected: true,
      connect: sinon.stub().resolves(),
      _isConnectionLostError: () => false,
      _toOpcUaNodeId: (nid) => nid,
      createSubscription: sinon.stub().callsFake(async () => ({
        subscriptionId: ++subIdCounter,
      })),
    };
    created = installMonitoredItemStub();
    endpoint = createMockEndpoint(mgr);
    RED = createRED({ ep1: endpoint });
    ctor = loadClientNode(RED);
  });

  afterEach(function () {
    nodeOpcua.ClientMonitoredItem.create = origCreate;
  });

  function makeNode(config) {
    const node = {};
    ctor.call(node, Object.assign({ id: "c1", endpoint: "ep1" }, config));
    return node;
  }

  async function subscribe(node, nodeId) {
    const send = sinon.stub();
    const done = sinon.stub();
    await node._events["input"][0](
      { topic: nodeId, operation: "subscribe" },
      send,
      done,
    );
    return { send, done };
  }

  // Wait a tick so the async resubscribeAll() kicked off from the (sync)
  // status callback has a chance to run.
  const flush = () => new Promise((r) => setImmediate(r));

  it("replays subscriptions on a fresh subscription after session_recreated", async function () {
    const node = makeNode({});
    await subscribe(node, "ns=2;s=Var1");
    await subscribe(node, "ns=2;s=Var2");

    expect(mgr.createSubscription.callCount).to.equal(1); // one shared subscription
    expect(created.length).to.equal(2);
    const firstSub = created[0].subscription;

    // Simulate the server-side session timeout + reconnect.
    endpoint.fire("disconnected");
    endpoint.fire("session_recreated");
    await flush();

    // A brand-new subscription was created and both topics were re-monitored
    // on it — none reuse the dead subscription object.
    expect(mgr.createSubscription.callCount).to.equal(2);
    expect(created.length).to.equal(4);
    const rebuiltSub = created[2].subscription;
    expect(rebuiltSub).to.not.equal(firstSub);
    expect(created[3].subscription).to.equal(rebuiltSub);
  });

  it("does not re-subscribe a topic that was unsubscribed before the drop", async function () {
    const node = makeNode({});
    await subscribe(node, "ns=2;s=Keep");
    await subscribe(node, "ns=2;s=Drop");

    // Unsubscribe one topic.
    const send = sinon.stub();
    const done = sinon.stub();
    await node._events["input"][0](
      { topic: "ns=2;s=Drop", operation: "unsubscribe" },
      send,
      done,
    );

    endpoint.fire("session_recreated");
    await flush();

    // Only the kept topic is replayed (2 original monitored items + 1 replay).
    expect(created.length).to.equal(3);
    // _toOpcUaNodeId passthrough returns the parsed nodeId; the String
    // identifier "Keep" confirms the replayed item is the kept topic, not Drop.
    expect(created[2].itemToMonitor.nodeId.value).to.equal("Keep");
  });

  it("clears the stale subscription on disconnect so a later subscribe is safe", async function () {
    const node = makeNode({});
    await subscribe(node, "ns=2;s=Var1");
    const firstSub = created[0].subscription;

    endpoint.fire("disconnected"); // subscription nulled, monitorItems cleared

    // A subscribe arriving during the outage must build a fresh subscription,
    // not reuse the dead one (which would throw "expecting a valid session").
    await subscribe(node, "ns=2;s=Var1");
    expect(mgr.createSubscription.callCount).to.equal(2);
    expect(created[1].subscription).to.not.equal(firstSub);
  });
});
